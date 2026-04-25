import { createHash } from "node:crypto";
import type {
  AgentSpec,
  ArtifactContract,
  CapabilitySpec,
  CompileDiagnostic,
  CompileHarnessResult,
  CompiledActor,
  CompiledHarness,
  HarnessDsl,
  HarnessFingerprint,
  HarnessSchemaVersion,
  PackageUseSpec,
  ProtocolBindingSpec,
  RelationshipSpec,
  SpaceSpec,
} from "./types.js";
import { HARNESS_SCHEMA_VERSION } from "./types.js";

const COMPILER_VERSION = "0.1.0";

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableNormalize(item));
  }

  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item !== undefined) {
        next[key] = stableNormalize(item);
      }
    }
    return next;
  }

  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stableNormalize(value));
}

export function createStableFingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function addDiagnostic(
  diagnostics: CompileDiagnostic[],
  severity: CompileDiagnostic["severity"],
  code: string,
  message: string,
  path?: string,
): void {
  diagnostics.push({
    severity,
    code,
    message,
    ...(path === undefined ? {} : { path }),
  });
}

function collectDuplicateIds(
  diagnostics: CompileDiagnostic[],
  label: string,
  path: string,
  values: readonly { readonly id: string }[],
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) {
      addDiagnostic(
        diagnostics,
        "error",
        "duplicate_id",
        `${label} id "${value.id}" must be unique.`,
        `${path}.${value.id}`,
      );
      continue;
    }
    seen.add(value.id);
  }
}

function collectIds(values: readonly { readonly id: string }[] | undefined): ReadonlySet<string> {
  return new Set((values ?? []).map((value) => value.id));
}

function requireRef(
  diagnostics: CompileDiagnostic[],
  refs: ReadonlySet<string>,
  ref: string,
  code: string,
  label: string,
  path: string,
): void {
  if (!refs.has(ref)) {
    addDiagnostic(diagnostics, "error", code, `${label} "${ref}" does not exist.`, path);
  }
}

function validatePackageRefs(
  diagnostics: CompileDiagnostic[],
  packages: readonly PackageUseSpec[],
  capabilities: readonly CapabilitySpec[],
  protocols: readonly ProtocolBindingSpec[],
  agents: readonly AgentSpec[],
): void {
  const packageIds = collectIds(packages);

  for (const capability of capabilities) {
    requireRef(
      diagnostics,
      packageIds,
      capability.packageRef,
      "missing_package",
      "Capability package reference",
      `capabilities.${capability.id}.packageRef`,
    );
  }

  for (const protocol of protocols) {
    requireRef(
      diagnostics,
      packageIds,
      protocol.packageRef,
      "missing_package",
      "Protocol package reference",
      `protocols.${protocol.id}.packageRef`,
    );
  }

  for (const agent of agents) {
    for (const packageRef of agent.packageRefs ?? []) {
      requireRef(
        diagnostics,
        packageIds,
        packageRef,
        "missing_package",
        "Agent package reference",
        `agents.${agent.id}.packageRefs`,
      );
    }
  }
}

