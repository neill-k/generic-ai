import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { StorageContract } from "@generic-ai/sdk";

/**
 * The company drive (design decisions 23-26 and 34).
 *
 * Everything agents work on lives under one company root, `<dataDir>/company`:
 *
 * ```text
 * company/                       every agent's tool root and starting directory
 *   drive/                       the shared company drive, read and written by every agent
 *     inbox/                     what the owner uploads or drops into a chat
 *     goals/<goalId>/            one working folder per goal (goalId = the root task id)
 *       deliverables/            finished work, shown on the owner's deliverables shelf
 *   agents/<agentId>/            each agent's home: memory, skills, saved sessions
 *     workspace/                 the agent's private scratch folder
 * ```
 *
 * A path is always written relative to the company root (`drive/goals/abc/deliverables/brief.md`),
 * so the same path means the same file to every agent, to the host's goal checks and to the
 * owner's drive browser. Agents hand work to each other by these paths instead of pasting text.
 *
 * The company is one trust zone: agents may read and write anywhere under the company root. The
 * wall is between the company and everything else (the database, secrets, run artifacts), which
 * live outside it in the data directory. The owner's API reaches `drive/` only.
 *
 * Goal folders carry a host-kept status (`active`, `done`, `failed`, `abandoned`) stored outside
 * the drive, so agents cannot change it. Cancelling a goal keeps its folder and marks it
 * abandoned, with an `ABANDONED.md` note inside for anyone who opens it later.
 */

export const COMPANY_DIR = "company";
export const DRIVE_DIR = "drive";
export const AGENTS_DIR = "agents";
export const INBOX_DIR = `${DRIVE_DIR}/inbox`;
export const GOALS_DIR = `${DRIVE_DIR}/goals`;
export const DELIVERABLES_DIR = "deliverables";
export const ABANDONED_NOTE = "ABANDONED.md";
export const HANDOFFS_DIR = "handoffs";

/** Where the company's files live on disk. */
export interface CompanyLayout {
  /** The company root: every agent's tool root. */
  readonly root: string;
  /** `<root>/drive`. */
  readonly driveRoot: string;
  /** `<root>/agents`: parent of every agent home. */
  readonly agentsRoot: string;
}

export function companyLayout(dataDir: string): CompanyLayout {
  const root = path.resolve(dataDir, COMPANY_DIR);
  return {
    root,
    driveRoot: path.join(root, DRIVE_DIR),
    agentsRoot: path.join(root, AGENTS_DIR),
  };
}

/** The working folder of a goal, relative to the company root. */
export function goalFolder(goalId: string): string {
  return `${GOALS_DIR}/${safeSegment(goalId, "goal id")}`;
}

/** Where a goal's finished work goes, relative to the company root. */
export function deliverablesFolder(goalId: string): string {
  return `${goalFolder(goalId)}/${DELIVERABLES_DIR}`;
}

/** What agents are told about the drive at the start of each turn. */
export function describeDriveForAgent(input: {
  readonly agentId: string;
  readonly goalId?: string;
}): string {
  const lines = [
    "## The company drive",
    "Your working directory is the company root. Paths below are relative to it, and every agent and the owner see the same files at the same paths.",
    `- drive/ is the shared company drive. Anything the owner hands in is under ${INBOX_DIR}/.`,
    `- ${AGENTS_DIR}/${input.agentId}/workspace/ is your own scratch folder.`,
  ];
  if (input.goalId !== undefined) {
    lines.push(
      `- ${goalFolder(input.goalId)}/ is this goal's working folder. Put finished work for the owner in ${deliverablesFolder(input.goalId)}/.`,
    );
  }
  lines.push(
    "Hand work to other agents as file paths on the drive, not as pasted text: write the material to a file and name the path in the task or in your result.",
  );
  return lines.join("\n");
}

export type DriveEntryKind = "file" | "folder";

