import type { LifecycleHooks } from "../contracts/lifecycle.js";

export function defineLifecycle<TContext>(
  hooks: LifecycleHooks<TContext>,
): LifecycleHooks<TContext> {
  return hooks;
}
