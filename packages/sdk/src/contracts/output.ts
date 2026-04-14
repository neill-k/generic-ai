import type { Awaitable, JsonObject } from "./shared.js";
import type { PluginManifest } from "./plugin.js";

export interface OutputFinalizeInput<TRun = unknown> {
  readonly runId: string;
  readonly scopeId: string;
  readonly pluginId: string;
  readonly run: TRun;
  readonly context?: JsonObject;
}

export interface OutputEnvelope<TOutput = unknown> {
  readonly kind: "output-envelope";
  readonly pluginId: string;
  readonly contentType: string;
  readonly payload: TOutput;
  readonly summary?: string;
  readonly metadata?: JsonObject;
}

export interface OutputPluginContract<TRun = unknown, TOutput = unknown> {
  readonly kind: "output-plugin";
  readonly manifest: PluginManifest;
  readonly contentType: string;
  finalize(input: OutputFinalizeInput<TRun>): Awaitable<OutputEnvelope<TOutput>>;
}

