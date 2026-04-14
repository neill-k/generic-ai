import type { RunScheduler } from "../scheduler/types.js";
import { createRunSessionMachine, type RunSession, type RunSessionMachine, type RunSessionSeed } from "./session-machine.js";

export type SyncRunTask<T> = (session: RunSession) => T;
export type AsyncRunTask<T> = (session: RunSession) => T | Promise<T>;

export interface SyncRunMode {
  readonly kind: "sync";
  run<T>(task: SyncRunTask<T>, options?: RunSessionSeed): T;
}

export interface AsyncRunMode {
  readonly kind: "async";
  readonly scheduler: RunScheduler;
  run<T>(task: AsyncRunTask<T>, options?: RunSessionSeed): Promise<T>;
}

export interface RunModeFactoryOptions {
  readonly sessions?: RunSessionMachine;
}

export interface AsyncRunModeFactoryOptions extends RunModeFactoryOptions {
  readonly scheduler: RunScheduler;
}

function completeSession<T>(
  session: RunSession,
  task: () => T | Promise<T>,
  resolve: (value: T | PromiseLike<T>) => void,
  reject: (reason?: unknown) => void,
): void {
  Promise.resolve()
    .then(task)
    .then(
      (result) => {
        session.succeed(result);
        resolve(result);
      },
      (error) => {
        session.fail(error);
        reject(error);
      },
    );
}

export function createSyncRunMode(options: RunModeFactoryOptions = {}): SyncRunMode {
  const sessions = options.sessions ?? createRunSessionMachine();

  return {
    kind: "sync",
    run<T>(task: SyncRunTask<T>, seed?: RunSessionSeed): T {
      const session = sessions.createRootSession({ ...seed, mode: "sync" });
      session.start();

      try {
        const result = task(session);
        session.succeed(result);
        return result;
      } catch (error) {
        session.fail(error);
        throw error;
      }
    },
  };
}

export function createAsyncRunMode(options: AsyncRunModeFactoryOptions): AsyncRunMode {
  const sessions = options.sessions ?? createRunSessionMachine();

  return {
    kind: "async",
    scheduler: options.scheduler,
    run<T>(task: AsyncRunTask<T>, seed?: RunSessionSeed): Promise<T> {
      const session = sessions.createRootSession({ ...seed, mode: "async" });
      session.start();

      return new Promise<T>((resolve, reject) => {
        try {
          options.scheduler.schedule(() => completeSession(session, () => task(session), resolve, reject));
        } catch (error) {
          session.fail(error);
          reject(error);
        }
      });
    },
  };
}
