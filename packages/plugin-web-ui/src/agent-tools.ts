import { Type, type Static } from "@sinclair/typebox";
import { withAgentHarnessToolEffects } from "@generic-ai/sdk";
import {
  defineTool,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionContext,
  type ToolDefinition,
} from "@generic-ai/sdk/pi";

import type { WebUiPlugin } from "./types.js";

const listConfigSchema = Type.Object({});
const readConfigSchema = Type.Object({});
const configEditSchema = Type.Object({
  action: Type.Union([Type.Literal("set"), Type.Literal("delete")]),
  concern: Type.Union([
    Type.Literal("framework"),
    Type.Literal("agent"),
    Type.Literal("harness"),
    Type.Literal("plugin"),
  ]),
  key: Type.Optional(Type.String()),
  value: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  expectedSha256: Type.Optional(Type.String()),
});
const validateYamlSchema = Type.Object({
  edits: Type.Array(configEditSchema),
  expectedRevision: Type.Optional(Type.String()),
});
const applyTemplateSchema = Type.Object({
  templateId: Type.String(),
  dryRun: Type.Optional(Type.Boolean()),
  expectedRevision: Type.Optional(Type.String()),
  idempotencyKey: Type.Optional(Type.String()),
});

type ValidateYamlInput = Static<typeof validateYamlSchema>;
type ApplyTemplateInput = Static<typeof applyTemplateSchema>;

export interface WebUiAgentTools {
  readonly piTools: readonly [
    ToolDefinition<typeof listConfigSchema, unknown>,
    ToolDefinition<typeof readConfigSchema, unknown>,
    ToolDefinition<typeof validateYamlSchema, unknown>,
    ToolDefinition<typeof applyTemplateSchema, unknown>,
  ];
}

export function createWebUiAgentTools(plugin: WebUiPlugin): WebUiAgentTools {
  const piTools: WebUiAgentTools["piTools"] = [
    withAgentHarnessToolEffects(createListConfigTool(plugin), ["fs.read"]),
    withAgentHarnessToolEffects(createReadConfigTool(plugin), ["fs.read"]),
    withAgentHarnessToolEffects(createValidateYamlTool(plugin), ["fs.read"]),
    withAgentHarnessToolEffects(createApplyTemplateTool(plugin), ["fs.read", "fs.write"]),
  ];

  return Object.freeze({
    piTools: Object.freeze(piTools),
  });
}

function createListConfigTool(
  plugin: WebUiPlugin,
): ToolDefinition<typeof listConfigSchema, unknown> {
  return defineTool({
    name: "web_ui_list_config",
    label: "web_ui_list_config",
    description: "List the currently resolved Generic AI config summary and available web UI templates.",
    parameters: listConfigSchema,
    async execute(
      _toolCallId: string,
      _params: Static<typeof listConfigSchema>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const config = await plugin.getConfig();
      const templates = plugin.listTemplates();
      const details = {
        config: {
          revision: config.revision,
          ok: config.failures.length === 0,
          primaryAgent: config.config?.framework.primaryAgent,
          primaryHarness: config.config?.framework.primaryHarness,
        },
        templates,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });
}

function createReadConfigTool(
  plugin: WebUiPlugin,
): ToolDefinition<typeof readConfigSchema, unknown> {
  return defineTool({
    name: "web_ui_read_config",
    label: "web_ui_read_config",
    description: "Read the resolved Generic AI config snapshot used by the web UI.",
    parameters: readConfigSchema,
    async execute(
      _toolCallId: string,
      _params: Static<typeof readConfigSchema>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const snapshot = await plugin.getConfig();
      return {
        content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }],
        details: snapshot,
      };
    },
  });
}

function createValidateYamlTool(
  plugin: WebUiPlugin,
): ToolDefinition<typeof validateYamlSchema, unknown> {
  return defineTool({
    name: "web_ui_validate_yaml",
    label: "web_ui_validate_yaml",
    description: "Preview and validate Generic AI config edits without writing files.",
    parameters: validateYamlSchema,
    async execute(
      _toolCallId: string,
      params: ValidateYamlInput,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const result = await plugin.previewConfig({
        edits: params.edits,
        ...(params.expectedRevision === undefined
          ? {}
          : { expectedRevision: params.expectedRevision }),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}

function createApplyTemplateTool(
  plugin: WebUiPlugin,
): ToolDefinition<typeof applyTemplateSchema, unknown> {
  return defineTool({
    name: "web_ui_apply_template",
    label: "web_ui_apply_template",
    description:
      "Apply or dry-run a runnable web UI architecture template. Mutating applies require an idempotency key.",
    parameters: applyTemplateSchema,
    async execute(
      _toolCallId: string,
      params: ApplyTemplateInput,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const result = await plugin.applyTemplate(params.templateId, {
        ...(params.dryRun === undefined ? {} : { dryRun: params.dryRun }),
        ...(params.expectedRevision === undefined
          ? {}
          : { expectedRevision: params.expectedRevision }),
        ...(params.idempotencyKey === undefined ? {} : { idempotencyKey: params.idempotencyKey }),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
