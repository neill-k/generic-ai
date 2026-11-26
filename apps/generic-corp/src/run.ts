import path from "node:path";
import { pathToFileURL } from "node:url";

import { startFetchServer } from "./node-server.js";
import { createGenericCorpServer } from "./server.js";

/** Starts Generic Corp: `node dist/run.js`. Configuration comes from the environment. */
export async function runGenericCorp(env: NodeJS.ProcessEnv = process.env) {
  const app = await createGenericCorpServer({ env });
  const { host, port } = app.environment;
  let server: Awaited<ReturnType<typeof startFetchServer>>;
  try {
    server = await startFetchServer(app.fetch, {
      host,
      port,
      onError: (error) => console.error(error),
    });
  } catch (error) {
    await app.stop();
    throw error;
  }
  console.log(
    [
      `${app.runtime.company.name} is listening on http://${server.host}:${server.port}`,
      `Storage: ${app.storage.driver}. Agents: ${(await app.runtime.listAgents()).length}. Workers: ${app.environment.workers ? "on" : "off"}.`,
    ].join("\n"),
  );
  return {
    server,
    app,
    async close() {
      await server.close();
      await app.stop();
    },
  };
}

const isCli =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCli) {
  runGenericCorp()
    .then((started) => {
      const shutdown = async () => {
        process.off("SIGINT", shutdown);
        process.off("SIGTERM", shutdown);
        await started.close();
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
