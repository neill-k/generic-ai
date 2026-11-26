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
 * This is a scaffold: it reuses the starter preset's default plugin stack unchanged and only
 * gives the app its own identity. Product features (CEO, org chart, delegation cascade, board,
 * dashboard) arrive in later work. See docs/decisions/0046-generic-corp-app-on-generic-ai.md.
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
