const neverAborted = new AbortController().signal;

/** The caller's signal, or one that never aborts. */
export function operationSignal(signal: AbortSignal | undefined): AbortSignal {
  return signal ?? neverAborted;
}

/** Reject with the signal's reason as soon as it aborts, without cancelling `promise` itself. */
export function raceWithAbortSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal === neverAborted) {
    return promise;
  }
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Operation aborted");
}
