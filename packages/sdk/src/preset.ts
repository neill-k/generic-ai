import type { ResolvedConfig } from "./config/index.js";

export interface PresetContract<TResolved = unknown, TOptions = unknown> {
  readonly id: string;
  readonly packageName: string;
  readonly version: number | string;
  readonly description?: string;
  resolve(options?: TOptions): TResolved;
}

export interface GenericAIBootstrapOptions<TPreset = PresetContract> {
  readonly config?: ResolvedConfig;
  readonly preset?: TPreset;
  readonly rootScopeId?: string;
}

export interface GenericAIBootstrapResult<TPreset = PresetContract> {
  readonly createdAt: string;
  readonly packageName: string;
  readonly config?: ResolvedConfig;
  readonly preset?: TPreset;
  readonly rootScopeId: string;
}
