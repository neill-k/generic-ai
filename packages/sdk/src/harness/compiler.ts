import { createHash } from "node:crypto";
import type {
  AgentSpec,
  ArtifactContract,
  CapabilityBOM,
  CapabilityBOMAgentBinding,
  CapabilityBOMArtifact,
  CapabilityBOMCapability,
  CapabilityBOMPackage,
  CapabilityBOMPolicy,
  CapabilityBOMProtocol,
  CapabilityBOMSummary,
  CapabilitySpec,
  CompileDiagnostic,
  CompileHarnessResult,
  CompiledActor,
  CompiledHarness,
  HarnessDsl,
  HarnessFingerprint,
  HarnessSchemaVersion,
  PackageUseSpec,
  PolicyEffect,
  ProtocolBindingSpec,
  RelationshipSpec,
  ResourceSelector,
  SpaceSpec,
} from "./types.js";
import { HARNESS_SCHEMA_VERSION } from "./types.js";

const COMPILER_VERSION = "0.1.0";
const CAPABILITY_KINDS: readonly CapabilitySpec["kind"][] = Object.freeze([
  "tool",
  "memory",
  "protocol",
  "grader",
  "trace-exporter",
  "report-renderer",
  "policy",
  "runtime",
  "custom",
]);
const POLICY_EFFECTS: readonly PolicyEffect[] = Object.freeze([
  "allow",
  "deny",
  "require_approval",
  "redact",
  "rewrite",
]);

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

function sortedStrings(values: readonly string[] | undefined): readonly string[] {
  return Object.freeze([...(values ?? [])].sort());
}

function sortedUnique<T extends string>(values: readonly T[]): readonly T[] {
  return Object.freeze([...new Set(values)].sort());
}

function capabilityKindCounts(
  capabilities: readonly { readonly kind: CapabilitySpec["kind"] }[],
): Readonly<Record<CapabilitySpec["kind"], number>> {
  const counts = Object.fromEntries(CAPABILITY_KINDS.map((kind) => [kind, 0])) as Record<
    CapabilitySpec["kind"],
    number
  >;
  for (const capability of capabilities) {
    counts[capability.kind] += 1;
  }
  return Object.freeze(counts);
}

function policyEffectCounts(policies: readonly { readonly effect: PolicyEffect }[]) {
  const counts = Object.fromEntries(POLICY_EFFECTS.map((effect) => [effect, 0])) as Record<
    PolicyEffect,
    number
  >;
  for (const policy of policies) {
    counts[policy.effect] += 1;
  }
  return Object.freeze(counts);
}

function sortedById<T extends { readonly id: string }>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values].sort((left, right) => left.id.localeCompare(right.id)));
}

function packageBomEntry(packageUse: PackageUseSpec): CapabilityBOMPackage {
  return Object.freeze({
    id: packageUse.id,
    package: packageUse.package,
    version: packageUse.version ?? "0.0.0",
    compatibility: sortedStrings(packageUse.compatibility),
  });
}

function capabilityBomEntry(capability: CapabilitySpec): CapabilityBOMCapability {
  const grants = capability.grants ?? [];
  const grantPolicyEffects = sortedUnique(grants.map((grant) => grant.effect));
  const grantResourceKinds = sortedUnique(
    grants.map((grant) => grant.resource.kind as ResourceSelector["kind"]),
  );

  return Object.freeze({
    id: capability.id,
    kind: capability.kind,
    packageRef: capability.packageRef,
    grantCount: grants.length,
    grantPolicyEffects,
    grantResourceKinds,
    ...(capability.schema === undefined
      ? {}
      : { schemaHash: createStableFingerprint(capability.schema) }),
  });
}

function protocolBomEntry(protocol: ProtocolBindingSpec): CapabilityBOMProtocol {
  return Object.freeze({
    id: protocol.id,
    protocol: protocol.protocol,
    packageRef: protocol.packageRef,
    actorRefs: sortedStrings(protocol.actorRefs),
  });
}

