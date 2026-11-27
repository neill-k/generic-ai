import { chmod, lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { withAgentHarnessToolEffects } from "@generic-ai/sdk";
import { type Static, Type } from "@sinclair/typebox";

/**
 * The GitHub connector (design decisions 24, 29 and 39). The owner connects it once with a token;
 * agents can then read the repositories the token can see. Writing (pushing a branch, opening a
 * pull request, merging) is decided by the owner's permissions: only in repositories the owner
 * opened for writing, and a merge only once every check on the pull request is green.
 *
 * The token stays with the host. It is kept in a credential file on the data volume that only
 * the server's OS user can read (like the model sign-in), never in an agent's environment, and
 * every GitHub call runs in the server process. An agent's shell can reach github.com through the
 * egress proxy, but without the token it can only read public code.
 */

export const GITHUB_CONNECTOR_ID = "github";
/** Environment fallback for deploys that set the token instead of connecting in the app. */
export const GITHUB_TOKEN_ENV = "GENERIC_CORP_GITHUB_TOKEN";
const API_BASE = "https://api.github.com";
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** Branch names git and GitHub accept, without the oddities (`..`, `@{`, leading `-`). */
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*@\{)(?!.*\/\/)(?!.*\.lock$)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/;
const MAX_PUSH_FILES = 500;
const MAX_PUSH_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_READ_CHARS = 100_000;
const GREEN_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

export type GithubFetch = (url: string, init: RequestInit) => Promise<Response>;

export class GithubError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "GithubError";
    this.status = status;
  }
}

export interface GithubConnection {
  readonly connected: boolean;
  /** The GitHub login the token belongs to. */
  readonly account?: string;
  /** `owner` when connected in the app, `env` when the token came from the environment. */
  readonly source?: "owner" | "env";
  readonly connectedAt?: string;
  /** Classic token scopes, when GitHub reports them. Fine-grained tokens report none. */
  readonly scopes?: readonly string[];
}

export interface GithubRepoSummary {
  readonly fullName: string;
  readonly private: boolean;
  readonly defaultBranch: string;
  /** Whether the token may push to it. The owner still decides whether agents may. */
  readonly canPush: boolean;
}

export interface GithubChecksVerdict {
  readonly green: boolean;
  readonly reason: string;
  readonly headSha?: string;
}

export interface GithubPushInput {
  /** Folder whose files are pushed, relative to `root`. */
  readonly from: string;
  readonly root: string;
  readonly repo: string;
  readonly branch: string;
  readonly message: string;
  /** Branch a new branch starts from. Defaults to the repository's default branch. */
  readonly base?: string;
  /** Folder in the repository the files go into. Defaults to its root. */
  readonly to?: string;
}

export interface GithubPushResult {
  readonly repo: string;
  readonly branch: string;
  readonly commit: string;
  readonly files: number;
  readonly created: boolean;
  readonly url: string;
}

export interface GithubPullRequestResult {
  readonly number: number;
  readonly url: string;
}

export interface GithubConnector {
  /** Cached: whether a token is on hand, so agents only get GitHub tools when it is connected. */
  isConnected(): boolean;
  status(): Promise<GithubConnection>;
  connect(token: string): Promise<GithubConnection>;
  disconnect(): Promise<GithubConnection>;
  repos(): Promise<readonly GithubRepoSummary[]>;
  /** A file's text, or a folder's entries. */
  readPath(repo: string, filePath: string, ref?: string): Promise<unknown>;
  listPullRequests(repo: string, state: "open" | "closed" | "all"): Promise<unknown>;
  checks(repo: string, pullNumber: number): Promise<GithubChecksVerdict>;
  /** For the permission gate: confirms a merge call's pull request has all checks green. */
  verifyGreenChecks(input: unknown): Promise<boolean>;
  pushFolder(input: GithubPushInput): Promise<GithubPushResult>;
  openPullRequest(input: {
    readonly repo: string;
    readonly head: string;
    readonly base?: string;
    readonly title: string;
    readonly body?: string;
  }): Promise<GithubPullRequestResult>;
  merge(input: {
    readonly repo: string;
    readonly pullNumber: number;
    readonly method?: "merge" | "squash" | "rebase";
  }): Promise<{ readonly sha: string; readonly merged: boolean }>;
  /** The agent tools, with `root` as the folder pushes are read from. */
  tools(root: string): readonly unknown[];
}

