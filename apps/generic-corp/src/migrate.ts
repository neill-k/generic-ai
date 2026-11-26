import path from "node:path";
import { pathToFileURL } from "node:url";

import { openPostgresStorage, type PostgresStorage } from "@generic-ai/plugin-storage-postgres";

/**
 * Applies pending Postgres schema migrations and exits: `node dist/migrate.js`.
 *
 * Railway runs this as the pre-deploy command, so a failed migration stops the
 * deploy before the new server takes traffic. The server also migrates when it
 * opens storage; migrations hold an advisory lock, so running both is safe.
 * Without `DATABASE_URL` there is nothing to migrate (SQLite creates its own
 * tables), so the command succeeds without doing anything.
 */
export interface MigrateResult {
  readonly status: "skipped" | "migrated";
  readonly schemaVersion?: number;
  readonly applied?: readonly number[];
}

export interface RunMigrationsOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly log?: (message: string) => void;
  /** Overrides how storage is opened; for tests. */
  readonly open?: (connectionString: string) => Promise<PostgresStorage>;
}

export async function runMigrations(options: RunMigrationsOptions = {}): Promise<MigrateResult> {
  const env = options.env ?? process.env;
  const log = options.log ?? console.log;
  const databaseUrl = env["DATABASE_URL"]?.trim();
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    log("DATABASE_URL is not set, so there is no Postgres schema to migrate.");
    return { status: "skipped" };
  }

  const open =
    options.open ??
    ((connectionString: string) => openPostgresStorage({ connectionString, migrate: false }));
  const storage = await open(databaseUrl);
  try {
    const result = await storage.migrate();
    const schemaVersion = await storage.schemaVersion();
    log(
      result.applied.length === 0
        ? `Postgres schema is up to date at version ${schemaVersion}.`
        : `Applied migrations ${result.applied.join(", ")}. Postgres schema is at version ${schemaVersion}.`,
    );
    return { status: "migrated", schemaVersion, applied: result.applied };
  } finally {
    await storage.close();
  }
}

const isCli =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCli) {
  runMigrations().catch((error) => {
    console.error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
