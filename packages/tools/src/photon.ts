/**
 * Lazy loader for Photon (`@silvia-odwyer/photon-node`, Rust compiled to WASM), the image library
 * the read tool uses to resize and convert images. Adapted from pi (badlogic/pi-mono, MIT)
 * `photon.ts`, without the Bun binary path patching. Resolves to `null` when Photon can't load, and
 * callers then fall back to passing supported images through unchanged.
 */
export type Photon = typeof import("@silvia-odwyer/photon-node");

let loading: Promise<Photon | null> | undefined;

export function loadPhoton(): Promise<Photon | null> {
  loading ??= import("@silvia-odwyer/photon-node").then(
    (module) => ((module as { default?: Photon }).default ?? module) as Photon,
    () => null,
  );
  return loading;
}