export interface DriveEntry {
  readonly name: string;
  /** Relative to the company root, with `/` separators. */
  readonly path: string;
  readonly kind: DriveEntryKind;
  /** Bytes, for files. */
  readonly size?: number;
  readonly modifiedAt: string;
  /** Guessed from the extension, for files. */
  readonly mimeType?: string;
}

export type GoalFolderStatus = "active" | "done" | "failed" | "abandoned";

export interface GoalFolderRecord {
  readonly goalId: string;
  readonly status: GoalFolderStatus;
  /** The owner's words that started the goal. */
  readonly title?: string;
  readonly threadId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Why it ended, for failed and abandoned goals. */
  readonly reason?: string;
}

export interface DeliverableShelfEntry extends GoalFolderRecord {
  readonly folder: string;
  readonly files: readonly DriveEntry[];
}

export interface DriveFile {
  readonly absolutePath: string;
  readonly entry: DriveEntry;
}

export class DriveError extends Error {
  constructor(
    readonly code: "invalid" | "outside" | "not_found" | "exists" | "not_empty" | "not_a_file",
    message: string,
  ) {
    super(message);
    this.name = "DriveError";
  }
}

export interface CompanyDrive {
  readonly layout: CompanyLayout;
  /** Creates the drive's standard folders. Safe to call repeatedly. */
  ensure(): Promise<void>;
  /**
   * Resolves a path an agent used (company-root relative, drive relative such as
   * `goals/abc/brief.md`, or absolute inside the company root) to an absolute path, following
   * symlinks. Undefined when it leaves the company root.
   */
  resolveAgentPath(input: string): Promise<string | undefined>;
  /** Like `resolveAgentPath`, but only paths inside `drive/`. */
  resolveDrivePath(input: string): Promise<string | undefined>;
  /** Normalizes an owner-supplied drive path to `drive/...` form, or throws `DriveError`. */
  normalize(input: string | undefined): string;
  list(input?: string): Promise<readonly DriveEntry[]>;
  stat(input: string): Promise<DriveEntry>;
  /** A file to stream to the owner. */
  file(input: string): Promise<DriveFile>;
  /** Writes a file into the drive. Refuses to replace one unless `overwrite`. */
  write(
    input: string,
    data: Uint8Array,
    options?: { readonly overwrite?: boolean },
  ): Promise<DriveEntry>;
  /** Writes into the inbox under a name that is not taken yet (`name (2).ext`). */
  addToInbox(name: string, data: Uint8Array): Promise<DriveEntry>;
  createFolder(input: string): Promise<DriveEntry>;
  /** Removes a file or an empty folder. The drive's standard folders stay. */
  remove(input: string): Promise<void>;

  /** Creates a goal's folder and records it as active. */
  openGoal(input: {
    readonly goalId: string;
    readonly title?: string;
    readonly threadId?: string;
  }): Promise<GoalFolderRecord>;
  /** Records how a goal ended. Abandoned goals keep their files and get an `ABANDONED.md`. */
  closeGoal(
    goalId: string,
    status: Exclude<GoalFolderStatus, "active">,
    reason?: string,
  ): Promise<GoalFolderRecord | undefined>;
  getGoal(goalId: string): Promise<GoalFolderRecord | undefined>;
  /**
   * Saves an agent's whole result for the one who delegated the work, in the goal's
   * `handoffs/` folder, and returns its company-root path.
   */
  saveHandoff(goalId: string, name: string, text: string): Promise<string>;
  /** Every goal folder with the files in its `deliverables/`, newest first. */
  deliverables(): Promise<readonly DeliverableShelfEntry[]>;
}

export interface CreateCompanyDriveOptions {
  readonly layout: CompanyLayout;
  /** Where goal folder statuses are kept. Without it, statuses live in memory. */
  readonly kv?: StorageContract;
  readonly now?: () => Date;
}

