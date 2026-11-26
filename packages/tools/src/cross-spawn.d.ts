declare module "cross-spawn" {
  import type {
    ChildProcess,
    SpawnOptions,
    SpawnSyncOptions,
    SpawnSyncReturns,
  } from "node:child_process";

  function crossSpawn(
    command: string,
    args?: readonly string[],
    options?: SpawnOptions,
  ): ChildProcess;
  namespace crossSpawn {
    function sync(
      command: string,
      args?: readonly string[],
      options?: SpawnSyncOptions,
    ): SpawnSyncReturns<Buffer | string>;
  }
  export default crossSpawn;
}