export interface CreateGithubConnectorOptions {
  /** Credential file, normally `<dataDir>/connectors/github.json`. */
  readonly credentialPath: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Replaces `fetch`, for tests. No test talks to the real GitHub. */
  readonly fetch?: GithubFetch;
  readonly apiBase?: string;
  readonly now?: () => Date;
}

interface StoredCredential {
  readonly token: string;
  readonly account: string;
  readonly connectedAt: string;
  readonly scopes?: readonly string[];
}

/** `owner/name`, lower-cased, or an error naming the problem. */
export function normalizeRepo(value: unknown): string {
  if (typeof value !== "string" || !REPO.test(value.trim())) {
    throw new GithubError('Name the repository as "owner/name", like "acme/website".');
  }
  return value.trim().toLowerCase();
}

function normalizeBranch(value: unknown, label = "branch"): string {
  if (typeof value !== "string" || !BRANCH.test(value.trim())) {
    throw new GithubError(
      `The ${label} name is not valid. Use letters, digits, ".", "_", "-" and "/", like "reports/q3".`,
    );
  }
  return value.trim();
}

function pullNumberOf(input: Record<string, unknown>): number | undefined {
  for (const key of ["pullNumber", "pull_number", "number", "pr"]) {
    const value = input[key];
    const number = typeof value === "string" ? Number(value) : value;
    if (typeof number === "number" && Number.isInteger(number) && number > 0) {
      return number;
    }
  }
  return undefined;
}

function repoOf(input: Record<string, unknown>): string | undefined {
  if (typeof input["owner"] === "string" && typeof input["repo"] === "string") {
    return `${input["owner"]}/${input["repo"]}`;
  }
  for (const key of ["repo", "repository", "full_name"]) {
    if (typeof input[key] === "string") {
      return input[key] as string;
    }
  }
  return undefined;
}

/** Files under `folder`, skipping symlinks and `.git`, with paths relative to it. */
async function collectFiles(folder: string): Promise<{ path: string; full: string }[]> {
  const out: { path: string; full: string }[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === ".git" || entry.isSymbolicLink()) {
        continue;
      }
      const full = path.join(dir, entry.name);
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile()) {
        out.push({ path: rel, full });
        if (out.length > MAX_PUSH_FILES) {
          throw new GithubError(`A push holds at most ${MAX_PUSH_FILES} files.`);
        }
      }
    }
  };
  await walk(folder, "");
  return out;
}

/** Resolves `from` inside `root`, refusing anything that leaves it, symlinks included. */
async function folderInside(root: string, from: string): Promise<string> {
  const realRoot = await realpath(root);
  const target = path.resolve(realRoot, from);
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    throw new GithubError(`There is no folder "${from}" in the company drive.`, 404);
  }
  if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) {
    throw new GithubError(`"${from}" is outside the company drive.`);
  }
  if (!(await lstat(real)).isDirectory()) {
    throw new GithubError(`"${from}" is a file. Push a folder.`);
  }
  return real;
}

