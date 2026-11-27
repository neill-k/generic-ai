import { rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolvePostgresConnection } from "@generic-ai/plugin-storage-postgres";

import {
  BACKUP_FOLDERS,
  type BackupDatabase,
  BackupError,
  type BackupManifest,
  checkSqlite,
  createBackup,
  FILES_ARCHIVE,
  folderExists,
  gunzipFile,
  listBackups,
  POSTGRES_DUMP_FILE,
  readBackupSettings,
  restorePostgres,
  runTar,
  SQLITE_DUMP_FILE,
  verifyBackup,
} from "./backups.js";

/**
 * Puts a backup back: `node dist/restore.js <backup>` (see backups.ts).
 *
 * Stop the server first. The command checks the backup against its manifest, makes a fresh
 * backup of what is there now (so a restore can itself be undone), then replaces the database
 * and the company's folders. Without `--yes` it only says what it would do.
 */
export interface RestoreBackupOptions {
  /** A backup folder. */
  readonly backupDir: string;
  readonly dataDir: string;
  readonly database: BackupDatabase;
  /** Where the safety backup of the current state goes. Skipped when undefined. */
  readonly safetyBackupDir?: string;
  readonly log?: (message: string) => void;
}

export interface RestoreResult {
  readonly manifest: BackupManifest;
  readonly safetyBackup?: string;
  readonly rows?: Readonly<Record<string, number>>;
}

export async function restoreBackup(options: RestoreBackupOptions): Promise<RestoreResult> {
  const log = options.log ?? (() => undefined);
  const manifest = await verifyBackup(options.backupDir);
  if (manifest.database.driver !== options.database.driver) {
    throw new BackupError(
      manifest.database.driver === "postgres"
        ? "This backup is of a Postgres database. Set DATABASE_URL to restore it."
        : "This backup is of a SQLite database. Unset DATABASE_URL to restore it.",
    );
  }

  let safetyBackup: string | undefined;
  if (options.safetyBackupDir !== undefined) {
    const current = await createBackup({
      dataDir: options.dataDir,
      dir: options.safetyBackupDir,
      database: options.database,
      reason: "before-restore",
    }).catch((error: unknown) => {
      // A first restore onto an empty machine has nothing to keep.
      const message = error instanceof Error ? error.message : String(error);
      if (/does not exist|has no Generic Corp tables/.test(message)) {
        return undefined;
      }
      throw new BackupError(
        `Could not back up the current state before restoring, so nothing was changed: ${message}`,
      );
    });
    if (current !== undefined) {
      safetyBackup = current.id;
      log(`Saved the current state as backup ${current.id}, in case you want it back.`);
    }
  }

  let rows: Record<string, number> | undefined;
  const database = options.database;
  if (database.driver === "postgres") {
    const { pool, ownsPool, schema } = resolvePostgresConnection({
      connectionString: database.connectionString,
      ...(database.schema === undefined ? {} : { schema: database.schema }),
      maxConnections: 1,
    });
    try {
      rows = await restorePostgres(
        pool,
        schema,
        path.join(options.backupDir, POSTGRES_DUMP_FILE),
        manifest.database.schemaVersion ?? 0,
      );
    } finally {
      if (ownsPool) {
        await pool.end();
      }
    }
    log(
      `Database restored: ${Object.entries(rows)
        .map(([table, count]) => `${count} ${table}`)
        .join(", ")}.`,
    );
  } else {
    const restoring = `${database.path}.restoring`;
    await gunzipFile(path.join(options.backupDir, SQLITE_DUMP_FILE), restoring);
    checkSqlite(restoring);
    await rm(`${database.path}-wal`, { force: true });
    await rm(`${database.path}-shm`, { force: true });
    await rename(restoring, database.path);
    log(`Database restored to ${database.path}.`);
  }

  // The company's folders: the ones in the backup replace what is there now. A folder the
  // backup does not have (say, no run artifacts yet) is cleared too, so nothing from after the
  // backup is mixed in.
  for (const folder of BACKUP_FOLDERS) {
    const target = path.join(options.dataDir, folder);
    if (await folderExists(target)) {
      await rm(target, { recursive: true, force: true });
    }
  }
  if (manifest.files.some((file) => file.name === FILES_ARCHIVE)) {
    await runTar([
      "-xzf",
      path.join(options.backupDir, FILES_ARCHIVE),
      "-C",
      options.dataDir,
      "--no-same-owner",
    ]);
  }
  log(`Files restored: ${manifest.folders.join(", ") || "none"}.`);
  return {
    manifest,
    ...(safetyBackup === undefined ? {} : { safetyBackup }),
    ...(rows ? { rows } : {}),
  };
}

