import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { AgentTaskStatus } from "@generic-ai/plugin-delegation";
import {
  AUTH_SCOPES,
  type AuthContext,
  hasAuthScope,
  type SecretDescriptor,
  toRunActor,
} from "@generic-ai/sdk";

import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { type CompanyGoalTemplate, companyGoal } from "./company.js";
import { DriveError, type DriveFile } from "./drive.js";
import type { CompanyEvent } from "./events.js";
import {
  type MemoryEdit,
  MemoryError,
  parseMemoryScope,
  REFINEMENT_KIND_NAMES,
} from "./memory.js";
import { type CompanyModelAuth, ModelAuthError } from "./model-auth.js";
import { BOARD_COLUMNS, type CompanyRuntime, summarizeTask } from "./runtime.js";
import type { CompanySecretReference, CompanyToolkitDescription } from "./toolkit.js";

/**
 * The Generic Corp HTTP API (roadmap R13). JSON over Hono, mounted at
 * `/api`, plus `/api/events` for live server-sent events.
 *
 * Every route needs an authenticated owner: reads need `runs:read`, anything
 * that starts or stops work needs `runs:execute`.
 */
export type CompanyApiAuthenticate = (
  request: Request,
) => Promise<AuthContext | Response> | AuthContext | Response;

export interface CompanyApiOptions {
  readonly authenticate: CompanyApiAuthenticate;
  /** Largest JSON body accepted. Defaults to 256 KiB. */
  readonly maxBodyBytes?: number;
  /** Largest file the owner can upload to the drive. Defaults to 100 MiB. */
  readonly maxUploadBytes?: number;
  /** SSE keep-alive interval. Defaults to 15 seconds. */
  readonly keepAliveMs?: number;
  /** The agents' toolkit, listed at `/api/tools`. */
  readonly toolkit?: { describe(): CompanyToolkitDescription };
  /** The secrets vault, managed at `/api/secrets`. Values are never returned. */
  readonly secrets?: CompanySecretsAdmin;
  /** What powers the agents (Claude sign-in or API key), managed at `/api/model-auth`. */
  readonly modelAuth?: CompanyModelAuth;
}

/** What the secrets screen needs from the vault. */
export interface CompanySecretsAdmin {
  /** Whether `set` and `delete` work (an encrypted store is configured). */
  readonly writable: boolean;
  /** Secrets the company config refers to. */
  readonly references: readonly CompanySecretReference[];
  list(): Promise<readonly SecretDescriptor[]>;
  set(name: string, value: string, options?: { readonly updatedBy?: string }): Promise<void>;
  delete(name: string): Promise<boolean>;
}

/** One row of the secrets screen. */
export interface CompanySecretView {
  readonly name: string;
  readonly set: boolean;
  /** `env`, `file` or `encrypted-store`, when set. */
  readonly source?: string;
  readonly updatedAt?: string;
  readonly updatedBy?: string;
  readonly usedBy: readonly string[];
  readonly optional?: boolean;
}

export const API_ROUTE_PREFIX = "/api" as const;

type ApiEnv = { Variables: { auth: AuthContext } };

const TASK_STATUSES: ReadonlySet<string> = new Set(BOARD_COLUMNS);
const MAX_MESSAGE_CHARS = 32_000;
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_SECRET_CHARS = 16_384;
const MAX_ATTACHMENTS = 20;
export const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** Routes whose body is a file, limited by `maxUploadBytes` instead of `maxBodyBytes`. */
const UPLOAD_ROUTES: ReadonlySet<string> = new Set(["/drive/file", "/drive/inbox"]);

/** Types shown in the browser for a preview; anything else downloads. */
const INLINE_TYPES =
  /^(text\/(plain|markdown|csv|tab-separated-values|css|javascript)|application\/(json|yaml|xml|pdf)|image\/(png|jpeg|gif|webp)|audio\/|video\/)/;

function driveStatus(error: DriveError): 400 | 403 | 404 | 409 {
  switch (error.code) {
    case "outside":
      return 403;
    case "not_found":
      return 404;
    case "exists":
    case "not_empty":
      return 409;
    default:
      return 400;
  }
}

function contentDisposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function fileResponse(file: DriveFile, download: boolean): Response {
  const type = file.entry.mimeType ?? "application/octet-stream";
  // HTML and SVG could run scripts on the app's origin, so they preview as plain text.
  const previewType = type === "text/html" || type === "image/svg+xml" ? "text/plain" : type;
  const inline = !download && INLINE_TYPES.test(previewType);
  const body = Readable.toWeb(createReadStream(file.absolutePath)) as ReadableStream<Uint8Array>;
  return new Response(body, {
    headers: {
      "content-type":
        inline && previewType.startsWith("text/")
          ? `${previewType}; charset=utf-8`
          : inline
            ? previewType
            : "application/octet-stream",
      "content-length": String(file.entry.size ?? 0),
      "content-disposition": contentDisposition(inline ? "inline" : "attachment", file.entry.name),
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'",
      "cache-control": "no-store",
    },
  });
}

function readAttachments(body: Record<string, unknown>): string[] | undefined {
  const raw = body["attachments"];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
    throw new ApiError(400, "attachments must be a list of drive paths.");
  }
  if (raw.length > MAX_ATTACHMENTS) {
    throw new ApiError(413, `Attach at most ${MAX_ATTACHMENTS} files to a message.`);
  }
  return raw as string[];
}

async function secretViews(admin: CompanySecretsAdmin): Promise<CompanySecretView[]> {
  const stored = new Map((await admin.list()).map((entry) => [entry.name, entry]));
  const views = new Map<string, CompanySecretView>();
  for (const reference of admin.references) {
    const entry = stored.get(reference.name);
    views.set(reference.name, {
      name: reference.name,
      set: entry !== undefined,
      ...(entry === undefined ? {} : secretMetadata(entry)),
      usedBy: reference.usedBy,
      ...(reference.optional === true ? { optional: true } : {}),
    });
  }
  for (const entry of stored.values()) {
    if (!views.has(entry.name)) {
      views.set(entry.name, { name: entry.name, set: true, ...secretMetadata(entry), usedBy: [] });
    }
  }
  return [...views.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function secretMetadata(entry: SecretDescriptor) {
  return {
    source: entry.source,
    ...(entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt }),
    ...(entry.updatedBy === undefined ? {} : { updatedBy: entry.updatedBy }),
  };
}

class ApiError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 413,
    message: string,
  ) {
    super(message);
  }
}

function errorResponse(c: Context, status: number, message: string) {
  return c.json({ error: message }, status as 400);
}

const MAX_MEMORY_EDITS = 50;

function readMemoryEdits(raw: unknown): MemoryEdit[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MEMORY_EDITS) {
    throw new ApiError(400, `Send edits as a list of 1 to ${MAX_MEMORY_EDITS} changes.`);
  }
  return raw.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ApiError(400, "Each edit must be an object.");
    }
    const edit = value as Record<string, unknown>;
    const action = edit["action"];
    const kind = edit["kind"] ?? "memory";
    if (action !== "create" && action !== "update" && action !== "delete") {
      throw new ApiError(400, "Each edit needs an action: create, update or delete.");
    }
    if (typeof kind !== "string" || !REFINEMENT_KIND_NAMES.includes(kind)) {
      throw new ApiError(400, `kind must be one of ${REFINEMENT_KIND_NAMES.join(", ")}.`);
    }
    const text = (key: string) => {
      const field = edit[key];
      if (field === undefined) {
        return undefined;
      }
      if (typeof field !== "string") {
        throw new ApiError(400, `${key} must be text.`);
      }
      return field;
    };
    const record = (key: string) => {
      const field = edit[key];
      if (field === undefined) {
        return undefined;
      }
      if (typeof field !== "object" || field === null || Array.isArray(field)) {
        throw new ApiError(400, `${key} must be an object.`);
      }
      return field as Record<string, unknown>;
    };
    const id = text("id");
    const title = text("title");
    const content = text("content");
    const path = text("path");
    const reference = record("reference");
    const args = record("arguments");
    return {
      action,
      kind: kind as MemoryEdit["kind"],
      ...(id === undefined ? {} : { id }),
      ...(title === undefined ? {} : { title }),
      ...(content === undefined ? {} : { content }),
      ...(path === undefined ? {} : { path }),
      ...(reference === undefined ? {} : { reference }),
      ...(args === undefined ? {} : { arguments: args }),
    } as MemoryEdit;
  });
}