export function createGithubConnector(options: CreateGithubConnectorOptions): GithubConnector {
  const env = options.env ?? process.env;
  const doFetch: GithubFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const apiBase = (options.apiBase ?? API_BASE).replace(/\/$/, "");
  const now = options.now ?? (() => new Date());
  let stored: StoredCredential | undefined;
  let loaded = false;

  const load = async (): Promise<StoredCredential | undefined> => {
    if (!loaded) {
      try {
        stored = JSON.parse(await readFile(options.credentialPath, "utf8")) as StoredCredential;
      } catch {
        stored = undefined;
      }
      loaded = true;
    }
    return stored;
  };
  const envToken = (): string | undefined => {
    const value = env[GITHUB_TOKEN_ENV]?.trim();
    return value === undefined || value === "" ? undefined : value;
  };
  const token = async (): Promise<string> => {
    const value = (await load())?.token ?? envToken();
    if (value === undefined) {
      throw new GithubError(
        "GitHub is not connected. The owner connects it on the Connections page.",
        409,
      );
    }
    return value;
  };

  const request = async <T>(
    method: string,
    pathname: string,
    body?: unknown,
    explicitToken?: string,
  ): Promise<{ status: number; data: T; headers: Headers }> => {
    const response = await doFetch(`${apiBase}${pathname}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${explicitToken ?? (await token())}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "generic-corp",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let data: unknown;
    try {
      data = text === "" ? undefined : JSON.parse(text);
    } catch {
      data = undefined;
    }
    return { status: response.status, data: data as T, headers: response.headers };
  };

  const call = async <T>(method: string, pathname: string, body?: unknown): Promise<T> => {
    const { status, data } = await request<T>(method, pathname, body);
    if (status >= 200 && status < 300) {
      return data;
    }
    const message =
      typeof data === "object" && data !== null && "message" in data
        ? String((data as { message: unknown }).message)
        : `status ${status}`;
    if (status === 401) {
      throw new GithubError(
        "GitHub rejected the token. The owner can reconnect GitHub on the Connections page.",
        409,
      );
    }
    if (status === 404) {
      throw new GithubError(
        `GitHub found nothing at ${pathname.split("?")[0]}, or the token cannot see it.`,
        404,
      );
    }
    throw new GithubError(`GitHub refused the request: ${message}.`, status === 403 ? 403 : 400);
  };

  const repoPath = (repo: string): string => {
    const [owner, name] = normalizeRepo(repo).split("/") as [string, string];
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  };

  const repoInfo = async (repo: string) => {
    const data = await call<{
      default_branch: string;
      private: boolean;
      full_name: string;
      permissions?: { push?: boolean };
    }>("GET", repoPath(repo));
    return data;
  };

  const checks = async (repo: string, pullNumber: number): Promise<GithubChecksVerdict> => {
    const base = repoPath(repo);
    const pull = await call<{
      state: string;
      draft?: boolean;
      merged?: boolean;
      head: { sha: string };
    }>("GET", `${base}/pulls/${pullNumber}`);
    const headSha = pull.head.sha;
    if (pull.state !== "open" || pull.merged === true) {
      return { green: false, reason: "the pull request is not open", headSha };
    }
    if (pull.draft === true) {
      return { green: false, reason: "the pull request is still a draft", headSha };
    }
    const runs = await call<{
      total_count: number;
      check_runs: { name: string; status: string; conclusion: string | null }[];
    }>("GET", `${base}/commits/${headSha}/check-runs?per_page=100`);
    const statuses = await call<{ state: string; total_count: number }>(
      "GET",
      `${base}/commits/${headSha}/status`,
    );
    const total = runs.check_runs.length + statuses.total_count;
    if (total === 0) {
      return { green: false, reason: "no checks ran on the pull request", headSha };
    }
    const pending = runs.check_runs.filter((run) => run.status !== "completed");
    if (pending.length > 0 || (statuses.total_count > 0 && statuses.state === "pending")) {
      return {
        green: false,
        reason: `checks are still running${pending.length > 0 ? ` (${pending.map((run) => run.name).join(", ")})` : ""}`,
        headSha,
      };
    }
    const failed = runs.check_runs.filter((run) => !GREEN_CONCLUSIONS.has(run.conclusion ?? ""));
    if (failed.length > 0 || (statuses.total_count > 0 && statuses.state !== "success")) {
      return {
        green: false,
        reason: `checks are not all green${failed.length > 0 ? ` (${failed.map((run) => run.name).join(", ")})` : ""}`,
        headSha,
      };
    }
    return { green: true, reason: `all ${total} checks are green`, headSha };
  };

  const pushFolder = async (input: GithubPushInput): Promise<GithubPushResult> => {
    const repo = normalizeRepo(input.repo);
    const branch = normalizeBranch(input.branch);
    const message = input.message.trim();
    if (message === "") {
      throw new GithubError("A push needs a commit message.");
    }
    const prefix = (input.to ?? "").trim().replace(/^\/+|\/+$/g, "");
    if (prefix.split("/").some((part) => part === ".." || part === ".")) {
      throw new GithubError('The destination folder cannot contain "." or "..".');
    }
    const folder = await folderInside(input.root, input.from);
    const files = await collectFiles(folder);
    if (files.length === 0) {
      throw new GithubError(`"${input.from}" has no files to push.`);
    }
    const info = await repoInfo(repo);
    if (branch === info.default_branch) {
      throw new GithubError(
        `Push to a new or working branch, not ${info.default_branch}, the default branch. Open a pull request to bring the work in.`,
      );
    }
    const base = repoPath(repo);
    const existing = await request<{ object: { sha: string } }>(
      "GET",
      `${base}/git/ref/heads/${branch}`,
    );
    let parent: string;
    let created: boolean;
    if (existing.status === 200) {
      parent = existing.data.object.sha;
      created = false;
    } else if (existing.status === 404) {
      const from = normalizeBranch(input.base ?? info.default_branch, "base branch");
      parent = (await call<{ object: { sha: string } }>("GET", `${base}/git/ref/heads/${from}`))
        .object.sha;
      created = true;
    } else {
      throw new GithubError(`GitHub could not look up the branch (status ${existing.status}).`);
    }
    const parentCommit = await call<{ tree: { sha: string } }>(
      "GET",
      `${base}/git/commits/${parent}`,
    );

    let bytes = 0;
    const tree: { path: string; mode: string; type: string; sha: string }[] = [];
    for (const file of files) {
      const content = await readFile(file.full);
      if (content.byteLength > MAX_FILE_BYTES) {
        throw new GithubError(`${file.path} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
      }
      bytes += content.byteLength;
      if (bytes > MAX_PUSH_BYTES) {
        throw new GithubError(`A push holds at most ${MAX_PUSH_BYTES / 1024 / 1024} MB.`);
      }
      const blob = await call<{ sha: string }>("POST", `${base}/git/blobs`, {
        content: content.toString("base64"),
        encoding: "base64",
      });
      tree.push({
        path: prefix === "" ? file.path : `${prefix}/${file.path}`,
        mode: "100644",
        type: "blob",
        sha: blob.sha,
      });
    }
    const newTree = await call<{ sha: string }>("POST", `${base}/git/trees`, {
      base_tree: parentCommit.tree.sha,
      tree,
    });
    const commit = await call<{ sha: string }>("POST", `${base}/git/commits`, {
      message,
      tree: newTree.sha,
      parents: [parent],
    });
    if (created) {
      await call("POST", `${base}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
    } else {
      await call("PATCH", `${base}/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
    }
    return {
      repo,
      branch,
      commit: commit.sha,
      files: files.length,
      created,
      url: `https://github.com/${info.full_name}/tree/${branch}`,
    };
  };

  const openPullRequest: GithubConnector["openPullRequest"] = async (input) => {
    const repo = normalizeRepo(input.repo);
    const head = normalizeBranch(input.head, "head branch");
    const title = input.title.trim();
    if (title === "") {
      throw new GithubError("A pull request needs a title.");
    }
    const baseBranch = normalizeBranch(
      input.base ?? (await repoInfo(repo)).default_branch,
      "base branch",
    );
    const pull = await call<{ number: number; html_url: string }>(
      "POST",
      `${repoPath(repo)}/pulls`,
      { title, head, base: baseBranch, body: input.body ?? "" },
    );
    return { number: pull.number, url: pull.html_url };
  };

  const merge: GithubConnector["merge"] = async (input) => {
    const repo = normalizeRepo(input.repo);
    // Checked again here, right before merging, and the merge names the head it checked: if a
    // new commit lands in between, GitHub refuses the merge instead of merging unchecked code.
    const verdict = await checks(repo, input.pullNumber);
    if (!verdict.green) {
      throw new GithubError(`Not merged: ${verdict.reason}.`);
    }
    const result = await call<{ sha: string; merged: boolean }>(
      "PUT",
      `${repoPath(repo)}/pulls/${input.pullNumber}/merge`,
      { merge_method: input.method ?? "merge", sha: verdict.headSha },
    );
    return { sha: result.sha, merged: result.merged };
  };

  const connector: GithubConnector = {
    isConnected() {
      return stored !== undefined || envToken() !== undefined;
    },
    async status() {
      const credential = await load();
      if (credential !== undefined) {
        return {
          connected: true,
          account: credential.account,
          source: "owner",
          connectedAt: credential.connectedAt,
          ...(credential.scopes === undefined ? {} : { scopes: credential.scopes }),
        };
      }
      return envToken() === undefined ? { connected: false } : { connected: true, source: "env" };
    },
    async connect(rawToken) {
      const value = rawToken.trim();
      if (value === "" || value.length > 500 || /\s/.test(value)) {
        throw new GithubError("Paste the GitHub token on its own, with no spaces.");
      }
      const { status, data, headers } = await request<{ login?: string }>(
        "GET",
        "/user",
        undefined,
        value,
      );
      if (status === 401 || status === 403) {
        throw new GithubError("GitHub did not accept that token. Check it and try again.");
      }
      if (status !== 200 || typeof data?.login !== "string") {
        throw new GithubError(
          `GitHub could not be reached to check the token (status ${status}).`,
          502,
        );
      }
      const scopes = headers
        .get("x-oauth-scopes")
        ?.split(",")
        .map((scope) => scope.trim())
        .filter((scope) => scope !== "");
      const credential: StoredCredential = {
        token: value,
        account: data.login,
        connectedAt: now().toISOString(),
        ...(scopes === undefined ? {} : { scopes }),
      };
      await mkdir(path.dirname(options.credentialPath), { recursive: true, mode: 0o700 });
      await writeFile(options.credentialPath, `${JSON.stringify(credential, null, 2)}\n`, {
        mode: 0o600,
      });
      await chmod(options.credentialPath, 0o600);
      stored = credential;
      loaded = true;
      return connector.status();
    },
    async disconnect() {
      await rm(options.credentialPath, { force: true });
      stored = undefined;
      loaded = true;
      return connector.status();
    },
    async repos() {
      const out: GithubRepoSummary[] = [];
      for (let page = 1; page <= 3; page += 1) {
        const batch = await call<
          {
            full_name: string;
            private: boolean;
            default_branch: string;
            permissions?: { push?: boolean };
          }[]
        >("GET", `/user/repos?per_page=100&sort=updated&page=${page}`);
        out.push(
          ...batch.map((repo) => ({
            fullName: repo.full_name.toLowerCase(),
            private: repo.private,
            defaultBranch: repo.default_branch,
            canPush: repo.permissions?.push === true,
          })),
        );
        if (batch.length < 100) {
          break;
        }
      }
      return out;
    },
    async readPath(repo, filePath, ref) {
      const clean = filePath.trim().replace(/^\/+/, "");
      if (clean.split("/").some((part) => part === "..")) {
        throw new GithubError('The path cannot contain "..".');
      }
      const encoded = clean
        .split("/")
        .filter((part) => part !== "")
        .map(encodeURIComponent)
        .join("/");
      const query = ref === undefined ? "" : `?ref=${encodeURIComponent(ref)}`;
      const data = await call<
        | { type: string; name: string; path: string; size: number }[]
        | { type: string; path: string; size: number; content?: string; encoding?: string }
      >("GET", `${repoPath(repo)}/contents/${encoded}${query}`);
      if (Array.isArray(data)) {
        return {
          path: clean,
          entries: data.map((entry) => ({
            name: entry.name,
            type: entry.type === "dir" ? "folder" : entry.type,
            size: entry.size,
          })),
        };
      }
      if (data.type !== "file" || data.content === undefined) {
        return { path: data.path, type: data.type, size: data.size };
      }
      const buffer = Buffer.from(data.content, "base64");
      if (buffer.includes(0)) {
        return { path: data.path, size: data.size, binary: true };
      }
      const content = buffer.toString("utf8");
      return {
        path: data.path,
        size: data.size,
        content: content.slice(0, MAX_READ_CHARS),
        ...(content.length > MAX_READ_CHARS ? { truncated: true } : {}),
      };
    },
    async listPullRequests(repo, state) {
      const pulls = await call<
        {
          number: number;
          title: string;
          state: string;
          draft?: boolean;
          html_url: string;
          head: { ref: string };
          base: { ref: string };
          user?: { login?: string };
        }[]
      >("GET", `${repoPath(repo)}/pulls?state=${state}&per_page=30`);
      return pulls.map((pull) => ({
        number: pull.number,
        title: pull.title,
        state: pull.state,
        draft: pull.draft === true,
        head: pull.head.ref,
        base: pull.base.ref,
        author: pull.user?.login,
        url: pull.html_url,
      }));
    },
    checks,
    async verifyGreenChecks(input) {
      if (typeof input !== "object" || input === null) {
        return false;
      }
      const record = input as Record<string, unknown>;
      const repo = repoOf(record);
      const number = pullNumberOf(record);
      if (repo === undefined || number === undefined) {
        return false;
      }
      try {
        return (await checks(repo, number)).green;
      } catch {
        return false;
      }
    },
    pushFolder,
    openPullRequest,
    merge,
    tools(root) {
      return createGithubTools(connector, root);
    },
  };
  void load();
  return connector;
}

