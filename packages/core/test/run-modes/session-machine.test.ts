import { describe, expect, it } from "vitest";
import { createRunSessionMachine } from "../../src/run-modes/session-machine.js";

describe("createRunSessionMachine", () => {
  it("shares child session events with the parent while keeping child observers local", () => {
    const machine = createRunSessionMachine({
      createId: (() => {
        let sequence = 0;
        return () => {
          sequence += 1;
          return `session-${sequence}`;
        };
      })(),
    });

    const root = machine.createRootSession({ id: "root" });
    const rootEvents: string[] = [];
    const childEvents: string[] = [];

    root.observe((event) => {
      rootEvents.push(`${event.type}:${event.sessionId}`);
    });

    root.start();
    const child = root.createChild({ id: "child" });

    child.observe((event) => {
      childEvents.push(`${event.type}:${event.sessionId}`);
    });

    child.start();
    child.emit("session-progress", { step: 1 });
    child.succeed("done");
    root.succeed("root-done");

    expect(root.state).toBe("succeeded");
    expect(child.state).toBe("succeeded");
    expect(rootEvents).toEqual([
      "session-started:root",
      "session-created:child",
      "session-child-created:child",
      "session-started:child",
      "session-progress:child",
      "session-succeeded:child",
      "session-succeeded:root",
    ]);
    expect(childEvents).toEqual([
      "session-started:child",
      "session-progress:child",
      "session-succeeded:child",
    ]);
  });
});
