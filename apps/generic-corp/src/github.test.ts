import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createMemoryAuthStore } from "@generic-ai/plugin-auth-identity";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_COMPANY } from "./company.js";

import { createGithubConnector, type GithubFetch } from "./github.js";
import { DEFAULT_PERMISSIONS, gateToolsWithPermissions } from "./permissions.js";
import type { RefusalLog, RefusedAction, RefusedActionInput } from "./refusals.js";
import { createGenericCorpServer } from "./server.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "generic-corp-github-"));
  dirs.push(dir);
  return dir;
}

interface FakeCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

/**
 * An in-memory stand-in for the parts of the GitHub REST API the connector uses. No test talks
 * to the real GitHub.
 */
export function createFakeGithub(options: { token?: string } = {}) {
  const token = options.token ?? "github_pat_test_token_123456";
  const repos = new Map<
    string,
    { defaultBranch: string; refs: Map<string, string>; private: boolean; push: boolean }
  >();
  const commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  const trees = new Map<string, Map<string, string>>();
  const blobs = new Map<string, string>();
  const pulls = new Map<
    string,
    {
      number: number;
      head: string;
      base: string;
      title: string;
      state: string;
      draft: boolean;
      merged: boolean;
    }
  >();
  const checkRuns = new Map<string, FakeCheckRun[]>();
  const statuses = new Map<string, { state: string; total_count: number }>();
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let counter = 0;
  const id = (prefix: string) => {
    counter += 1;
    return `${prefix}${counter.toString(16).padStart(8, "0")}`;
  };

  const addRepo = (fullName: string, init: { private?: boolean; push?: boolean } = {}) => {
    const tree = id("tree");
    trees.set(tree, new Map([["README.md", "blob-readme"]]));
    blobs.set("blob-readme", Buffer.from("# Hello\n").toString("base64"));
    const commit = id("commit");
    commits.set(commit, { tree, parents: [], message: "init" });
    repos.set(fullName, {
      defaultBranch: "main",
      refs: new Map([["main", commit]]),
      private: init.private ?? false,
      push: init.push ?? true,
    });
  };

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(body === undefined ? "" : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

  const fetch: GithubFetch = async (url, init) => {
    const parsed = new URL(url);
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: `${parsed.pathname}${parsed.search}`, body });
    const auth = new Headers(init.headers).get("authorization");
    if (auth !== `Bearer ${token}`) {
      return json(401, { message: "Bad credentials" });
    }
    const p = parsed.pathname;
    if (p === "/user") {
      return json(200, { login: "neill" }, { "x-oauth-scopes": "repo, read:org" });
    }
    if (p === "/user/repos") {
      return json(
        200,
        [...repos].map(([fullName, repo]) => ({
          full_name: fullName,
          private: repo.private,
          default_branch: repo.defaultBranch,
          permissions: { push: repo.push },
        })),
      );
    }
    const match = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(p);
    if (match === null) {
      return json(404, { message: "Not Found" });
    }
    const fullName = `${match[1]}/${match[2]}`;
    const repo = repos.get(fullName);
    if (repo === undefined) {
      return json(404, { message: "Not Found" });
    }
    const rest = match[3] ?? "";
    if (rest === "") {
      return json(200, {
        full_name: fullName,
        default_branch: repo.defaultBranch,
        private: repo.private,
        permissions: { push: repo.push },
      });
    }
    let m = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
    if (m !== null && method === "GET") {
      const sha = repo.refs.get(m[1] as string);
      return sha === undefined
        ? json(404, { message: "Not Found" })
        : json(200, { object: { sha } });
    }
    m = /^\/git\/commits\/(.+)$/.exec(rest);
    if (m !== null && method === "GET") {
      const commit = commits.get(m[1] as string);
      return commit === undefined
        ? json(404, { message: "Not Found" })
        : json(200, { tree: { sha: commit.tree } });
    }
    if (rest === "/git/blobs" && method === "POST") {
      const sha = id("blob");
      blobs.set(sha, body.content);
      return json(201, { sha });
    }
    if (rest === "/git/trees" && method === "POST") {
      const sha = id("tree");
      const files = new Map(trees.get(body.base_tree) ?? []);
      for (const entry of body.tree as { path: string; sha: string }[]) {
        files.set(entry.path, entry.sha);
      }
      trees.set(sha, files);
      return json(201, { sha });
    }
    if (rest === "/git/commits" && method === "POST") {
      const sha = id("commit");
      commits.set(sha, { tree: body.tree, parents: body.parents, message: body.message });
      return json(201, { sha });
    }
    if (rest === "/git/refs" && method === "POST") {
      repo.refs.set(String(body.ref).replace("refs/heads/", ""), body.sha);
      return json(201, {});
    }
    m = /^\/git\/refs\/heads\/(.+)$/.exec(rest);
    if (m !== null && method === "PATCH") {
      repo.refs.set(m[1] as string, body.sha);
      return json(200, {});
    }
    m = /^\/contents\/?(.*)$/.exec(rest);
    if (m !== null && method === "GET") {
      const ref = parsed.searchParams.get("ref") ?? repo.defaultBranch;
      const commit = commits.get(repo.refs.get(ref) ?? "");
      const files = trees.get(commit?.tree ?? "") ?? new Map<string, string>();
      const wanted = decodeURIComponent(m[1] ?? "");
      const blob = files.get(wanted);
      if (blob !== undefined) {
        const content = blobs.get(blob) ?? "";
        return json(200, {
          type: "file",
          path: wanted,
          size: Buffer.from(content, "base64").byteLength,
          content,
          encoding: "base64",
        });
      }
      const prefix = wanted === "" ? "" : `${wanted}/`;
      const names = new Map<string, string>();
      for (const file of files.keys()) {
        if (file.startsWith(prefix)) {
          const [name, ...more] = file.slice(prefix.length).split("/");
          names.set(name as string, more.length > 0 ? "dir" : "file");
        }
      }
      if (names.size === 0) {
        return json(404, { message: "Not Found" });
      }
      return json(
        200,
        [...names].map(([name, type]) => ({ name, type, path: `${prefix}${name}`, size: 0 })),
      );
    }
    if (rest === "/pulls" && method === "POST") {
      const number = pulls.size + 1;
      pulls.set(`${fullName}#${number}`, {
        number,
        head: body.head,
        base: body.base,
        title: body.title,
        state: "open",
        draft: false,
        merged: false,
      });
      return json(201, { number, html_url: `https://github.com/${fullName}/pull/${number}` });
    }
    if (rest.startsWith("/pulls") && method === "GET" && !/\/pulls\/\d+/.test(rest)) {
      return json(
        200,
        [...pulls.values()].map((pull) => ({
          number: pull.number,
          title: pull.title,
          state: pull.state,
          draft: pull.draft,
          html_url: `https://github.com/${fullName}/pull/${pull.number}`,
          head: { ref: pull.head },
          base: { ref: pull.base },
          user: { login: "agent" },
        })),
      );
    }
    m = /^\/pulls\/(\d+)(\/merge)?$/.exec(rest);
    if (m !== null) {
      const pull = pulls.get(`${fullName}#${m[1]}`);
      if (pull === undefined) {
        return json(404, { message: "Not Found" });
      }
      const headSha = repo.refs.get(pull.head) ?? "";
      if (m[2] === undefined) {
        return json(200, {
          state: pull.state,
          draft: pull.draft,
          merged: pull.merged,
          head: { sha: headSha },
        });
      }
      if (body.sha !== headSha) {
        return json(409, { message: "Head branch was modified" });
      }
      pull.merged = true;
      pull.state = "closed";
      repo.refs.set(pull.base, headSha);
      return json(200, { sha: headSha, merged: true });
    }
    m = /^\/commits\/([^/]+)\/check-runs$/.exec(rest);
    if (m !== null) {
      const runs = checkRuns.get(m[1] as string) ?? [];
      return json(200, { total_count: runs.length, check_runs: runs });
    }
    m = /^\/commits\/([^/]+)\/status$/.exec(rest);
    if (m !== null) {
      return json(200, statuses.get(m[1] as string) ?? { state: "pending", total_count: 0 });
    }
    return json(404, { message: "Not Found" });
  };

  return {
    token,
    fetch,
    calls,
    addRepo,
    repos,
    pulls,
    fileAt(fullName: string, branch: string, filePath: string): string | undefined {
      const repo = repos.get(fullName);
      const commit = commits.get(repo?.refs.get(branch) ?? "");
      const blob = trees.get(commit?.tree ?? "")?.get(filePath);
      return blob === undefined
        ? undefined
        : Buffer.from(blobs.get(blob) ?? "", "base64").toString();
    },
    setChecks(fullName: string, branch: string, runs: FakeCheckRun[]) {
      checkRuns.set(repos.get(fullName)?.refs.get(branch) ?? "", runs);
    },
  };
}