const KV_NAMESPACE = "generic-corp";
const KV_COLLECTION = "goal-folders";
const MAX_PATH_CHARS = 1024;
const MAX_SEGMENT_CHARS = 255;
const STANDARD_FOLDERS = [DRIVE_DIR, INBOX_DIR, GOALS_DIR] as const;

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".xml": "application/xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/plain",
  ".py": "text/plain",
  ".sh": "text/plain",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".zip": "application/zip",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function mimeTypeOf(name: string): string {
  return MIME_TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

function safeSegment(segment: string, what: string): string {
  if (
    segment.length === 0 ||
    segment.length > MAX_SEGMENT_CHARS ||
    segment === "." ||
    segment === ".." ||
    /[\\/\0]/.test(segment) ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters.
    /[\u0000-\u001f\u007f]/.test(segment)
  ) {
    throw new DriveError("invalid", `"${segment}" is not a usable ${what}.`);
  }
  return segment;
}

/** Splits a relative path into checked segments. */
function segmentsOf(input: string): string[] {
  if (input.length > MAX_PATH_CHARS) {
    throw new DriveError("invalid", `Paths are limited to ${MAX_PATH_CHARS} characters.`);
  }
  const segments = input
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  for (const segment of segments) {
    safeSegment(segment, "file or folder name");
  }
  return segments;
}

function isWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

/** Resolves symlinks in the longest existing prefix of `target`. */
async function realpathOfNearest(target: string): Promise<string> {
  let current = target;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = await realpath(current);
      return rest.length === 0 ? real : path.join(real, ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return target;
      }
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

export function createCompanyDrive(options: CreateCompanyDriveOptions): CompanyDrive {
  const { layout } = options;
  const now = options.now ?? (() => new Date());
  const memoryGoals = new Map<string, GoalFolderRecord>();
  let realRoot: string | undefined;

  const goalKey = (goalId: string) => ({
    namespace: KV_NAMESPACE,
    collection: KV_COLLECTION,
    id: goalId,
  });

  async function loadGoal(goalId: string): Promise<GoalFolderRecord | undefined> {
    if (options.kv === undefined) {
      return memoryGoals.get(goalId);
    }
    return (await options.kv.get<GoalFolderRecord>(goalKey(goalId)))?.value;
  }

  async function saveGoal(record: GoalFolderRecord): Promise<void> {
    if (options.kv === undefined) {
      memoryGoals.set(record.goalId, record);
      return;
    }
    await options.kv.set({
      key: goalKey(record.goalId),
      value: record,
      updatedAt: record.updatedAt,
    });
  }

  async function listGoals(): Promise<GoalFolderRecord[]> {
    if (options.kv === undefined) {
      return [...memoryGoals.values()];
    }
    const records = await options.kv.list({ namespace: KV_NAMESPACE, collection: KV_COLLECTION });
    return records.map((record) => record.value as GoalFolderRecord);
  }

  async function root(): Promise<string> {
    if (realRoot === undefined) {
      await mkdir(layout.root, { recursive: true });
      realRoot = await realpath(layout.root);
    }
    return realRoot;
  }

  /** `drive/...` form of an owner path. */
  function normalize(input: string | undefined): string {
    const segments = segmentsOf((input ?? DRIVE_DIR).trim());
    if (segments[0] !== DRIVE_DIR) {
      segments.unshift(DRIVE_DIR);
    }
    return segments.join("/");
  }

  async function resolveWithin(relative: string, scope: "company" | "drive"): Promise<string> {
    const base = await root();
    const target = path.join(base, ...segmentsOf(relative));
    const real = await realpathOfNearest(target);
    const limit = scope === "drive" ? path.join(base, DRIVE_DIR) : base;
    if (!isWithin(limit, real)) {
      throw new DriveError(
        "outside",
        `${relative} is outside the ${scope === "drive" ? "drive" : "company"}.`,
      );
    }
    return real;
  }

  async function entryFor(absolute: string, relative: string): Promise<DriveEntry> {
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(absolute);
    } catch {
      throw new DriveError("not_found", `${relative} was not found.`);
    }
    const name = path.basename(relative) || relative;
    if (info.isDirectory()) {
      return { name, path: relative, kind: "folder", modifiedAt: info.mtime.toISOString() };
    }
    if (!info.isFile()) {
      throw new DriveError("not_a_file", `${relative} is not a file or folder.`);
    }
    return {
      name,
      path: relative,
      kind: "file",
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
      mimeType: mimeTypeOf(name),
    };
  }

  async function listAt(relative: string): Promise<DriveEntry[]> {
    const absolute = await resolveWithin(relative, "drive");
    let names: string[];
    try {
      names = await readdir(absolute);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTDIR") {
        throw new DriveError("not_a_file", `${relative} is a file, not a folder.`);
      }
      throw new DriveError("not_found", `${relative} was not found.`);
    }
    const entries: DriveEntry[] = [];
    for (const name of names) {
      try {
        // Symlinks and other special files are skipped: the owner sees plain files and folders.
        entries.push(await entryFor(path.join(absolute, name), `${relative}/${name}`));
      } catch {
        // Skipped.
      }
    }
    return entries.sort((left, right) =>
      left.kind === right.kind
        ? left.name.localeCompare(right.name)
        : left.kind === "folder"
          ? -1
          : 1,
    );
  }

  async function write(
    input: string,
    data: Uint8Array,
    writeOptions: { readonly overwrite?: boolean } = {},
  ): Promise<DriveEntry> {
    const relative = normalize(input);
    if (relative === DRIVE_DIR) {
      throw new DriveError("invalid", "Name the file to write.");
    }
    const absolute = await resolveWithin(relative, "drive");
    await mkdir(path.dirname(absolute), { recursive: true });
    // Re-check after creating folders, in case a folder on the way is a symlink out.
    const parent = await realpath(path.dirname(absolute));
    if (!isWithin(path.join(await root(), DRIVE_DIR), parent)) {
      throw new DriveError("outside", `${relative} is outside the drive.`);
    }
    const target = path.join(parent, path.basename(absolute));
    const existing = await lstat(target).catch(() => undefined);
    if (existing !== undefined) {
      if (!existing.isFile()) {
        throw new DriveError("exists", `${relative} already exists and is not a file.`);
      }
      if (writeOptions.overwrite !== true) {
        throw new DriveError("exists", `${relative} already exists.`);
      }
    }
    // Write beside the target, then rename, so a reader never sees half a file.
    const temporary = path.join(
      parent,
      `.upload-${process.pid}-${Date.now()}-${path.basename(target)}`,
    );
    await writeFile(temporary, data, { flag: "wx" });
    try {
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return entryFor(target, relative);
  }

  return {
    layout,

    async ensure() {
      const base = await root();
      for (const folder of STANDARD_FOLDERS) {
        await mkdir(path.join(base, folder), { recursive: true });
      }
      await mkdir(layout.agentsRoot, { recursive: true });
    },

    async resolveAgentPath(input) {
      try {
        const base = await root();
        const relative = input.trim();
        if (path.isAbsolute(relative)) {
          const real = await realpathOfNearest(path.resolve(relative));
          return isWithin(base, real) ? real : undefined;
        }
        const segments = segmentsOf(relative);
        if (segments[0] !== DRIVE_DIR && segments[0] !== AGENTS_DIR) {
          segments.unshift(DRIVE_DIR);
        }
        return await resolveWithin(segments.join("/"), "company");
      } catch {
        return undefined;
      }
    },

    async resolveDrivePath(input) {
      const resolved = await this.resolveAgentPath(input);
      if (resolved === undefined) {
        return undefined;
      }
      return isWithin(path.join(await root(), DRIVE_DIR), resolved) ? resolved : undefined;
    },

    normalize,

    list: (input) => listAt(normalize(input)),

    async stat(input) {
      const relative = normalize(input);
      return entryFor(await resolveWithin(relative, "drive"), relative);
    },

    async file(input) {
      const relative = normalize(input);
      const absolute = await resolveWithin(relative, "drive");
      const entry = await entryFor(absolute, relative);
      if (entry.kind !== "file") {
        throw new DriveError("not_a_file", `${relative} is a folder.`);
      }
      // Refuse a symlink swapped in after the check.
      const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
        throw new DriveError("not_found", `${relative} was not found.`);
      });
      await handle.close();
      return { absolutePath: absolute, entry };
    },

    write,

    async addToInbox(name, data) {
      const clean = safeSegment(path.basename(name.replaceAll("\\", "/")).trim(), "file name");
      const extension = path.extname(clean);
      const stem = clean.slice(0, clean.length - extension.length) || clean;
      for (let attempt = 1; attempt < 1000; attempt += 1) {
        const candidate = attempt === 1 ? clean : `${stem} (${attempt})${extension}`;
        try {
          return await write(`${INBOX_DIR}/${candidate}`, data);
        } catch (error) {
          if (!(error instanceof DriveError && error.code === "exists")) {
            throw error;
          }
        }
      }
      throw new DriveError("exists", `Too many files named ${clean} in the inbox.`);
    },

    async createFolder(input) {
      const relative = normalize(input);
      const absolute = await resolveWithin(relative, "drive");
      await mkdir(absolute, { recursive: true });
      return entryFor(absolute, relative);
    },

    async remove(input) {
      const relative = normalize(input);
      if ((STANDARD_FOLDERS as readonly string[]).includes(relative)) {
        throw new DriveError("invalid", `${relative} is one of the drive's own folders.`);
      }
      const absolute = await resolveWithin(relative, "drive");
      const entry = await entryFor(absolute, relative);
      if (entry.kind === "file") {
        await rm(absolute);
        return;
      }
      try {
        await rmdir(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOTEMPTY") {
          throw new DriveError("not_empty", `${relative} is not empty.`);
        }
        throw error;
      }
    },

    async openGoal(input) {
      await mkdir(path.join(await root(), deliverablesFolder(input.goalId)), { recursive: true });
      const existing = await loadGoal(input.goalId);
      if (existing !== undefined) {
        return existing;
      }
      const at = now().toISOString();
      const record: GoalFolderRecord = {
        goalId: input.goalId,
        status: "active",
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        createdAt: at,
        updatedAt: at,
      };
      await saveGoal(record);
      return record;
    },

    async closeGoal(goalId, status, reason) {
      const existing = await loadGoal(goalId);
      if (existing === undefined) {
        return undefined;
      }
      if (existing.status === status) {
        return existing;
      }
      const at = now().toISOString();
      const record: GoalFolderRecord = {
        ...existing,
        status,
        updatedAt: at,
        ...(reason === undefined ? {} : { reason }),
      };
      await saveGoal(record);
      if (status === "abandoned") {
        const note = [
          "# Abandoned",
          "",
          `The owner cancelled this goal on ${at}.${reason === undefined ? "" : ` Reason: ${reason}`}`,
          "",
          "The work in this folder is partial. It is kept so it can be picked up again.",
          "",
        ].join("\n");
        const target = path.join(await root(), goalFolder(goalId), ABANDONED_NOTE);
        await writeFile(target, note).catch(() => undefined);
      }
      return record;
    },

    getGoal: loadGoal,

    async saveHandoff(goalId, name, text) {
      const relative = `${goalFolder(goalId)}/${HANDOFFS_DIR}/${safeSegment(name, "file name")}`;
      await write(relative, new TextEncoder().encode(text), { overwrite: true });
      return relative;
    },

    async deliverables() {
      const goals = (await listGoals()).sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt),
      );
      const shelf: DeliverableShelfEntry[] = [];
      for (const goal of goals) {
        const folder = deliverablesFolder(goal.goalId);
        const files = await listAt(folder).catch(() => [] as DriveEntry[]);
        shelf.push({ ...goal, folder, files: await flatten(files) });
      }
      return shelf;
    },
  };

  async function flatten(entries: readonly DriveEntry[], depth = 0): Promise<DriveEntry[]> {
    const files: DriveEntry[] = [];
    for (const entry of entries) {
      if (entry.kind === "file") {
        files.push(entry);
      } else if (depth < 4) {
        files.push(...(await flatten(await listAt(entry.path).catch(() => []), depth + 1)));
      }
    }
    return files;
  }
}