function ownerId(c: Context<ApiEnv>): { id?: string } {
  return { id: toRunActor(c.get("auth")).subjectId };
}

async function readJsonObject(c: Context): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    const text = await c.req.text();
    parsed = text.trim().length === 0 ? {} : JSON.parse(text);
  } catch {
    throw new ApiError(400, "The request body is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(400, "The request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function readMessageText(body: Record<string, unknown>, fallback?: string): string {
  const text = body["text"] ?? fallback;
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new ApiError(400, 'Send the message as {"text": "..."}.');
  }
  if (text.length > MAX_MESSAGE_CHARS) {
    throw new ApiError(413, `Messages are limited to ${MAX_MESSAGE_CHARS} characters.`);
  }
  return text;
}

/** The company goal a message starts from (`{"goalId": "..."}`), if it names one. */
function readGoalTemplate(
  runtime: CompanyRuntime,
  body: Record<string, unknown>,
): CompanyGoalTemplate | undefined {
  const goalId = body["goalId"];
  if (goalId === undefined || goalId === null) {
    return undefined;
  }
  if (typeof goalId !== "string") {
    throw new ApiError(400, "goalId must be the id of one of the company's goals.");
  }
  const goal = companyGoal(runtime.company, goalId);
  if (goal === undefined) {
    throw new ApiError(404, `The company has no goal "${goalId}". See GET /api/goals.`);
  }
  return goal;
}

/** A company goal for the dashboard: what it asks, what done means, and how it is checked. */
export function describeCompanyGoal(goal: CompanyGoalTemplate) {
  return {
    id: goal.id,
    title: goal.title,
    ...(goal.description === undefined ? {} : { description: goal.description }),
    request: goal.request,
    objective: goal.spec.objective,
    definitionOfDone: goal.spec.definitionOfDone,
    checks: goal.spec.validators.map((validator) => ({
      id: validator.id,
      kind: validator.kind,
      ...(validator.description === undefined ? {} : { description: validator.description }),
    })),
  };
}

function readLimit(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new ApiError(400, "limit must be a positive integer.");
  }
  return Math.min(value, max);
}

function readStatuses(raw: string | undefined): AgentTaskStatus[] | undefined {
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  const statuses = raw.split(",").map((value) => value.trim());
  for (const status of statuses) {
    if (!TASK_STATUSES.has(status)) {
      throw new ApiError(400, `Unknown task status "${status}".`);
    }
  }
  return statuses as AgentTaskStatus[];
}

