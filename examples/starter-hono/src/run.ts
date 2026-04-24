import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createStarterExampleServer,
  type StarterExampleServerOptions,
} from "./index.js";
import { startFetchServer, type StartedFetchServer } from "./node-server.js";

export interface StarterExampleCliRun {
  readonly server: StartedFetchServer;
  readonly close: () => Promise<void>;
}

export interface StarterExampleCliOptions extends Pick<StarterExampleServerOptions, "createRuntime"> {
  readonly env?: NodeJS.ProcessEnv;
  readonly log?: (message: string) => void;
}

export async function runStarterExampleCli(
  options: StarterExampleCliOptions = {},
): Promise<StarterExampleCliRun> {
  const log = options.log ?? console.log;
  const starter = await createStarterExampleServer({
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.createRuntime === undefined ? {} : { createRuntime: options.createRuntime }),
  });

  let server: StartedFetchServer;
  try {
    server = await startFetchServer(starter.transport.fetch, {
      host: starter.environment.host,
      port: starter.environment.port,
    });
  } catch (error) {
    await starter.stop();
    throw error;
  }

  log(
    [
      `Starter example listening on http://${server.host}:${server.port}${starter.transport.routePrefix}/health`,
      `Adapter: ${starter.runtime.adapter}`,
      `Model: ${starter.runtime.model}`,
      `Exposure: ${starter.environment.exposure}`,
      `Workspace: ${starter.workspaceRoot}`,
    ].join("\n"),
  );

  return {
    server,
    close: async () => {
      await server.close();
      await starter.stop();
    },
  };
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCli) {
  runStarterExampleCli()
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
