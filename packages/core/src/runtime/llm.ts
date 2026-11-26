import { createNativeRuntime, type NativeRuntimeDependencies } from "./native.js";
import {
  type CreateGenericAILlmRuntimeOptions,
  DEFAULT_GENERIC_AI_RUNTIME_ADAPTER,
  type GenericAILlmRuntime,
} from "./types.js";

export interface GenericAILlmRuntimeDependencies {
  readonly native?: NativeRuntimeDependencies;
}

export async function createGenericAILlmRuntime(
  input: CreateGenericAILlmRuntimeOptions,
  dependencies: GenericAILlmRuntimeDependencies = {},
): Promise<GenericAILlmRuntime> {
  const adapter = input.adapter ?? DEFAULT_GENERIC_AI_RUNTIME_ADAPTER;
  if (adapter !== "native") {
    throw new Error(`Unsupported runtime adapter "${String(adapter)}".`);
  }
  return createNativeRuntime(input, dependencies.native);
}