function validateAgentRefs(
  diagnostics: CompileDiagnostic[],
  agents: readonly AgentSpec[],
  capabilities: readonly CapabilitySpec[],
  spaces: readonly SpaceSpec[],
  relationships: readonly RelationshipSpec[],
  protocols: readonly ProtocolBindingSpec[],
  artifacts: readonly ArtifactContract[],
): void {
  const agentIds = collectIds(agents);
  const artifactIds = collectIds(artifacts);
  const capabilityIds = collectIds(capabilities);
  const spaceIds = collectIds(spaces);

  for (const space of spaces) {
    if (space.ownerAgentRef !== undefined) {
      requireRef(
        diagnostics,
        agentIds,
        space.ownerAgentRef,
        "missing_agent",
        "Space owner agent reference",
        `spaces.${space.id}.ownerAgentRef`,
      );
    }
  }

  for (const agent of agents) {
    for (const spaceRef of agent.readableSpaces ?? []) {
      requireRef(
        diagnostics,
        spaceIds,
        spaceRef,
        "missing_space",
        "Readable space reference",
        `agents.${agent.id}.readableSpaces`,
      );
    }
    for (const spaceRef of agent.writableSpaces ?? []) {
      requireRef(
        diagnostics,
        spaceIds,
        spaceRef,
        "missing_space",
        "Writable space reference",
        `agents.${agent.id}.writableSpaces`,
      );
    }
    for (const capabilityRef of agent.capabilityRefs ?? []) {
      requireRef(
        diagnostics,
        capabilityIds,
        capabilityRef,
        "missing_capability",
        "Agent capability reference",
        `agents.${agent.id}.capabilityRefs`,
      );
    }
    for (const artifactRef of agent.artifactRefs ?? []) {
      requireRef(
        diagnostics,
        artifactIds,
        artifactRef,
        "missing_artifact",
        "Agent artifact reference",
        `agents.${agent.id}.artifactRefs`,
      );
    }
  }

  for (const relationship of relationships) {
    requireRef(
      diagnostics,
      agentIds,
      relationship.fromAgentRef,
      "missing_agent",
      "Relationship source agent",
      `relationships.${relationship.id}.fromAgentRef`,
    );
    requireRef(
      diagnostics,
      agentIds,
      relationship.toAgentRef,
      "missing_agent",
      "Relationship target agent",
      `relationships.${relationship.id}.toAgentRef`,
    );
  }

  for (const protocol of protocols) {
    for (const actorRef of protocol.actorRefs) {
      requireRef(
        diagnostics,
        agentIds,
        actorRef,
        "missing_agent",
        "Protocol actor reference",
        `protocols.${protocol.id}.actorRefs`,
      );
    }
  }

  for (const artifact of artifacts) {
    for (const agentRef of artifact.producedBy ?? []) {
      requireRef(
        diagnostics,
        agentIds,
        agentRef,
        "missing_agent",
        "Artifact producer reference",
        `artifacts.${artifact.id}.producedBy`,
      );
    }
    for (const agentRef of artifact.reviewedBy ?? []) {
      requireRef(
        diagnostics,
        agentIds,
        agentRef,
        "missing_agent",
        "Artifact reviewer reference",
        `artifacts.${artifact.id}.reviewedBy`,
      );
    }
  }
}

function validateTopology(diagnostics: CompileDiagnostic[], agents: readonly AgentSpec[]): void {
  if (agents.length === 0) {
    addDiagnostic(
      diagnostics,
      "error",
      "no_agents",
      "A harness must declare at least one agent.",
      "agents",
    );
  }

  const roots = agents.filter((agent) => agent.role.trim().length > 0);
  if (roots.length === 0) {
    addDiagnostic(
      diagnostics,
      "error",
      "no_roles",
      "Every runnable harness needs at least one agent with a non-empty role.",
      "agents",
    );
  }
}

function compileActor(agent: AgentSpec): CompiledActor {
  const invocationTemplate = [
    `role:${agent.role}`,
    ...(agent.instructions === undefined ? [] : [`instructions:${agent.instructions}`]),
  ].join("\n");

  return Object.freeze({
    id: agent.id,
    role: agent.role,
    ...(agent.instructions === undefined ? {} : { instructions: agent.instructions }),
    ...(agent.model === undefined ? {} : { model: agent.model }),
    packageRefs: Object.freeze([...(agent.packageRefs ?? [])]),
    capabilityRefs: Object.freeze([...(agent.capabilityRefs ?? [])]),
    readableSpaces: Object.freeze([...(agent.readableSpaces ?? [])]),
    writableSpaces: Object.freeze([...(agent.writableSpaces ?? [])]),
    artifactRefs: Object.freeze([...(agent.artifactRefs ?? [])]),
    invocationTemplate,
  });
}

function createFingerprint(
  source: HarnessDsl,
  compiledWithoutFingerprint: Omit<CompiledHarness, "fingerprint">,
): HarnessFingerprint {
  return Object.freeze({
    algorithm: "sha256",
    sourceHash: createStableFingerprint(source),
    compiledHash: createStableFingerprint(compiledWithoutFingerprint),
    schemaVersion: HARNESS_SCHEMA_VERSION,
    compilerVersion: COMPILER_VERSION,
  });
}

