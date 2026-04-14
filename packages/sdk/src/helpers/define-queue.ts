import type { QueueContract } from "../contracts/queue.js";

export function defineQueue<TPayload, TResult>(
  queue: QueueContract<TPayload, TResult>,
): QueueContract<TPayload, TResult> {
  return queue;
}
