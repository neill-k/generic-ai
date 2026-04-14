import { describe, expect, it } from "vitest";
import {
  SessionManager as PiSessionManager,
  readTool as piReadTool,
} from "@mariozechner/pi-coding-agent";
import { SessionManager, readTool } from "../../src/pi/index.js";

describe("@generic-ai/sdk pi boundary", () => {
  it("re-exports pi primitives without wrapping them", () => {
    expect(SessionManager).toBe(PiSessionManager);
    expect(readTool).toBe(piReadTool);
  });
});