function versionMap(packages: readonly PackageUseSpec[]): Readonly<Record<string, string>> {
  const next: Record<string, string> = {};
  for (const packageUse of packages) {
    next[packageUse.id] = packageUse.version ?? "0.0.0";
  }
  return Object.freeze(next);
}

function assertSchemaVersion(
  diagnostics: CompileDiagnostic[],
  schemaVersion: HarnessSchemaVersion,
): void {
  if (schemaVersion !== HARNESS_SCHEMA_VERSION) {
    addDiagnostic(
      diagnostics,
      "error",
      "unsupported_schema_version",
      `Harness schema version "${schemaVersion}" is not supported by compiler ${COMPILER_VERSION}.`,
      "schemaVersion",
    );
  }
}

export function compileHarnessDsl(source: HarnessDsl): CompileHarnessResult {
  const diagnostics: CompileDiagnostic[] = [];
  assertSchemaVersion(diagnostics, source.schemaVersion);

  const capabilities = source.capabilities ?? [];
  const spaces = source.spaces ?? [];
  const relationships = source.relationships ?? [];
  const protocols = source.protocols ?? [];
  const artifacts = source.artifacts ?? [];
  const policies = source.policies ?? [];

  collectDuplicateIds(diagnostics, "Package", "packages", source.packages);
  collectDuplicateIds(diagnostics, "Capability", "capabilities", capabilities);
  collectDuplicateIds(diagnostics, "Agent", "agents", source.agents);
  collectDuplicateIds(diagnostics, "Space", "spaces", spaces);
  collectDuplicateIds(diagnostics, "Relationship", "relationships", relationships);
  collectDuplicateIds(diagnostics, "Protocol", "protocols", protocols);
  collectDuplicateIds(diagnostics, "Artifact", "artifacts", artifacts);
  collectDuplicateIds(diagnostics, "Policy", "policies", policies);

  validateTopology(diagnostics, source.agents);
  validatePackageRefs(diagnostics, source.packages, capabilities, protocols, source.agents);
  validateAgentRefs(
    diagnostics,
    source.agents,
    capabilities,
    spaces,
    relationships,
    protocols,
    artifacts,
  );

  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return Object.freeze({ diagnostics: Object.freeze(diagnostics) });
  }

  const compiledWithoutFingerprint: Omit<CompiledHarness, "fingerprint"> = Object.freeze({
    kind: "generic-ai.compiled-harness",
    schemaVersion: HARNESS_SCHEMA_VERSION,
    id: `${source.id}:compiled`,
    sourceId: source.id,
    ...(source.name === undefined ? {} : { name: source.name }),
    packages: Object.freeze([...source.packages]),
    capabilities: Object.freeze([...capabilities]),
    agents: Object.freeze(source.agents.map((agent) => compileActor(agent))),
    spaces: Object.freeze([...spaces]),
    relationships: Object.freeze([...relationships]),
    protocols: Object.freeze([...protocols]),
    policies: Object.freeze([...policies]),
    artifacts: Object.freeze([...artifacts]),
    missionRefs: Object.freeze([...(source.missionRefs ?? [])]),
    evalRefs: Object.freeze([...(source.evalRefs ?? [])]),
    packageVersions: versionMap(source.packages),
  });

  const compiled: CompiledHarness = Object.freeze({
    ...compiledWithoutFingerprint,
    fingerprint: createFingerprint(source, compiledWithoutFingerprint),
  });

  return Object.freeze({
    diagnostics: Object.freeze(diagnostics),
    compiled,
  });
}

export function assertCompiledHarness(result: CompileHarnessResult): CompiledHarness {
  if (result.compiled !== undefined) {
    return result.compiled;
  }

  const message = result.diagnostics
    .filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
    .join("; ");
  throw new Error(`Harness DSL failed to compile: ${message}`);
}