// --- Command line ---------------------------------------------------------

const USAGE = `Usage: node dist/restore.js [<backup>|latest] [--yes] [--no-safety-backup]

  <backup>            A backup id from the list, or the path of a backup folder.
  --yes               Replace the database and files. Without it, nothing changes.
  --no-safety-backup  Skip the backup of the current state taken first.

Stop the server before restoring. With no backup named, lists the backups.`;

export interface RestoreCliOptions {
  readonly argv: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly log?: (message: string) => void;
}

/** Runs the restore command. Returns the process exit code. */
export async function runRestoreCli(options: RestoreCliOptions): Promise<number> {
  const env = options.env ?? process.env;
  const log = options.log ?? console.log;
  const args = options.argv.filter((arg) => !arg.startsWith("--"));
  const flags = new Set(options.argv.filter((arg) => arg.startsWith("--")));
  for (const flag of flags) {
    if (!["--yes", "--no-safety-backup", "--help"].includes(flag)) {
      log(`Unknown option ${flag}.\n\n${USAGE}`);
      return 2;
    }
  }
  if (flags.has("--help") || args.length > 1) {
    log(USAGE);
    return flags.has("--help") ? 0 : 2;
  }

  // The same variables, and defaults, as the server (server.ts).
  const dataDir = path.resolve(
    env["GENERIC_CORP_DATA_DIR"]?.trim() || path.join(homedir(), ".generic-corp"),
  );
  const settings = readBackupSettings(env, dataDir);
  const databaseUrl = env["DATABASE_URL"]?.trim();
  const database: BackupDatabase =
    databaseUrl === undefined || databaseUrl.length === 0
      ? { driver: "sqlite", path: path.join(dataDir, "company.sqlite") }
      : { driver: "postgres", connectionString: databaseUrl };

  const backups = await listBackups(settings.dir);
  const [name] = args;
  if (name === undefined) {
    if (backups.length === 0) {
      log(`No backups in ${settings.dir}.`);
      return 0;
    }
    log(`Backups in ${settings.dir}, newest first:`);
    for (const backup of backups) {
      const bytes = backup.files.reduce((total, file) => total + file.bytes, 0);
      log(
        `  ${backup.id}  ${backup.reason}  ${backup.database.driver}  ${(bytes / 1_048_576).toFixed(1)} MB`,
      );
    }
    log("\nRestore one with: node dist/restore.js <id> --yes");
    return 0;
  }

  let backupDir: string;
  if (name === "latest") {
    const [latest] = backups;
    if (latest === undefined) {
      log(`No backups in ${settings.dir}.`);
      return 1;
    }
    backupDir = path.join(settings.dir, latest.id);
  } else if (backups.some((backup) => backup.id === name)) {
    backupDir = path.join(settings.dir, name);
  } else {
    backupDir = path.resolve(name);
  }

  const manifest = await verifyBackup(backupDir);
  log(
    [
      `Backup ${manifest.id} (${manifest.reason}, ${manifest.createdAt}) checks out.`,
      `It holds the ${manifest.database.driver} database and these folders: ${manifest.folders.join(", ") || "none"}.`,
      `Restoring replaces the ${database.driver === "postgres" ? "Postgres database" : `database at ${database.path}`} and the folders ${BACKUP_FOLDERS.join(", ")} in ${dataDir}.`,
    ].join("\n"),
  );
  if (!flags.has("--yes")) {
    log("\nNothing changed. Stop the server, then run this again with --yes.");
    return 0;
  }
  const result = await restoreBackup({
    backupDir,
    dataDir,
    database,
    ...(flags.has("--no-safety-backup") ? {} : { safetyBackupDir: settings.dir }),
    log,
  });
  log(
    [
      "",
      `Restored backup ${result.manifest.id}. Start the server again.`,
      "Sign in to Claude again from Settings: backups leave the sign-in out.",
      ...(result.safetyBackup === undefined
        ? []
        : [`To undo, restore ${result.safetyBackup} the same way.`]),
    ].join("\n"),
  );
  return 0;
}

const isCli =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCli) {
  runRestoreCli({ argv: process.argv.slice(2) })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`Restore failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
