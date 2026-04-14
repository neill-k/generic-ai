export type RunModeKind = "sync" | "async";

export type RunSessionState = "idle" | "running" | "succeeded" | "failed" | "cancelled";

export interface RunSessionEvent {
  readonly type: string;
  readonly sessionId: string;
  readonly parentSessionId: string | null;
  readonly mode: RunModeKind;
  readonly depth: number;
  readonly timestamp: number;
  readonly detail?: unknown;
}

export type RunSessionObserver = (event: RunSessionEvent) => void;

export interface RunSession {
  readonly id: string;
  readonly parentId: string | null;
  readonly mode: RunModeKind;
  readonly depth: number;
  readonly state: RunSessionState;
  readonly children: readonly RunSession[];
  observe(observer: RunSessionObserver): () => void;
  emit(type: string, detail?: unknown): void;
  start(): void;
  succeed(detail?: unknown): void;
  fail(error: unknown): void;
  cancel(reason?: string): void;
  createChild(options?: RunSessionSeed): RunSession;
}

export interface RunSessionSeed {
  readonly id?: string;
  readonly mode?: RunModeKind;
}

export interface RunSessionMachine {
  createRootSession(options?: RunSessionSeed): RunSession;
}

function createIdFactory(prefix: string): () => string {
  let sequence = 0;

  return () => {
    sequence += 1;
    return `${prefix}-${sequence}`;
  };
}

function createEvent(input: {
  readonly type: string;
  readonly sessionId: string;
  readonly parentSessionId: string | null;
  readonly mode: RunModeKind;
  readonly depth: number;
  readonly detail?: unknown;
}): RunSessionEvent {
  return {
    ...input,
    timestamp: Date.now(),
  };
}

export function createRunSessionMachine(options?: { readonly createId?: () => string }): RunSessionMachine {
  const createId = options?.createId ?? createIdFactory("session");

  const buildSession = (
    parent: InternalRunSession | null,
    seed?: RunSessionSeed,
  ): InternalRunSession => {
    const id = seed?.id ?? createId();
    const mode = seed?.mode ?? parent?.mode ?? "sync";
    const depth = parent ? parent.depth + 1 : 0;
    const observers = new Set<RunSessionObserver>();
    const children: InternalRunSession[] = [];
    let state: RunSessionState = "idle";

    const session: InternalRunSession = {
      id,
      parentId: parent?.id ?? null,
      mode,
      depth,
      get state() {
        return state;
      },
      get children() {
        return [...children];
      },
      notify(event) {
        for (const observer of observers) {
          observer(event);
        }

        parent?.notify(event);
      },
      observe(observer) {
        observers.add(observer);
        return () => {
          observers.delete(observer);
        };
      },
      emit(type, detail) {
        const event = createEvent({
          type,
          sessionId: id,
          parentSessionId: parent?.id ?? null,
          mode,
          depth,
          detail,
        });

        session.notify(event);
      },
      start() {
        transition("running", "session-started");
      },
      succeed(detail) {
        transition("succeeded", "session-succeeded", detail);
      },
      fail(error) {
        transition("failed", "session-failed", error);
      },
      cancel(reason) {
        transition("cancelled", "session-cancelled", reason);
      },
      createChild(childSeed) {
        const child = buildSession(session, childSeed);
        children.push(child);
        session.notify(
          createEvent({
            type: "session-child-created",
            sessionId: child.id,
            parentSessionId: id,
            mode: child.mode,
            depth: child.depth,
            detail: {
              parentSessionId: id,
            },
          }),
        );
        return child;
      },
    };

    function transition(nextState: Exclude<RunSessionState, "idle">, type: string, detail?: unknown): void {
      if (nextState === "running") {
        if (state !== "idle") {
          throw new Error(`Session ${id} is already running or terminal.`);
        }
      } else if (nextState === "cancelled") {
        if (state !== "idle" && state !== "running") {
          throw new Error(`Session ${id} cannot be cancelled from ${state}.`);
        }
      } else if (nextState === "succeeded" || nextState === "failed") {
        if (state !== "running") {
          throw new Error(`Session ${id} must be running before it can complete.`);
        }
      } else {
        throw new Error(`Session ${id} does not support transition to ${nextState}.`);
      }

      state = nextState;
      session.notify(
        createEvent({
          type,
          sessionId: id,
          parentSessionId: parent?.id ?? null,
          mode,
          depth,
          detail,
        }),
      );
    }

    session.notify(
      createEvent({
        type: "session-created",
        sessionId: id,
        parentSessionId: parent?.id ?? null,
        mode,
        depth,
      }),
    );

    return session;
  };

  return {
    createRootSession(options) {
      return buildSession(null, options);
    },
  };
}

interface InternalRunSession extends RunSession {
  notify(event: RunSessionEvent): void;
}
