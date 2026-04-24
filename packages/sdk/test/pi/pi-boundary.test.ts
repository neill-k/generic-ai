import { describe, expect, it } from "vitest";
import {
  createReadTool as piCreateReadTool,
  SessionManager as PiSessionManager,
} from "@mariozechner/pi-coding-agent";
import { createReadTool, readTool, SessionManager } from "../../src/pi/index.js";

describe("@generic-ai/sdk pi boundary", () => {
  it("re-exports pi primitives without wrapping them", () => {
    expect(SessionManager).toBe(PiSessionManager);
    expect(createReadTool).toBe(piCreateReadTool);
    expect(readTool.name).toBe("read");
  });
});