// ---------------------------------------------------------------------------
// Agent tools
// ---------------------------------------------------------------------------

const REPO_PARAM = Type.String({ description: 'Repository as "owner/name".' });

const LIST_REPOS = Type.Object({});
const READ = Type.Object({
  repo: REPO_PARAM,
  path: Type.Optional(
    Type.String({ description: "File or folder in the repository. Default: its root." }),
  ),
  ref: Type.Optional(
    Type.String({ description: "Branch, tag or commit. Default: the default branch." }),
  ),
});
const LIST_PULLS = Type.Object({
  repo: REPO_PARAM,
  state: Type.Optional(
    Type.Union([Type.Literal("open"), Type.Literal("closed"), Type.Literal("all")]),
  ),
});
const PULL = Type.Object({
  repo: REPO_PARAM,
  pullNumber: Type.Integer({ minimum: 1 }),
});
const PUSH = Type.Object({
  repo: REPO_PARAM,
  branch: Type.String({
    description:
      "Branch to push to. Created from base if it does not exist. Never the default branch.",
  }),
  from: Type.String({
    description:
      "Folder in the company drive whose files are pushed, like drive/goals/abc/deliverables.",
  }),
  message: Type.String({ description: "Commit message." }),
  to: Type.Optional(Type.String({ description: "Folder in the repository. Default: its root." })),
  base: Type.Optional(
    Type.String({ description: "Branch a new branch starts from. Default: the default branch." }),
  ),
});
const OPEN_PULL = Type.Object({
  repo: REPO_PARAM,
  head: Type.String({ description: "Branch with the changes." }),
  title: Type.String(),
  body: Type.Optional(Type.String()),
  base: Type.Optional(
    Type.String({ description: "Branch to merge into. Default: the default branch." }),
  ),
});
const MERGE = Type.Object({
  repo: REPO_PARAM,
  pullNumber: Type.Integer({ minimum: 1 }),
  method: Type.Optional(
    Type.Union([Type.Literal("merge"), Type.Literal("squash"), Type.Literal("rebase")]),
  ),
});