function sseFrame(event: CompanyEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify({ at: event.at, ...event.data })}\n\n`;
}

export function createCompanyApi(
  runtime: CompanyRuntime,
  options: CompanyApiOptions,
): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const keepAliveMs = options.keepAliveMs ?? 15_000;

  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return errorResponse(c, error.status, error.message);
    }
    if (error instanceof DriveError) {
      return errorResponse(c, driveStatus(error), error.message);
    }
    if (error instanceof MemoryError) {
      return errorResponse(c, error.status, error.message);
    }
    if (error instanceof RangeError) {
      return errorResponse(c, 404, error.message);
    }
    return errorResponse(c, 500, "Something went wrong. Check the server log.");
  });

  const jsonLimit = bodyLimit({
    maxSize: options.maxBodyBytes ?? 256 * 1024,
    onError: (c) => errorResponse(c, 413, "The request body is too large."),
  });
  const maxUploadBytes = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  const uploadLimit = bodyLimit({
    maxSize: maxUploadBytes,
    onError: (c) =>
      errorResponse(
        c,
        413,
        `Files are limited to ${Math.floor(maxUploadBytes / (1024 * 1024))} MB.`,
      ),
  });
  const isUpload = (requestPath: string) =>
    [...UPLOAD_ROUTES].some((route) => requestPath.endsWith(route));
  app.use("*", (c, next) => (isUpload(c.req.path) ? uploadLimit : jsonLimit)(c, next));

  app.use("*", async (c, next) => {
    const result = await options.authenticate(c.req.raw);
    if (result instanceof Response) {
      return result;
    }
    const method = c.req.method.toUpperCase();
    const scope =
      method === "GET" || method === "HEAD" ? AUTH_SCOPES.runsRead : AUTH_SCOPES.runsExecute;
    if (!hasAuthScope(result, scope)) {
      return errorResponse(c, 403, `This credential lacks the "${scope}" scope.`);
    }
    c.set("auth", result);
    await next();
    c.header("cache-control", "no-store");
    return undefined;
  });

  app.get("/company", (c) =>
    c.json({
      name: runtime.company.name,
      ...(runtime.company.mission === undefined ? {} : { mission: runtime.company.mission }),
      ceoId: runtime.ceoId,
      storage: runtime.storage.driver,
    }),
  );

  app.get("/tools", (c) =>
    c.json(
      options.toolkit?.describe() ?? { tools: [], webSearch: null, connectors: [], skills: [] },
    ),
  );

  // --- Goals the company knows how to pursue ------------------------------

  app.get("/goals", (c) =>
    c.json({
      template: runtime.company.template ?? null,
      goals: (runtime.company.goals ?? []).map(describeCompanyGoal),
    }),
  );

  // --- Secrets -------------------------------------------------------------

  const requireSecrets = (): CompanySecretsAdmin => {
    if (options.secrets === undefined) {
      throw new ApiError(404, "The secrets vault is not available.");
    }
    return options.secrets;
  };

  const requireManage = (c: Context<ApiEnv>): void => {
    if (!hasAuthScope(c.get("auth"), AUTH_SCOPES.tokensManage)) {
      throw new ApiError(403, `This credential lacks the "${AUTH_SCOPES.tokensManage}" scope.`);
    }
  };

  const readSecretName = (c: Context<ApiEnv>): string => {
    const name = c.req.param("name") ?? "";
    if (!SECRET_NAME.test(name)) {
      throw new ApiError(
        400,
        "Secret names are letters, digits and underscores, like CRM_API_KEY.",
      );
    }
    return name;
  };

  app.get("/secrets", async (c) => {
    const admin = requireSecrets();
    return c.json({ writable: admin.writable, secrets: await secretViews(admin) });
  });

  app.put("/secrets/:name", async (c) => {
    const admin = requireSecrets();
    requireManage(c);
    const name = readSecretName(c);
    const value = (await readJsonObject(c))["value"];
    if (typeof value !== "string" || value.length === 0) {
      throw new ApiError(400, 'Send the value as {"value": "..."}.');
    }
    if (value.length > MAX_SECRET_CHARS) {
      throw new ApiError(413, `Secret values are limited to ${MAX_SECRET_CHARS} characters.`);
    }
    if (!admin.writable) {
      throw new ApiError(
        409,
        "Secrets can't be saved here until GENERIC_AI_SECRETS_KEY is set on the server.",
      );
    }
    try {
      await admin.set(name, value, { updatedBy: c.get("auth").subject.subjectId });
    } catch (error) {
      throw new ApiError(400, error instanceof Error ? error.message : String(error));
    }
    const view = (await secretViews(admin)).find((entry) => entry.name === name);
    return c.json({ secret: view });
  });

  app.delete("/secrets/:name", async (c) => {
    const admin = requireSecrets();
    requireManage(c);
    const name = readSecretName(c);
    const deleted = await admin.delete(name);
    if (!deleted) {
      throw new ApiError(
        404,
        `Secret ${name} is not in the vault. Secrets from the environment or files are changed there.`,
      );
    }
    return c.json({ deleted: true });
  });

  // --- What powers the agents: Claude sign-in or an API key ----------------

  const requireModelAuth = (): CompanyModelAuth => {
    if (options.modelAuth === undefined) {
      throw new ApiError(404, "Model sign-in is not available.");
    }
    return options.modelAuth;
  };
  const modelAuthCall = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      if (error instanceof ModelAuthError) {
        throw new ApiError(error.status === 502 ? 400 : error.status, error.message);
      }
      throw error;
    }
  };

  app.get("/model-auth", async (c) => c.json(await requireModelAuth().status()));

  app.post("/model-auth/claude/start", async (c) => {
    const modelAuth = requireModelAuth();
    requireManage(c);
    return c.json(await modelAuthCall(() => modelAuth.startClaudeSignIn()));
  });

  app.post("/model-auth/claude/finish", async (c) => {
    const modelAuth = requireModelAuth();
    requireManage(c);
    const body = await readJsonObject(c);
    const flowId = body["flowId"];
    const code = body["code"];
    if (typeof flowId !== "string" || typeof code !== "string") {
      throw new ApiError(400, 'Send {"flowId": "...", "code": "..."}.');
    }
    return c.json(await modelAuthCall(() => modelAuth.finishClaudeSignIn(flowId, code)));
  });

  app.put("/model-auth/api-key", async (c) => {
    const modelAuth = requireModelAuth();
    requireManage(c);
    const key = (await readJsonObject(c))["key"];
    if (typeof key !== "string" || key.length > MAX_SECRET_CHARS) {
      throw new ApiError(400, 'Send the key as {"key": "sk-ant-..."}.');
    }
    return c.json(await modelAuthCall(() => modelAuth.saveApiKey(key)));
  });

  app.delete("/model-auth", async (c) => {
    const modelAuth = requireModelAuth();
    requireManage(c);
    return c.json(await modelAuthCall(() => modelAuth.signOut()));
  });

  // --- Agents and the org chart -------------------------------------------

  app.get("/agents", async (c) => c.json({ agents: await runtime.listAgents() }));

  app.get("/org-chart", async (c) => c.json({ root: await runtime.orgChart() }));

  app.get("/agents/:agentId", async (c) => {
    const agentId = c.req.param("agentId");
    const agent = await runtime.directory.get(agentId);
    if (agent === undefined) {
      throw new ApiError(404, `Agent ${agentId} was not found.`);
    }
    const [memory, tasks, reports, chain] = await Promise.all([
      runtime.memory.list(parseMemoryScope(agentId)),
      runtime.listTasks({ agentId, limit: 50 }),
      runtime.directory.directReports(agentId),
      runtime.directory.managementChain(agentId),
    ]);
    return c.json({
      agent,
      memory:
        memory.length === 0
          ? ""
          : memory.map((entry) => `- ${entry.title}: ${entry.content}`).join("\n"),
      memoryEntries: memory,
      reports: reports.map((report) => report.id),
      managementChain: chain.map((manager) => manager.id),
      tasks: tasks.map(summarizeTask),
    });
  });

  app.get("/agents/:agentId/costs", async (c) =>
    c.json(await runtime.costs({ agentId: c.req.param("agentId") })),
  );

  // --- Memory: the company handbook and each agent's private memory --------

  app.get("/memory", async (c) => {
    const [handbook, scopes] = await Promise.all([
      runtime.memory.list("company"),
      runtime.memory.scopes(),
    ]);
    return c.json({ handbook, scopes });
  });

  app.get("/memory/changes", async (c) => {
    const rawScope = c.req.query("scope");
    const rawLimit = Number(c.req.query("limit") ?? "100");
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100;
    return c.json({
      changes: await runtime.memory.changes({
        ...(rawScope === undefined || rawScope === "" ? {} : { scope: parseMemoryScope(rawScope) }),
        limit,
      }),
    });
  });

  app.get("/memory/changes/:changeId", async (c) => {
    const change = await runtime.memory.getChange(c.req.param("changeId"));
    if (change === undefined) {
      throw new ApiError(404, "That memory change was not found.");
    }
    return c.json({ change });
  });

  app.post("/memory/changes/:changeId/undo", async (c) => {
    requireManage(c);
    const result = await runtime.memory.undo(c.req.param("changeId"), {
      kind: "owner",
      ...ownerId(c),
    });
    return c.json(result);
  });

  app.get("/memory/:scope", async (c) => {
    const scope = parseMemoryScope(c.req.param("scope"));
    return c.json({ scope, entries: await runtime.memory.list(scope) });
  });

  app.post("/memory/:scope", async (c) => {
    requireManage(c);
    const scope = parseMemoryScope(c.req.param("scope"));
    const body = await readJsonObject(c);
    const edits = readMemoryEdits(body["edits"]);
    const summary = typeof body["summary"] === "string" ? body["summary"].slice(0, 300) : undefined;
    const result = await runtime.memory.apply({
      scope,
      actor: { kind: "owner", ...ownerId(c) },
      origin: { kind: "owner" },
      edits,
      ...(summary === undefined ? {} : { summary }),
    });
    return c.json(result, result.change === undefined ? 400 : 200);
  });

  // --- Chat with the CEO ---------------------------------------------------

  app.get("/threads", async (c) => c.json({ threads: await runtime.listThreads() }));

  app.post("/threads", async (c) => {
    const body = await readJsonObject(c);
    const goal = readGoalTemplate(runtime, body);
    const text = readMessageText(body, goal?.request);
    const attachments = readAttachments(body);
    const { thread, task } = await runtime.sendMessage({
      text,
      ...(attachments === undefined ? {} : { attachments }),
      actor: toRunActor(c.get("auth")),
      ...(goal === undefined ? {} : { goal: { spec: goal.spec } }),
    });
    return c.json({ thread, taskId: task.taskId }, 201);
  });

  app.get("/threads/:threadId", async (c) => {
    const thread = await runtime.getThread(c.req.param("threadId"));
    if (thread === undefined) {
      throw new ApiError(404, "Thread not found.");
    }
    return c.json({ thread });
  });

  app.post("/threads/:threadId/messages", async (c) => {
    const body = await readJsonObject(c);
    const goal = readGoalTemplate(runtime, body);
    const text = readMessageText(body, goal?.request);
    const attachments = readAttachments(body);
    const { thread, task } = await runtime.sendMessage({
      text,
      ...(attachments === undefined ? {} : { attachments }),
      threadId: c.req.param("threadId"),
      actor: toRunActor(c.get("auth")),
      ...(goal === undefined ? {} : { goal: { spec: goal.spec } }),
    });
    return c.json({ thread, taskId: task.taskId }, 201);
  });

  app.patch("/threads/:threadId", async (c) => {
    const body = await readJsonObject(c);
    const title = body["title"];
    if (typeof title !== "string" || title.trim().length === 0) {
      throw new ApiError(400, 'Send the new title as {"title": "..."}.');
    }
    const threadId = c.req.param("threadId");
    if ((await runtime.threads.get(threadId)) === undefined) {
      throw new ApiError(404, "Thread not found.");
    }
    await runtime.threads.rename(threadId, title);
    return c.json({ thread: await runtime.getThread(threadId) });
  });

  // --- The company drive and the deliverables shelf -----------------------

  const requireDrive = () => {
    if (runtime.drive === undefined) {
      throw new ApiError(404, "This company has no drive.");
    }
    return runtime.drive;
  };

  const readUpload = async (c: Context<ApiEnv>): Promise<Uint8Array> => {
    const data = new Uint8Array(await c.req.arrayBuffer());
    if (data.byteLength > maxUploadBytes) {
      throw new ApiError(413, "The file is too large.");
    }
    return data;
  };

  const publishDrive = (paths: readonly string[]) => {
    runtime.events.publish("drive.updated", { paths: [...paths] });
  };

  app.get("/drive", async (c) => {
    const drive = requireDrive();
    const folder = drive.normalize(c.req.query("path"));
    return c.json({ path: folder, entries: await drive.list(folder) });
  });

  app.get("/drive/file", async (c) => {
    const drive = requireDrive();
    const download = c.req.query("download") === "1" || c.req.query("download") === "true";
    return fileResponse(await drive.file(c.req.query("path") ?? ""), download);
  });

  app.put("/drive/file", async (c) => {
    const drive = requireDrive();
    const overwrite = c.req.query("overwrite") === "1" || c.req.query("overwrite") === "true";
    const entry = await drive.write(c.req.query("path") ?? "", await readUpload(c), { overwrite });
    publishDrive([entry.path]);
    return c.json({ entry }, 201);
  });

  app.post("/drive/inbox", async (c) => {
    const drive = requireDrive();
    const name = c.req.query("name");
    if (name === undefined || name.trim().length === 0) {
      throw new ApiError(400, "Name the file with ?name=.");
    }
    const entry = await drive.addToInbox(name, await readUpload(c));
    publishDrive([entry.path]);
    return c.json({ entry }, 201);
  });

  app.post("/drive/folder", async (c) => {
    const drive = requireDrive();
    const folder = (await readJsonObject(c))["path"];
    if (typeof folder !== "string" || folder.trim().length === 0) {
      throw new ApiError(400, 'Send the folder as {"path": "drive/..."}.');
    }
    const entry = await drive.createFolder(folder);
    publishDrive([entry.path]);
    return c.json({ entry }, 201);
  });

  app.delete("/drive", async (c) => {
    const drive = requireDrive();
    const target = drive.normalize(c.req.query("path"));
    await drive.remove(target);
    publishDrive([target]);
    return c.json({ deleted: true });
  });

  app.get("/deliverables", async (c) => c.json({ goals: await requireDrive().deliverables() }));

  // --- Tasks and the board -------------------------------------------------

  app.get("/tasks", async (c) => {
    const statuses = readStatuses(c.req.query("status"));
    const agentId = c.req.query("agentId");
    const tasks = await runtime.listTasks({
      ...(statuses === undefined ? {} : { status: statuses }),
      ...(agentId === undefined ? {} : { agentId }),
      rootOnly: c.req.query("root") === "1" || c.req.query("root") === "true",
      limit: readLimit(c.req.query("limit"), 100, 1000),
    });
    return c.json({ tasks: tasks.map(summarizeTask) });
  });

  app.get("/tasks/:taskId", async (c) => {
    const task = await runtime.cascade.get(c.req.param("taskId"));
    if (task === undefined) {
      throw new ApiError(404, "Task not found.");
    }
    const children = await runtime.cascade.children(task.taskId);
    return c.json({ task, children: children.map(summarizeTask) });
  });

  app.get("/tasks/:taskId/tree", async (c) => {
    const task = await runtime.cascade.get(c.req.param("taskId"));
    if (task === undefined) {
      throw new ApiError(404, "Task not found.");
    }
    const tree = await runtime.cascade.tree(task.rootTaskId);
    return c.json({ rootTaskId: task.rootTaskId, tasks: tree.map(summarizeTask) });
  });

  app.get("/tasks/:taskId/events", async (c) => {
    const task = await runtime.cascade.get(c.req.param("taskId"));
    if (task === undefined) {
      throw new ApiError(404, "Task not found.");
    }
    const taskEvents = await runtime.storage.runStore.readEvents(task.taskId);
    const runs = await Promise.all(
      task.runIds.map(async (runId) => ({
        runId,
        events: await runtime.storage.runStore.readEvents(runId),
      })),
    );
    return c.json({ taskId: task.taskId, events: taskEvents, runs });
  });

  app.post("/tasks/:taskId/cancel", async (c) => {
    const body = await readJsonObject(c);
    const reason = typeof body["reason"] === "string" ? body["reason"] : "Cancelled by the owner.";
    const taskId = c.req.param("taskId");
    if ((await runtime.cascade.get(taskId)) === undefined) {
      throw new ApiError(404, "Task not found.");
    }
    const cancelled = await runtime.cascade.cancel(taskId, reason);
    return c.json({ cancelled, task: await runtime.cascade.get(taskId) });
  });

  app.get("/board", async (c) =>
    c.json({ columns: await runtime.board({ limit: readLimit(c.req.query("limit"), 300, 2000) }) }),
  );

  // --- Costs ----------------------------------------------------------------

  app.get("/costs", async (c) =>
    c.json(await runtime.costs({ limit: readLimit(c.req.query("limit"), 1000, 10_000) })),
  );

  // --- Live events ---------------------------------------------------------

  app.get("/events", (c) => {
    const lastEventId = Number(c.req.header("last-event-id") ?? c.req.query("since") ?? "0");
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | undefined;
    let keepAlive: ReturnType<typeof setInterval> | undefined;
    const close = () => {
      unsubscribe?.();
      unsubscribe = undefined;
      if (keepAlive !== undefined) {
        clearInterval(keepAlive);
        keepAlive = undefined;
      }
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (text: string) => {
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            close();
          }
        };
        send(`retry: 3000\n: connected ${runtime.events.lastId}\n\n`);
        if (Number.isInteger(lastEventId) && lastEventId > 0) {
          for (const event of runtime.events.since(lastEventId)) {
            send(sseFrame(event));
          }
        }
        unsubscribe = runtime.events.subscribe((event) => send(sseFrame(event)));
        keepAlive = setInterval(() => send(": keep-alive\n\n"), keepAliveMs);
        c.req.raw.signal.addEventListener("abort", () => {
          close();
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        });
      },
      cancel: close,
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  });

  app.notFound((c) => errorResponse(c, 404, "Not found."));

  return app;
}
