import type { OutputPluginContract } from "../contracts/output.js";

export function defineOutputPlugin<TRun, TOutput>(
  plugin: OutputPluginContract<TRun, TOutput>,
): OutputPluginContract<TRun, TOutput> {
  return plugin;
}