const text = (value: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
  details: value,
});

function githubTool<TParams extends ReturnType<typeof Type.Object>>(
  spec: {
    readonly name: string;
    readonly label: string;
    readonly description: string;
    readonly parameters: TParams;
    readonly write: boolean;
  },
  run: (params: Static<TParams>) => Promise<unknown>,
): unknown {
  const tool = withAgentHarnessToolEffects(
    {
      name: spec.name,
      label: spec.label,
      description: spec.description,
      parameters: spec.parameters,
      async execute(_toolCallId: string, params: Static<TParams>) {
        return text(await run(params));
      },
    },
    {
      id: `github.${spec.name.replace(/^github_/, "")}`,
      label: spec.label,
      effects: spec.write ? ["external.write", "network.egress"] : ["mcp.read", "network.egress"],
      reversibility: spec.write ? "irreversible" : "reversible-cheap",
      retrySemantics: spec.write ? "retry-may-duplicate" : "safe-to-retry",
    },
  );
  // The permission gate reads this to tell GitHub calls apart and apply the owner's repo rules.
  return Object.assign(tool as object, {
    connector: { serverId: GITHUB_CONNECTOR_ID, toolName: spec.name },
  });
}

export function createGithubTools(connector: GithubConnector, root: string): readonly unknown[] {
  return [
    githubTool(
      {
        name: "github_list_repos",
        label: "List GitHub repositories",
        description:
          "List the GitHub repositories the company's connection can see, with whether it can push to each. Writing also needs the owner to have opened the repository for agents.",
        parameters: LIST_REPOS,
        write: false,
      },
      () => connector.repos(),
    ),
    githubTool(
      {
        name: "github_read",
        label: "Read from GitHub",
        description:
          "Read a file, or list a folder, in a GitHub repository. To work on a whole repository, clone it in the shell instead (public repositories only; the shell has no GitHub credentials).",
        parameters: READ,
        write: false,
      },
      (params) => connector.readPath(params.repo, params.path ?? "", params.ref),
    ),
    githubTool(
      {
        name: "github_list_pull_requests",
        label: "List pull requests",
        description: "List pull requests in a GitHub repository.",
        parameters: LIST_PULLS,
        write: false,
      },
      (params) => connector.listPullRequests(params.repo, params.state ?? "open"),
    ),
    githubTool(
      {
        name: "github_pull_request_checks",
        label: "Check a pull request",
        description:
          "Whether every check on a pull request has passed. A merge only goes through when they have.",
        parameters: PULL,
        write: false,
      },
      (params) => connector.checks(params.repo, params.pullNumber),
    ),
    githubTool(
      {
        name: "github_push_branch",
        label: "Push to a GitHub branch",
        description:
          "Commit the files of a company drive folder to a branch of a GitHub repository, creating the branch if needed. Only in repositories the owner opened for writing, and never to the default branch; open a pull request to bring the work in.",
        parameters: PUSH,
        write: true,
      },
      (params) =>
        connector.pushFolder({
          root,
          from: params.from,
          repo: params.repo,
          branch: params.branch,
          message: params.message,
          ...(params.to === undefined ? {} : { to: params.to }),
          ...(params.base === undefined ? {} : { base: params.base }),
        }),
    ),
    githubTool(
      {
        name: "github_open_pull_request",
        label: "Open a pull request",
        description:
          "Open a pull request from a branch. Only in repositories the owner opened for writing.",
        parameters: OPEN_PULL,
        write: true,
      },
      (params) =>
        connector.openPullRequest({
          repo: params.repo,
          head: params.head,
          title: params.title,
          ...(params.body === undefined ? {} : { body: params.body }),
          ...(params.base === undefined ? {} : { base: params.base }),
        }),
    ),
    githubTool(
      {
        name: "github_merge_pull_request",
        label: "Merge a pull request",
        description:
          "Merge a pull request once every check on it is green. Only in repositories the owner opened for writing. If checks are still running, wait and check again with github_pull_request_checks.",
        parameters: MERGE,
        write: true,
      },
      (params) =>
        connector.merge({
          repo: params.repo,
          pullNumber: params.pullNumber,
          ...(params.method === undefined ? {} : { method: params.method }),
        }),
    ),
  ];
}
