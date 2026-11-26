import type { PolicyDecisionRecord, SecretAccessRecord, SecretsBinding } from "@generic-ai/sdk";

import type { PiCapabilityBindings } from "../runtime/capability-runtime.js";

/**
 * Wrap every tool a role can call so `{{secret:NAME}}` placeholders resolve at call time against
 * the role's grants and secret values are scrubbed from results before the model sees them.
 *
 * Applied after role policy and before lifecycle hooks, so hooks see placeholders, never values.
 */
export function wrapCapabilitiesWithSecrets(input: {
  readonly capabilities: PiCapabilityBindings;
  readonly secrets: SecretsBinding | undefined;
  readonly actorId: string;
  readonly grants: readonly string[] | undefined;
  readonly runId: string;
  readonly onAccess?: (record: SecretAccessRecord) => void | Promise<void>;
}): PiCapabilityBindings {
  const { secrets, capabilities } = input;
  if (secrets === undefined) {
    return capabilities;
  }
  const context = {
    actorId: input.actorId,
    ...(input.grants === undefined ? {} : { grants: input.grants }),
    runId: input.runId,
    ...(input.onAccess === undefined ? {} : { onAccess: input.onAccess }),
  };
  return {
    ...capabilities,
    ...(capabilities.terminalTools === undefined
      ? {}
      : { terminalTools: { tool: secrets.wrapTool(capabilities.terminalTools.tool, context) } }),
    ...(capabilities.fileTools === undefined
      ? {}
      : {
          fileTools: {
            piTools: capabilities.fileTools.piTools.map((tool) => secrets.wrapTool(tool, context)),
          },
        }),
    ...(capabilities.customTools === undefined
      ? {}
      : { customTools: capabilities.customTools.map((tool) => secrets.wrapTool(tool, context)) }),
  };
}

/** Prompt lines telling a role which secrets it may reference. Names only, never values. */
export async function secretsPromptGuidance(
  secrets: SecretsBinding | undefined,
  grants: readonly string[] | undefined,
): Promise<string> {
  if (secrets === undefined) {
    return "";
  }
  const names = await secrets.grantedNames(grants);
  if (names.length === 0) {
    return "";
  }
  return [
    "",
    "",
    "Secrets: you may use these credentials without seeing them by writing a placeholder in a tool input, for example {{secret:NAME}}. The value is filled in when the tool runs and is shown as [REDACTED:NAME] in results. Never ask for or try to print secret values.",
    `Available secrets: ${names.join(", ")}.`,
  ].join("\n");
}

/** Record one secret use as a policy decision, so it lands in the run's audit trail. */
export function secretAccessPolicyDecision(record: SecretAccessRecord): PolicyDecisionRecord {
  const allowed = record.decision === "allowed";
  return Object.freeze({
    id: `secret:${record.runId ?? "run"}:${record.actorId}:${record.name}:${record.at}`,
    runId: record.runId ?? "",
    actorId: record.actorId,
    action: "secret.read",
    resource: Object.freeze({ kind: "custom" as const, id: `secret:${record.name}` }),
    effect: allowed ? ("allow" as const) : ("deny" as const),
    decision: allowed ? ("allowed" as const) : ("denied" as const),
    reason:
      record.toolName === undefined ? record.reason : `${record.reason} Tool: ${record.toolName}.`,
    evidenceRefs: Object.freeze([]),
  });
}
