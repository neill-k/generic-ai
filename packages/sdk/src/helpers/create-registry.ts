import type { RegistryContract, RegistryEntry } from "../contracts/registry.js";

export function createRegistry<TValue, TKey extends string = string>(
  name: string,
  initialEntries: Iterable<readonly [TKey, TValue]> = [],
): RegistryContract<TValue, TKey> {
  const entries = new Map<TKey, TValue>(initialEntries);

  return {
    kind: "registry",
    name,
    register(key, value) {
      entries.set(key, value);
    },
    has(key) {
      return entries.has(key);
    },
    get(key) {
      return entries.get(key);
    },
    delete(key) {
      return entries.delete(key);
    },
    clear() {
      entries.clear();
    },
    entries() {
      return Array.from(
        entries.entries(),
        ([key, value]) => ({ key, value }) satisfies RegistryEntry<TKey, TValue>,
      );
    },
  };
}
