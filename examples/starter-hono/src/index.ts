import { createGenericAI } from "@generic-ai/core/bootstrap";
import { createStarterHonoPreset, starterHonoPreset } from "@generic-ai/preset-starter-hono";

export const defaultStarterBootstrap = createGenericAI();

export const explicitStarterBootstrap = createGenericAI({
  preset: createStarterHonoPreset({
    description: "Explicit example override showing the starter preset can be swapped in directly.",
  }),
  ports: {
    pluginHost: {
      status: "provided",
      note: "The example harness will provide this once the runtime integration lands.",
    },
  },
});

export const examplePresets = {
  starterHonoPreset,
  defaultStarterBootstrap,
  explicitStarterBootstrap,
} as const;

