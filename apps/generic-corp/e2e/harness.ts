import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "scripted-server.mjs");

export interface ScriptedServer {
  readonly url: string;
  readonly process: ChildProcess;
  /** Everything the process printed, for failure messages. */
  output(): string;
  /** Stops the server the way an operator would (SIGTERM). */
  stop(): Promise<void>;
  /** Kills the server without warning (SIGKILL), as a crash or an evicted container would. */
  kill(): Promise<void>;
}

export interface StartOptions {
  readonly dataDir: string;
  readonly env?: Readonly<Record<string, string>>;
}

/** Starts `scripted-server.mjs` on a free port and waits until it listens. */
export async function startScriptedServer(options: StartOptions): Promise<ScriptedServer> {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      E2E_DATA_DIR: options.dataDir,
      E2E_PORT: "0",
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`The server did not start:\n${output}`)),
      30_000,
    );
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = /listening on (http:\/\/\S+)/.exec(output);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`The server exited with ${code} before listening:\n${output}`));
    });
  });
  const end = async (signal: NodeJS.Signals) => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
    await exited;
  };
  return {
    url,
    process: child,
    output: () => output,
    stop: () => end("SIGTERM"),
    kill: () => end("SIGKILL"),
  };
}

/** A fresh data directory, removed by the returned cleanup. */
export function tempDataDir(): { readonly dir: string; readonly remove: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "generic-corp-e2e-"));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface ThreadReply {
  readonly status: string;
  readonly text?: string;
  readonly taskId: string;
}

/** Starts a chat thread with the CEO over the API and returns its id. */
export async function startThread(url: string, text: string): Promise<string> {
  const response = await fetch(`${url}/api/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (response.status !== 201) {
    throw new Error(`POST /api/threads returned ${response.status}: ${await response.text()}`);
  }
  const body = (await response.json()) as { thread: { threadId: string } };
  return body.thread.threadId;
}

/** The CEO's reply to the first message of a thread. */
export async function threadReply(url: string, threadId: string): Promise<ThreadReply> {
  const response = await fetch(`${url}/api/threads/${threadId}`);
  if (!response.ok) {
    throw new Error(`GET /api/threads/${threadId} returned ${response.status}`);
  }
  const body = (await response.json()) as {
    thread?: { exchanges: Array<{ reply: ThreadReply }> };
    exchanges?: Array<{ reply: ThreadReply }>;
  };
  const exchanges = body.thread?.exchanges ?? body.exchanges ?? [];
  const reply = exchanges[0]?.reply;
  if (reply === undefined) {
    throw new Error(`Thread ${threadId} has no exchange.`);
  }
  return reply;
}

/** Polls until the thread's reply settles (succeeded or failed), or throws after `timeoutMs`. */
export async function waitForReply(
  url: string,
  threadId: string,
  timeoutMs = 30_000,
): Promise<ThreadReply> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const reply = await threadReply(url, threadId);
    if (reply.status === "succeeded" || reply.status === "failed") {
      return reply;
    }
    if (Date.now() > deadline) {
      throw new Error(`Thread ${threadId} is still ${reply.status} after ${timeoutMs} ms.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
