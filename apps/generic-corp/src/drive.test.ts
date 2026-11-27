import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createMemoryAuthStore } from "@generic-ai/plugin-auth-identity";
import type { AgentTaskExecutionInput, AgentTaskExecutor } from "@generic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  type CompanyConfig,
  companyLayout,
  createCompanyDrive,
  createGenericCorpServer,
  type DeliverableShelfEntry,
  type DriveEntry,
  DriveError,
  type GenericCorpServer,
  withDriveSection,
} from "./index.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "generic-corp-drive-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe("company drive", () => {
  it("lays out the shared drive and agent homes under one company root", async () => {
    const dataDir = tempDir();
    const layout = companyLayout(dataDir);
    expect(layout.root).toBe(path.join(dataDir, "company"));
    const drive = createCompanyDrive({ layout });
    await drive.ensure();
    expect(existsSync(path.join(layout.root, "drive", "inbox"))).toBe(true);
    expect(existsSync(path.join(layout.root, "drive", "goals"))).toBe(true);
    expect(existsSync(layout.agentsRoot)).toBe(true);
  });

  it("writes, lists, reads and removes owner files inside the drive only", async () => {
    const drive = createCompanyDrive({ layout: companyLayout(tempDir()) });
    await drive.ensure();
    const entry = await drive.write("notes/plan.md", bytes("# Plan"));
    expect(entry).toMatchObject({
      path: "drive/notes/plan.md",
      kind: "file",
      size: 6,
      mimeType: "text/markdown",
    });
    await expect(drive.write("drive/notes/plan.md", bytes("again"))).rejects.toMatchObject({
      code: "exists",
    });
    await drive.write("drive/notes/plan.md", bytes("# Plan v2"), { overwrite: true });
    expect(readFileSync((await drive.file("drive/notes/plan.md")).absolutePath, "utf8")).toBe(
      "# Plan v2",
    );

    const top = await drive.list();
    expect(top.map((item) => item.path)).toEqual(["drive/goals", "drive/inbox", "drive/notes"]);

    for (const bad of ["../company.sqlite", "drive/../../secret", "a/\0b"]) {
      await expect(drive.write(bad, bytes("x"))).rejects.toBeInstanceOf(DriveError);
    }
    await expect(drive.remove("drive/notes")).rejects.toMatchObject({ code: "not_empty" });
    await drive.remove("drive/notes/plan.md");
    await drive.remove("drive/notes");
    await expect(drive.remove("drive/inbox")).rejects.toMatchObject({ code: "invalid" });
  });

  it("refuses symlinks that lead out of the drive", async () => {
    const dataDir = tempDir();
    writeFileSync(path.join(dataDir, "company.sqlite"), "server data");
    const layout = companyLayout(dataDir);
    const drive = createCompanyDrive({ layout });
    await drive.ensure();
    symlinkSync(path.join(dataDir, "company.sqlite"), path.join(layout.driveRoot, "db"));
    symlinkSync(dataDir, path.join(layout.driveRoot, "data"));
    await expect(drive.file("drive/db")).rejects.toMatchObject({ code: "outside" });
    await expect(drive.write("drive/data/planted", bytes("x"))).rejects.toMatchObject({
      code: "outside",
    });
    expect(existsSync(path.join(dataDir, "planted"))).toBe(false);
    expect((await drive.list()).map((item) => item.name)).not.toContain("db");
    expect(await drive.resolveAgentPath("drive/db")).toBeUndefined();
  });

  it("resolves the paths agents use, confined to the company root", async () => {
    const layout = companyLayout(tempDir());
    const drive = createCompanyDrive({ layout });
    await drive.ensure();
    mkdirSync(path.join(layout.agentsRoot, "ceo", "workspace"), { recursive: true });
    const real = (relative: string) => path.join(layout.root, relative);
    expect(await drive.resolveAgentPath("drive/goals/g1/deliverables/brief.md")).toBe(
      real("drive/goals/g1/deliverables/brief.md"),
    );
    expect(await drive.resolveAgentPath("goals/g1/brief.md")).toBe(real("drive/goals/g1/brief.md"));
    expect(await drive.resolveAgentPath("agents/ceo/workspace/notes.md")).toBe(
      real("agents/ceo/workspace/notes.md"),
    );
    expect(await drive.resolveAgentPath(real("drive/x.md"))).toBe(real("drive/x.md"));
    expect(await drive.resolveAgentPath("/etc/passwd")).toBeUndefined();
    expect(await drive.resolveAgentPath("../company.sqlite")).toBeUndefined();
    expect(await drive.resolveDrivePath("agents/ceo/workspace/notes.md")).toBeUndefined();
  });

  it("names inbox files so nothing is overwritten", async () => {
    const drive = createCompanyDrive({ layout: companyLayout(tempDir()) });
    await drive.ensure();
    const first = await drive.addToInbox("report.pdf", bytes("1"));
    const second = await drive.addToInbox("report.pdf", bytes("2"));
    const nested = await drive.addToInbox("../../evil/name.txt", bytes("3"));
    expect([first.path, second.path, nested.path]).toEqual([
      "drive/inbox/report.pdf",
      "drive/inbox/report (2).pdf",
      "drive/inbox/name.txt",
    ]);
  });

  it("keeps an abandoned goal's work and marks it", async () => {
    const drive = createCompanyDrive({ layout: companyLayout(tempDir()) });
    await drive.ensure();
    await drive.openGoal({ goalId: "g1", title: "Write the brief" });
    await drive.write("drive/goals/g1/deliverables/brief.md", bytes("half a brief"));
    await drive.openGoal({ goalId: "g2", title: "Plan the launch" });
    await drive.write("drive/goals/g2/deliverables/plan/launch.md", bytes("plan"));

    const abandoned = await drive.closeGoal("g1", "abandoned", "Changed my mind.");
    expect(abandoned).toMatchObject({ status: "abandoned", reason: "Changed my mind." });
    await drive.closeGoal("g2", "done");
    const note = readFileSync(
      (await drive.file("drive/goals/g1/ABANDONED.md")).absolutePath,
      "utf8",
    );
    expect(note).toContain("Changed my mind.");
    expect((await drive.file("drive/goals/g1/deliverables/brief.md")).entry.size).toBe(12);

    const shelf = await drive.deliverables();
    const byId = Object.fromEntries(shelf.map((goal) => [goal.goalId, goal]));
    expect(byId["g1"]).toMatchObject({ status: "abandoned", title: "Write the brief" });
    expect(byId["g1"]?.files.map((file) => file.path)).toEqual([
      "drive/goals/g1/deliverables/brief.md",
    ]);
    expect(byId["g2"]?.files.map((file) => file.path)).toEqual([
      "drive/goals/g2/deliverables/plan/launch.md",
    ]);
    expect(await drive.closeGoal("unknown", "done")).toBeUndefined();
  });

  it("puts the drive section before the task in a prompt", () => {
    expect(withDriveSection("intro\n\n## Task t1\ndo it", "## The company drive")).toBe(
      "intro\n\n## The company drive\n\n## Task t1\ndo it",
    );
    expect(withDriveSection("no task", "drive")).toBe("no task\n\ndrive");
  });
});