function memoryRefusals(): RefusalLog & { entries: RefusedAction[] } {
  const entries: RefusedAction[] = [];
  return {
    entries,
    async record(input: RefusedActionInput) {
      const entry = { id: String(entries.length), at: new Date(0).toISOString(), ...input };
      entries.unshift(entry);
      return entry;
    },
    async list() {
      return entries;
    },
  };
}

type Tool = {
  name: string;
  execute(id: string, params: unknown): Promise<{ details: unknown }>;
};

describe("the GitHub connector", () => {
  it("connects with a token kept in an owner-only file, lists repos, and disconnects", async () => {
    const github = createFakeGithub();
    github.addRepo("acme/site", { private: true });
    const credentialPath = path.join(tempDir(), "connectors", "github.json");
    const connector = createGithubConnector({ credentialPath, env: {}, fetch: github.fetch });

    expect(await connector.status()).toEqual({ connected: false });
    expect(connector.isConnected()).toBe(false);
    await expect(connector.connect("wrong-token")).rejects.toThrow(/did not accept/);

    const connected = await connector.connect(` ${github.token} `);
    expect(connected).toMatchObject({ connected: true, account: "neill", source: "owner" });
    expect(connected.scopes).toEqual(["repo", "read:org"]);
    expect(connector.isConnected()).toBe(true);
    expect(statSync(credentialPath).mode & 0o777).toBe(0o600);

    // A fresh connector (a restart) reads the stored credential.
    const restarted = createGithubConnector({ credentialPath, env: {}, fetch: github.fetch });
    expect((await restarted.status()).account).toBe("neill");
    expect(await restarted.repos()).toEqual([
      { fullName: "acme/site", private: true, defaultBranch: "main", canPush: true },
    ]);

    expect(await restarted.disconnect()).toEqual({ connected: false });
    await expect(restarted.repos()).rejects.toThrow(/not connected/);
  });

  it("pushes a drive folder to a new branch, never the default branch or outside the drive", async () => {
    const github = createFakeGithub();
    github.addRepo("acme/site");
    const root = tempDir();
    const folder = path.join(root, "drive", "goals", "g1", "deliverables");
    mkdirSync(path.join(folder, "img"), { recursive: true });
    writeFileSync(path.join(folder, "report.md"), "# Q3\n");
    writeFileSync(path.join(folder, "img", "chart.svg"), "<svg/>");
    writeFileSync(path.join(root, "secret.txt"), "do not push");
    symlinkSync(path.join(root, "secret.txt"), path.join(folder, "leak.txt"));
    const connector = createGithubConnector({
      credentialPath: path.join(tempDir(), "github.json"),
      env: { GENERIC_CORP_GITHUB_TOKEN: github.token },
      fetch: github.fetch,
    });

    const pushed = await connector.pushFolder({
      root,
      from: "drive/goals/g1/deliverables",
      repo: "Acme/Site",
      branch: "reports/q3",
      message: "Add the Q3 report",
      to: "docs",
    });
    expect(pushed).toMatchObject({
      repo: "acme/site",
      branch: "reports/q3",
      files: 2,
      created: true,
    });
    expect(github.fileAt("acme/site", "reports/q3", "docs/report.md")).toBe("# Q3\n");
    expect(github.fileAt("acme/site", "reports/q3", "docs/img/chart.svg")).toBe("<svg/>");
    expect(github.fileAt("acme/site", "reports/q3", "docs/leak.txt")).toBeUndefined();
    expect(github.fileAt("acme/site", "reports/q3", "README.md")).toBe("# Hello\n");
    expect(github.fileAt("acme/site", "main", "docs/report.md")).toBeUndefined();

    // A second push to the same branch adds a commit on top.
    writeFileSync(path.join(folder, "report.md"), "# Q3, revised\n");
    const again = await connector.pushFolder({
      root,
      from: "drive/goals/g1/deliverables",
      repo: "acme/site",
      branch: "reports/q3",
      message: "Revise",
    });
    expect(again.created).toBe(false);
    expect(github.fileAt("acme/site", "reports/q3", "report.md")).toBe("# Q3, revised\n");

    await expect(
      connector.pushFolder({
        root,
        from: "drive",
        repo: "acme/site",
        branch: "main",
        message: "x",
      }),
    ).rejects.toThrow(/not main, the default branch/);
    await expect(
      connector.pushFolder({ root, from: "..", repo: "acme/site", branch: "b", message: "x" }),
    ).rejects.toThrow(/outside the company drive/);
    await expect(
      connector.pushFolder({
        root,
        from: "drive",
        repo: "acme/site",
        branch: "a..b",
        message: "x",
      }),
    ).rejects.toThrow(/branch name is not valid/);
  });

  it("merges only when every check on the pull request is green", async () => {
    const github = createFakeGithub();
    github.addRepo("acme/site");
    const root = tempDir();
    mkdirSync(path.join(root, "work"));
    writeFileSync(path.join(root, "work", "a.txt"), "a");
    const connector = createGithubConnector({
      credentialPath: path.join(tempDir(), "github.json"),
      env: { GENERIC_CORP_GITHUB_TOKEN: github.token },
      fetch: github.fetch,
    });
    await connector.pushFolder({
      root,
      from: "work",
      repo: "acme/site",
      branch: "feat",
      message: "a",
    });
    const pull = await connector.openPullRequest({
      repo: "acme/site",
      head: "feat",
      title: "Add a",
    });
    expect(pull).toEqual({ number: 1, url: "https://github.com/acme/site/pull/1" });

    expect(await connector.checks("acme/site", 1)).toMatchObject({
      green: false,
      reason: "no checks ran on the pull request",
    });
    github.setChecks("acme/site", "feat", [
      { name: "test", status: "in_progress", conclusion: null },
    ]);
    expect((await connector.checks("acme/site", 1)).reason).toBe("checks are still running (test)");
    github.setChecks("acme/site", "feat", [
      { name: "test", status: "completed", conclusion: "failure" },
      { name: "lint", status: "completed", conclusion: "success" },
    ]);
    expect((await connector.checks("acme/site", 1)).reason).toBe("checks are not all green (test)");
    await expect(connector.merge({ repo: "acme/site", pullNumber: 1 })).rejects.toThrow(
      /Not merged: checks are not all green/,
    );
    expect(await connector.verifyGreenChecks({ repo: "acme/site", pullNumber: 1 })).toBe(false);

    github.setChecks("acme/site", "feat", [
      { name: "test", status: "completed", conclusion: "success" },
      { name: "docs", status: "completed", conclusion: "skipped" },
    ]);
    expect(await connector.verifyGreenChecks({ owner: "acme", repo: "site", pull_number: 1 })).toBe(
      true,
    );
    expect(await connector.merge({ repo: "acme/site", pullNumber: 1 })).toMatchObject({
      merged: true,
    });
    expect(github.fileAt("acme/site", "main", "a.txt")).toBe("a");
    const mergeCall = github.calls.find((call) => call.path.endsWith("/merge"));
    expect(mergeCall?.body).toMatchObject({ merge_method: "merge" });
    expect((mergeCall?.body as { sha?: string }).sha).toBeTruthy();
  });

  it("reads files and folders, and lists pull requests", async () => {
    const github = createFakeGithub();
    github.addRepo("acme/site");
    const connector = createGithubConnector({
      credentialPath: path.join(tempDir(), "github.json"),
      env: { GENERIC_CORP_GITHUB_TOKEN: github.token },
      fetch: github.fetch,
    });
    expect(await connector.readPath("acme/site", "README.md")).toMatchObject({
      content: "# Hello\n",
    });
    expect(await connector.readPath("acme/site", "")).toMatchObject({
      entries: [{ name: "README.md", type: "file" }],
    });
    await expect(connector.readPath("acme/site", "../x")).rejects.toThrow(/cannot contain/);
    expect(await connector.listPullRequests("acme/site", "open")).toEqual([]);
  });
});

