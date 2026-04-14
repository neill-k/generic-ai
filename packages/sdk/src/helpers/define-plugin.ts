import type { PluginContract } from "../contracts/plugin.js";

export function definePlugin<TConfig>(plugin: PluginContract<TConfig>): PluginContract<TConfig> {
  return plugin;
}