function policyBomEntry(policy: {
  readonly id: string;
  readonly subject: string;
  readonly action: string;
  readonly resource: ResourceSelector;
  readonly effect: PolicyEffect;
  readonly conditions?: readonly unknown[];
}): CapabilityBOMPolicy {
  return Object.freeze({
    id: policy.id,
    subject: policy.subject,
    action: policy.action,
    effect: policy.effect,
    resourceKind: policy.resource.kind,
    ...(policy.resource.id === undefined ? {} : { resourceId: policy.resource.id }),
    ...(policy.resource.pattern === undefined ? {} : { resourcePattern: policy.resource.pattern }),
    conditionCount: policy.conditions?.length ?? 0,
  });
}

function agentBindingBomEntry(agent: CompiledActor): CapabilityBOMAgentBinding {
  return Object.freeze({
    agentId: agent.id,
    role: agent.role,
    packageRefs: sortedStrings(agent.packageRefs),
    capabilityRefs: sortedStrings(agent.capabilityRefs),
  });
}

function artifactBomEntry(artifact: ArtifactContract): CapabilityBOMArtifact {
  return Object.freeze({
    id: artifact.id,
    kind: artifact.kind,
    requiredBy: sortedStrings(artifact.requiredBy),
    producedBy: sortedStrings(artifact.producedBy),
    reviewedBy: sortedStrings(artifact.reviewedBy),
  });
}

function capabilityBomSummary(input: {
  readonly packages: readonly CapabilityBOMPackage[];
  readonly capabilities: readonly CapabilityBOMCapability[];
  readonly protocols: readonly CapabilityBOMProtocol[];
  readonly policies: readonly CapabilityBOMPolicy[];
  readonly agentBindings: readonly CapabilityBOMAgentBinding[];
  readonly artifacts: readonly CapabilityBOMArtifact[];
}): CapabilityBOMSummary {
  return Object.freeze({
    packageCount: input.packages.length,
    capabilityCount: input.capabilities.length,
    protocolCount: input.protocols.length,
    policyCount: input.policies.length,
    agentCount: input.agentBindings.length,
    artifactCount: input.artifacts.length,
    capabilityKinds: capabilityKindCounts(input.capabilities),
    policyEffects: policyEffectCounts(input.policies),
  });
}

export function createCapabilityBOM(
  compiled: Omit<CompiledHarness, "capabilityBOM" | "fingerprint">,
): CapabilityBOM {
  const packages = sortedById(compiled.packages.map((packageUse) => packageBomEntry(packageUse)));
  const capabilities = sortedById(
    compiled.capabilities.map((capability) => capabilityBomEntry(capability)),
  );
  const protocols = sortedById(compiled.protocols.map((protocol) => protocolBomEntry(protocol)));
  const policies = sortedById(compiled.policies.map((policy) => policyBomEntry(policy)));
  const agentBindings = Object.freeze(
    compiled.agents
      .map((agent) => agentBindingBomEntry(agent))
      .sort((left, right) => left.agentId.localeCompare(right.agentId)),
  );
  const artifacts = sortedById(compiled.artifacts.map((artifact) => artifactBomEntry(artifact)));
  const summary = capabilityBomSummary({
    packages,
    capabilities,
    protocols,
    policies,
    agentBindings,
    artifacts,
  });
  const withoutFingerprint = Object.freeze({
    kind: "generic-ai.capability-bom" as const,
    schemaVersion: compiled.schemaVersion,
    harnessId: compiled.id,
    sourceId: compiled.sourceId,
    packages,
    capabilities,
    protocols,
    policies,
    agentBindings,
    artifacts,
    summary,
  });

  return Object.freeze({
    ...withoutFingerprint,
    fingerprint: Object.freeze({
      algorithm: "sha256" as const,
      value: createStableFingerprint(withoutFingerprint),
      schemaVersion: HARNESS_SCHEMA_VERSION,
      compilerVersion: COMPILER_VERSION,
    }),
  });
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

  const compiledWithoutCapabilityBomAndFingerprint: Omit<
    CompiledHarness,
    "capabilityBOM" | "fingerprint"
  > = Object.freeze({
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
  const capabilityBOM = createCapabilityBOM(compiledWithoutCapabilityBomAndFingerprint);
  const compiledWithoutFingerprint: Omit<CompiledHarness, "fingerprint"> = Object.freeze({
    ...compiledWithoutCapabilityBomAndFingerprint,
    capabilityBOM,
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