const COMPANY: CompanyConfig = {
  name: "Drive Corp",
  agents: [
    { id: "ceo", role: "ceo", title: "CEO" },
    { id: "writer", role: "writer", reportsTo: "ceo" },
  ],
};

async function startServer(executor: AgentTaskExecutor): Promise<GenericCorpServer> {
  const server = await createGenericCorpServer({
    environment: {
      host: "127.0.0.1",
      port: 0,
      dataDir: tempDir(),
      trustProxyHeaders: false,
      insecureNoAuth: true,
      workers: false,
    },
    company: COMPANY,
    executor,
    authStore: createMemoryAuthStore(),
    log: () => undefined,
  });
  cleanups.push(() => server.stop());
  return server;
}

describe("drive API", () => {
  it("lets the owner upload, browse, preview, download and delete drive files", async () => {
    const server = await startServer(async () => ({ status: "succeeded", outputText: "ok" }));
    const call = (url: string, init?: RequestInit) =>
      server.fetch(new Request(`http://local${url}`, init));

    const upload = await call("/api/drive/file?path=drive/reports/q3.md", {
      method: "PUT",
      body: "# Q3",
    });
    expect(upload.status).toBe(201);
    expect(((await upload.json()) as { entry: DriveEntry }).entry.path).toBe("drive/reports/q3.md");
    expect(
      (await call("/api/drive/file?path=drive/reports/q3.md", { method: "PUT", body: "x" })).status,
    ).toBe(409);

    const listing = (await (await call("/api/drive?path=drive/reports")).json()) as {
      entries: DriveEntry[];
    };
    expect(listing.entries.map((entry) => entry.name)).toEqual(["q3.md"]);

    const preview = await call("/api/drive/file?path=drive/reports/q3.md");
    expect(preview.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(preview.headers.get("content-disposition")).toMatch(/^inline/);
    expect(await preview.text()).toBe("# Q3");
    const download = await call("/api/drive/file?path=drive/reports/q3.md&download=1");
    expect(download.headers.get("content-disposition")).toMatch(/^attachment/);

    await call("/api/drive/file?path=drive/page.html", {
      method: "PUT",
      body: "<script>alert(1)</script>",
    });
    const html = await call("/api/drive/file?path=drive/page.html");
    expect(html.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(html.headers.get("content-security-policy")).toContain("sandbox");

    expect((await call("/api/drive/file?path=../company.sqlite")).status).toBe(400);
    expect((await call("/api/drive/file?path=drive/missing.md")).status).toBe(404);
    expect((await call("/api/drive?path=drive/reports/q3.md", { method: "DELETE" })).status).toBe(
      200,
    );
    expect((await call("/api/drive/file?path=drive/reports/q3.md")).status).toBe(404);
  });

  it("accepts files larger than the JSON body limit", async () => {
    const server = await startServer(async () => ({ status: "succeeded", outputText: "ok" }));
    const big = new Uint8Array(1024 * 1024).fill(65);
    const response = await server.fetch(
      new Request("http://local/api/drive/inbox?name=big.txt", { method: "POST", body: big }),
    );
    expect(response.status).toBe(201);
  });

  it("hands chat attachments to the CEO and keeps a cancelled goal's work", async () => {
    const prompts: AgentTaskExecutionInput[] = [];
    const server = await startServer(async (input) => {
      prompts.push(input);
      const use = (name: string, params: Record<string, unknown>) =>
        input.tools
          ?.find((tool) => tool.name === name)
          ?.execute(params as never, {
            toolCallId: name,
          });
      // Every request gets a goal the CEO drafts, and work is handed in with submit_work.
      await use("set_goal", {
        objective: "Summarise the brief.",
        definitionOfDone: ["A summary is handed in."],
        validators: [
          {
            id: "handed-in",
            kind: "output_schema",
            schema: { type: "object", required: ["summary"] },
          },
        ],
      });
      await use("submit_work", { summary: "Read it.", deliverables: [] });
      return { status: "succeeded", outputText: "Read it." };
    });
    const call = (url: string, init?: RequestInit) =>
      server.fetch(new Request(`http://local${url}`, init));
    const dropped = (await (
      await call("/api/drive/inbox?name=brief.pdf", { method: "POST", body: "%PDF" })
    ).json()) as { entry: DriveEntry };

    const created = await call("/api/threads", {
      method: "POST",
      body: JSON.stringify({ text: "Summarise this", attachments: [dropped.entry.path] }),
    });
    expect(created.status).toBe(201);
    const { thread, taskId } = (await created.json()) as {
      thread: { exchanges: { message: { attachments?: string[] } }[] };
      taskId: string;
    };
    expect(thread.exchanges[0]?.message.attachments).toEqual(["drive/inbox/brief.pdf"]);
    await server.runtime.cascade.drain();
    const prompt = prompts[0]?.prompt ?? "";
    expect(prompt).toContain("- drive/inbox/brief.pdf (4 B, application/pdf)");
    expect(prompt).toContain(`drive/goals/${taskId}/deliverables/`);
    expect(prompt.indexOf("## The company drive")).toBeLessThan(prompt.indexOf("## Task "));

    const bad = await call("/api/threads", {
      method: "POST",
      body: JSON.stringify({ text: "x", attachments: ["drive/nope.pdf"] }),
    });
    expect(bad.status).toBe(404);

    // A second goal, cancelled before it runs, keeps its folder and is marked abandoned.
    const second = (await (
      await call("/api/threads", { method: "POST", body: JSON.stringify({ text: "Draft a plan" }) })
    ).json()) as { taskId: string };
    await server.runtime.drive?.write(
      `drive/goals/${second.taskId}/deliverables/draft.md`,
      bytes("draft"),
    );
    await call(`/api/tasks/${second.taskId}/cancel`, { method: "POST", body: "{}" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const shelf = (await (await call("/api/deliverables")).json()) as {
      goals: DeliverableShelfEntry[];
    };
    const byId = Object.fromEntries(shelf.goals.map((goal) => [goal.goalId, goal]));
    expect(byId[taskId]?.status).toBe("done");
    expect(byId[second.taskId]).toMatchObject({ status: "abandoned", title: "Draft a plan" });
    expect(byId[second.taskId]?.files.map((file) => file.name)).toEqual(["draft.md"]);
  });
});