describe("GitHub tools behind the owner's permissions", () => {
  it("writes only in repos the owner opened, and merges only with green checks", async () => {
    const github = createFakeGithub();
    github.addRepo("acme/site");
    github.addRepo("acme/other");
    const root = tempDir();
    mkdirSync(path.join(root, "work"));
    writeFileSync(path.join(root, "work", "a.txt"), "a");
    const connector = createGithubConnector({
      credentialPath: path.join(tempDir(), "github.json"),
      env: { GENERIC_CORP_GITHUB_TOKEN: github.token },
      fetch: github.fetch,
    });
    let permissions = DEFAULT_PERMISSIONS;
    const refusals = memoryRefusals();
    const gated = gateToolsWithPermissions({ customTools: connector.tools(root) } as never, {
      permissions: () => permissions,
      refusals,
      agentId: "eng",
      verifyGreenChecks: (input) => connector.verifyGreenChecks(input),
    }) as unknown as { customTools: Tool[] };
    const tool = (name: string) => {
      const found = gated.customTools.find((candidate) => candidate.name === name);
      if (found === undefined) {
        throw new Error(`no tool ${name}`);
      }
      return found;
    };
    const push = { repo: "acme/site", branch: "feat", from: "work", message: "a" };

    // Reading is on by default; writing is off until the owner opens a repo (none by default).
    expect(
      (await tool("github_read").execute("1", { repo: "acme/other", path: "README.md" })).details,
    ).toMatchObject({
      content: "# Hello\n",
    });
    await expect(tool("github_push_branch").execute("2", push)).rejects.toThrow(
      /Refused: the owner has not opened acme\/site for agents to write to/,
    );
    expect(refusals.entries[0]).toMatchObject({
      kind: "permission",
      agentId: "eng",
      category: "github",
      action: "github_push_branch",
    });

    permissions = {
      ...DEFAULT_PERMISSIONS,
      github: { ...DEFAULT_PERMISSIONS.github, repos: ["acme/site"] },
    };
    await tool("github_push_branch").execute("3", push);
    await expect(
      tool("github_push_branch").execute("4", { ...push, repo: "acme/other" }),
    ).rejects.toThrow(/Refused/);
    await tool("github_open_pull_request").execute("5", {
      repo: "acme/site",
      head: "feat",
      title: "Add a",
    });

    await expect(
      tool("github_merge_pull_request").execute("6", { repo: "acme/site", pullNumber: 1 }),
    ).rejects.toThrow(/Refused: the pull request's checks are not all green/);
    expect(github.repos.get("acme/site")?.refs.get("main")).not.toBe(
      github.repos.get("acme/site")?.refs.get("feat"),
    );

    github.setChecks("acme/site", "feat", [
      { name: "ci", status: "completed", conclusion: "success" },
    ]);
    await tool("github_merge_pull_request").execute("7", { repo: "acme/site", pullNumber: 1 });
    expect(github.fileAt("acme/site", "main", "a.txt")).toBe("a");

    // The owner can switch merging off while leaving pushes on.
    permissions = {
      ...permissions,
      github: { ...permissions.github, merge: false },
    };
    await expect(
      tool("github_merge_pull_request").execute("8", { repo: "acme/site", pullNumber: 1 }),
    ).rejects.toThrow(/not allowed agents to merge/);
  });
});

describe("the GitHub connector API", () => {
  it("connects, shows the repo picker, pushes deliverables and opens a pull request", async () => {
    const github = createFakeGithub();
    github.addRepo("acme/site");
    github.addRepo("acme/other");
    const dataDir = tempDir();
    const server = await createGenericCorpServer({
      environment: {
        host: "127.0.0.1",
        port: 0,
        dataDir,
        trustProxyHeaders: false,
        insecureNoAuth: true,
        workers: false,
      },
      env: {},
      company: DEFAULT_COMPANY,
      executor: () => ({ status: "succeeded", outputText: "ok" }),
      github: createGithubConnector({
        credentialPath: path.join(dataDir, "connectors", "github.json"),
        env: {},
        fetch: github.fetch,
      }),
      authStore: createMemoryAuthStore(),
      log: () => undefined,
    });
    try {
      const call = async (method: string, pathname: string, body?: unknown) => {
        const response = await server.fetch(
          new Request(`http://127.0.0.1/api${pathname}`, {
            method,
            headers: { "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
        return {
          status: response.status,
          body: (await response.json()) as Record<string, unknown>,
        };
      };

      expect((await call("GET", "/connectors/github")).body).toEqual({
        connected: false,
        repos: [],
      });
      const bad = await call("POST", "/connectors/github", { token: "nope" });
      expect(bad.status).toBe(400);
      expect(bad.body["error"]).toMatch(/did not accept/);

      const connected = await call("POST", "/connectors/github", { token: github.token });
      expect(connected.status).toBe(200);
      expect(connected.body).toMatchObject({ connected: true, account: "neill" });
      // Read-only by default: no repo is open for agents to write to.
      expect(connected.body["repos"]).toEqual([
        expect.objectContaining({ fullName: "acme/site", writable: false }),
        expect.objectContaining({ fullName: "acme/other", writable: false }),
      ]);
      expect(JSON.stringify(connected.body)).not.toContain(github.token);

      await call("PUT", "/permissions", { github: { repos: ["acme/site"] } });
      const picked = await call("GET", "/connectors/github");
      expect(picked.body["repos"]).toEqual([
        expect.objectContaining({ fullName: "acme/site", writable: true }),
        expect.objectContaining({ fullName: "acme/other", writable: false }),
      ]);

      const deliverables = path.join(dataDir, "company", "drive", "goals", "g1", "deliverables");
      mkdirSync(deliverables, { recursive: true });
      writeFileSync(path.join(deliverables, "brief.md"), "# Brief\n");
      const pushed = await call("POST", "/connectors/github/push", {
        goalId: "g1",
        repo: "acme/site",
        branch: "deliverables/g1",
        openPullRequest: { title: "Brief for g1" },
      });
      expect(pushed.status).toBe(200);
      expect(pushed.body).toMatchObject({
        pushed: { repo: "acme/site", branch: "deliverables/g1", files: 1 },
        pullRequest: { number: 1 },
      });
      expect(github.fileAt("acme/site", "deliverables/g1", "brief.md")).toBe("# Brief\n");

      const missing = await call("POST", "/connectors/github/push", {
        goalId: "nope",
        repo: "acme/site",
        branch: "x",
      });
      expect(missing.status).toBe(404);
      expect(missing.body["error"]).toMatch(/no folder/);

      expect((await call("DELETE", "/connectors/github")).body).toEqual({
        connected: false,
        repos: [],
      });
    } finally {
      await server.stop();
    }
  });
});
