import {
  createStarterHonoPreset,
  type StarterHonoPresetDefinition,
  type StarterHonoPresetOptions,
} from "@generic-ai/preset-starter-hono";

export const name = "@generic-ai/app-generic-corp" as const;

export const GENERIC_CORP_PRESET_ID = "app.generic-corp";
export const GENERIC_CORP_DISPLAY_NAME = "Generic Corp";
export const GENERIC_CORP_DESCRIPTION =
  "Generic Corp: one owner runs a company of goal-driven agents on Generic AI.";

/**
 * Composes the Generic Corp app on top of the starter preset.
 *
 * The preset gives the app its identity on the starter plugin stack. The running app (company,
 * agents, delegation cascade, chat, board, costs, API) is composed by `createGenericCorpServer`.
 * See docs/decisions/0046-generic-corp-app-on-generic-ai.md.
 */
export function createGenericCorpPreset(
  options: StarterHonoPresetOptions = {},
): StarterHonoPresetDefinition {
  return createStarterHonoPreset({
    ...options,
    id: options.id ?? GENERIC_CORP_PRESET_ID,
    name: options.name ?? GENERIC_CORP_DISPLAY_NAME,
    description: options.description ?? GENERIC_CORP_DESCRIPTION,
  });
}

export * from "./api.js";
export * from "./company.js";
export * from "./costs.js";
export * from "./events.js";
export * from "./executor.js";
export * from "./runtime.js";
export * from "./server.js";
export * from "./storage.js";
export * from "./threads.js";
export * from "./toolkit.js";
