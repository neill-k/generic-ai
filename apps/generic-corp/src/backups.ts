import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

import {
  getPostgresSchemaVersion,
  LATEST_POSTGRES_SCHEMA_VERSION,
  type PostgresPool,
  type PostgresPoolClient,
  postgresMigrations,
  quoteIdentifier,
  resolvePostgresConnection,
} from "@generic-ai/plugin-storage-postgres";

/**
 * Nightly backups of everything the company keeps (design decision 55): the database and the
 * company's files (the shared drive, every agent's home with its sessions and memory, and the
 * run artifacts). A backup is one folder:
 *
 * - `database.jsonl.gz` (Postgres): every row of every table in the app's schema, as JSON. It
 *   does not depend on the Postgres version, so a backup from Postgres 17 restores into 16.
 * - `database.sqlite.gz` (SQLite): a consistent copy made with `VACUUM INTO`.
 * - `files.tar.gz`: the `company`, `sessions` and `artifacts` folders of the data directory.
 * - `manifest.json`: what is in it, with a SHA-256 for every file. Written last, so a folder
 *   without one is not a backup.
 *
 * The Claude sign-in (`model-auth.json`) is left out on purpose: it is a live credential, and
 * signing in again after a restore takes a minute. Restoring is `node dist/restore.js` (see
 * restore.ts and RUN-LOCALLY.md).
 */

export const BACKUP_FORMAT = 1;
export const BACKUP_MANIFEST = "manifest.json";
export const POSTGRES_DUMP_FILE = "database.jsonl.gz";
export const SQLITE_DUMP_FILE = "database.sqlite.gz";
export const FILES_ARCHIVE = "files.tar.gz";
/** Folders of the data directory that a backup holds, when they exist. */
export const BACKUP_FOLDERS = Object.freeze(["company", "sessions", "artifacts"]);

const PARTIAL_SUFFIX = ".partial";
const ROWS_PER_FETCH = 500;

export const BACKUP_ENV = Object.freeze({
  enabled: "GENERIC_CORP_BACKUPS",
  dir: "GENERIC_CORP_BACKUP_DIR",
  keep: "GENERIC_CORP_BACKUP_KEEP",
  hour: "GENERIC_CORP_BACKUP_HOUR",
});

export type BackupReason = "nightly" | "first" | "manual" | "before-restore";

/** Where the database lives, as the server opens it. */
export type BackupDatabase =
  | { readonly driver: "sqlite"; readonly path: string }
  | { readonly driver: "postgres"; readonly connectionString: string; readonly schema?: string };

export interface BackupSettings {
  /** Nightly backups run. Backups can still be made by hand when off. */
  readonly enabled: boolean;
  /** Where backups are written. Defaults to `<dataDir>/backups`. */
  readonly dir: string;
  /** Backups kept; older ones are deleted after each new one. Defaults to 7. */
  readonly keep: number;
  /** Hour of the day (server time, 0-23) the nightly backup runs. Defaults to 3. */
  readonly hour: number;
}

export interface BackupFileEntry {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface BackupManifest {
  readonly format: number;
  readonly id: string;
  readonly createdAt: string;
  readonly reason: BackupReason;
  readonly durationMs: number;
  readonly database: {
    readonly driver: "postgres" | "sqlite";
    /** Postgres only: the schema migration the rows belong to. */
    readonly schemaVersion?: number;
    /** Postgres only: rows per table. */
    readonly rows?: Readonly<Record<string, number>>;
  };
  /** Data-directory folders inside `files.tar.gz`. */
  readonly folders: readonly string[];
  readonly files: readonly BackupFileEntry[];
}

export interface BackupSummary {
  readonly id: string;
  readonly createdAt: string;
  readonly reason: BackupReason;
  readonly bytes: number;
  readonly durationMs: number;
}

export interface BackupStatus {
  readonly enabled: boolean;
  readonly dir: string;
  readonly keep: number;
  readonly hour: number;
  readonly running: boolean;
  /** When the next nightly backup is due, while nightly backups are on. */
  readonly nextAt?: string;
  /** The last attempt's error, until a backup succeeds. */
  readonly lastError?: { readonly at: string; readonly message: string };
  /** Newest first. */
  readonly backups: readonly BackupSummary[];
}

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

/** Reads backup settings from the environment. Throws `BackupError` on a bad value. */
export function readBackupSettings(env: NodeJS.ProcessEnv, dataDir: string): BackupSettings {
  const enabledRaw = readEnv(env, BACKUP_ENV.enabled)?.toLowerCase();
  let enabled = true;
  if (enabledRaw !== undefined) {
    if (["1", "true", "yes", "on"].includes(enabledRaw)) {
      enabled = true;
    } else if (["0", "false", "no", "off"].includes(enabledRaw)) {
      enabled = false;
    } else {
      throw new BackupError(`${BACKUP_ENV.enabled} must be on or off.`);
    }
  }
  const keepRaw = readEnv(env, BACKUP_ENV.keep);
  const keep = keepRaw === undefined ? 7 : Number(keepRaw);
  if (!Number.isInteger(keep) || keep < 1 || keep > 365) {
    throw new BackupError(`${BACKUP_ENV.keep} must be a whole number from 1 to 365.`);
  }
  const hourRaw = readEnv(env, BACKUP_ENV.hour);
  const hour = hourRaw === undefined ? 3 : Number(hourRaw);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new BackupError(`${BACKUP_ENV.hour} must be a whole number from 0 to 23.`);
  }
  const dirRaw = readEnv(env, BACKUP_ENV.dir);
  const dir = path.resolve(dirRaw ?? path.join(dataDir, "backups"));
  const company = path.resolve(dataDir, "company");
  if (dir === company || dir.startsWith(`${company}${path.sep}`)) {
    // Agents can write anywhere under the company folder, so backups there could be changed.
    throw new BackupError(`${BACKUP_ENV.dir} must be outside the company folder (${company}).`);
  }
  return { enabled, dir, keep, hour };
}

/** The first `hour`:00 (server time) after `after`. */
export function nextBackupTime(after: Date, hour: number): Date {
  const next = new Date(after);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= after.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

function backupId(at: Date): string {
  return at.toISOString().replaceAll(":", "-").replace(".", "-");
}

async function sha256File(file: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function gzipFile(source: string, target: string): Promise<void> {
  await pipeline(createReadStream(source), createGzip(), createWriteStream(target));
}

export async function gunzipFile(source: string, target: string): Promise<void> {
  await pipeline(createReadStream(source), createGunzip(), createWriteStream(target));
}

/** Runs `tar` and resolves on success. GNU tar's exit code 1 (a file changed while read) passes. */
export function runTar(
  args: readonly string[],
  options: { readonly allowChanged?: boolean } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000);
    });
    child.on("error", (error) =>
      reject(new BackupError(`Could not run tar: ${error.message}. Install tar and gzip.`)),
    );
    child.on("close", (code) => {
      if (code === 0 || (code === 1 && options.allowChanged === true)) {
        resolve();
      } else {
        reject(new BackupError(`tar failed (exit ${code}): ${stderr.trim() || "no output"}`));
      }
    });
  });
}

// --- Postgres -------------------------------------------------------------

interface PostgresDumpResult {
  readonly schemaVersion: number;
  readonly rows: Record<string, number>;
}

/**
 * Writes every row of every table in `schema` as one JSON line `{"table": ..., "row": ...}`,
 * from one consistent snapshot.
 */
export async function dumpPostgres(
  pool: PostgresPool,
  schema: string,
  file: string,
): Promise<PostgresDumpResult> {
  const gzip = createGzip();
  const written = pipeline(gzip, createWriteStream(file));
  const write = (text: string) =>
    new Promise<void>((resolve, reject) => {
      gzip.write(text, (error) => (error ? reject(error) : resolve()));
    });
  const client = await pool.connect();
  const rows: Record<string, number> = {};
  let schemaVersion = 0;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    schemaVersion = await getPostgresSchemaVersion(client, schema);
    if (schemaVersion === 0) {
      throw new BackupError(`The database has no Generic Corp tables in schema "${schema}".`);
    }
    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
      [schema],
    );
    const s = quoteIdentifier(schema);
    for (const { table_name: table } of tables.rows) {
      rows[table] = 0;
      await client.query(
        `DECLARE backup_rows NO SCROLL CURSOR FOR
           SELECT row_to_json(t)::text AS row FROM ${s}.${quoteIdentifier(table)} t`,
      );
      const prefix = `{"table":${JSON.stringify(table)},"row":`;
      for (;;) {
        const batch = await client.query<{ row: string }>(
          `FETCH ${ROWS_PER_FETCH} FROM backup_rows`,
        );
        if (batch.rows.length === 0) {
          break;
        }
        await write(batch.rows.map((entry) => `${prefix}${entry.row}}\n`).join(""));
        rows[table] += batch.rows.length;
      }
      await client.query("CLOSE backup_rows");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    gzip.destroy();
    await written.catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  gzip.end();
  await written;
  return { schemaVersion, rows };
}

async function* readDumpLines(
  file: string,
): AsyncGenerator<{ readonly table: string; readonly row: Record<string, unknown> }> {
  const lines = createInterface({
    input: createReadStream(file).pipe(createGunzip()),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of lines) {
    if (line.length === 0) {
      continue;
    }
    const parsed = JSON.parse(line) as { table?: unknown; row?: unknown };
    if (typeof parsed.table !== "string" || typeof parsed.row !== "object" || !parsed.row) {
      throw new BackupError("The database dump has a line that is not a table row.");
    }
    yield { table: parsed.table, row: parsed.row as Record<string, unknown> };
  }
}

async function applyMigrations(
  client: PostgresPoolClient,
  s: string,
  from: number,
  to: number,
): Promise<void> {
  for (const migration of postgresMigrations) {
    if (migration.version <= from || migration.version > to) {
      continue;
    }
    await client.query(migration.sql(s));
    await client.query(`INSERT INTO ${s}.schema_migrations (version, name) VALUES ($1, $2)`, [
      migration.version,
      migration.name,
    ]);
  }
}

/**
 * Replaces everything in `schema` with the rows of a dump, in one transaction: the schema is
 * rebuilt at the dump's migration, the rows go in, sequences move past them, and the remaining
 * migrations run. If anything fails, the database is left as it was.
 */
export async function restorePostgres(
  pool: PostgresPool,
  schema: string,
  file: string,
  schemaVersion: number,
): Promise<Record<string, number>> {
  if (schemaVersion > LATEST_POSTGRES_SCHEMA_VERSION) {
    throw new BackupError(
      `This backup comes from a newer Generic Corp (database schema ${schemaVersion}; this one knows up to ${LATEST_POSTGRES_SCHEMA_VERSION}). Update Generic Corp, then restore.`,
    );
  }
  const s = quoteIdentifier(schema);
  const client = await pool.connect();
  const restored: Record<string, number> = {};
  try {
    await client.query("BEGIN");
    await client.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    await client.query(`CREATE SCHEMA ${s}`);
    await client.query(`
      CREATE TABLE ${s}.schema_migrations (
        version integer PRIMARY KEY,
        name text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await applyMigrations(client, s, 0, schemaVersion);

    let table: string | undefined;
    let batch: Record<string, unknown>[] = [];
    let batchChars = 0;
    const flush = async () => {
      if (table === undefined || batch.length === 0) {
        return;
      }
      const target = `${s}.${quoteIdentifier(table)}`;
      await client.query(
        `INSERT INTO ${target} SELECT * FROM json_populate_recordset(NULL::${target}, $1::json)`,
        [JSON.stringify(batch)],
      );
      restored[table] = (restored[table] ?? 0) + batch.length;
      batch = [];
      batchChars = 0;
    };
    for await (const entry of readDumpLines(file)) {
      // The migrations above rebuilt this table's history.
      if (entry.table === "schema_migrations") {
        continue;
      }
      if (entry.table !== table) {
        await flush();
        table = entry.table;
      }
      batch.push(entry.row);
      batchChars += JSON.stringify(entry.row).length;
      if (batch.length >= ROWS_PER_FETCH || batchChars > 4_000_000) {
        await flush();
      }
    }
    await flush();

    const serials = await client.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = $1 AND column_default LIKE 'nextval(%'`,
      [schema],
    );
    for (const { table_name: name, column_name: column } of serials.rows) {
      const target = `${s}.${quoteIdentifier(name)}`;
      const col = quoteIdentifier(column);
      await client.query(
        `SELECT setval(pg_get_serial_sequence($1, $2),
                       COALESCE((SELECT max(${col}) FROM ${target}), 1),
                       (SELECT max(${col}) FROM ${target}) IS NOT NULL)`,
        [`${s}.${quoteIdentifier(name)}`, column],
      );
    }
    await applyMigrations(client, s, schemaVersion, LATEST_POSTGRES_SCHEMA_VERSION);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return restored;
}

// --- SQLite ---------------------------------------------------------------

/** A consistent copy of a live SQLite database, made with `VACUUM INTO`. */
export function copySqlite(source: string, target: string): void {
  if (!existsSync(source)) {
    throw new BackupError(`The database file ${source} does not exist.`);
  }
  const db = new DatabaseSync(source, { timeout: 30_000 });
  try {
    db.prepare("VACUUM INTO ?").run(target);
  } finally {
    db.close();
  }
}

/** Throws unless SQLite's integrity check passes for `file`. */
export function checkSqlite(file: string): void {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const result = db.prepare("PRAGMA integrity_check").get() as
      | { integrity_check?: unknown }
      | undefined;
    if (result?.integrity_check !== "ok") {
      throw new BackupError(`The database copy failed SQLite's integrity check.`);
    }
  } finally {
    db.close();
  }
}

// --- Reading backups ------------------------------------------------------

export async function readManifest(backupDir: string): Promise<BackupManifest> {
  let raw: string;
  try {
    raw = await readFile(path.join(backupDir, BACKUP_MANIFEST), "utf8");
  } catch {
    throw new BackupError(`${backupDir} is not a finished backup: it has no ${BACKUP_MANIFEST}.`);
  }
  const manifest = JSON.parse(raw) as BackupManifest;
  if (manifest.format !== BACKUP_FORMAT) {
    throw new BackupError(
      `${backupDir} uses backup format ${String(manifest.format)}, which this version cannot read.`,
    );
  }
  return manifest;
}

/** Checks every file of a backup against its manifest. */
export async function verifyBackup(backupDir: string): Promise<BackupManifest> {
  const manifest = await readManifest(backupDir);
  for (const entry of manifest.files) {
    const file = path.join(backupDir, entry.name);
    let actual: { bytes: number; sha256: string };
    try {
      actual = await sha256File(file);
    } catch {
      throw new BackupError(`${entry.name} is missing from the backup ${manifest.id}.`);
    }
    if (actual.sha256 !== entry.sha256 || actual.bytes !== entry.bytes) {
      throw new BackupError(`${entry.name} in the backup ${manifest.id} is damaged.`);
    }
  }
  return manifest;
}

/** Finished backups in `dir`, newest first. */
export async function listBackups(dir: string): Promise<BackupManifest[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const manifests: BackupManifest[] = [];
  for (const name of names) {
    if (name.endsWith(PARTIAL_SUFFIX)) {
      continue;
    }
    try {
      manifests.push(await readManifest(path.join(dir, name)));
    } catch {
      // Not a backup.
    }
  }
  return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function summarize(manifest: BackupManifest): BackupSummary {
  return {
    id: manifest.id,
    createdAt: manifest.createdAt,
    reason: manifest.reason,
    bytes: manifest.files.reduce((total, file) => total + file.bytes, 0),
    durationMs: manifest.durationMs,
  };
}

// --- Making backups -------------------------------------------------------

export interface CreateBackupOptions {
  readonly dataDir: string;
  readonly dir: string;
  readonly database: BackupDatabase;
  readonly reason: BackupReason;
  readonly now?: () => Date;
}

/** Makes one backup and returns its manifest. Nothing is left behind if it fails. */
export async function createBackup(options: CreateBackupOptions): Promise<BackupManifest> {
  const now = options.now ?? (() => new Date());
  const started = now();
  const id = backupId(started);
  const finalDir = path.join(options.dir, id);
  const workDir = `${finalDir}${PARTIAL_SUFFIX}`;
  await mkdir(options.dir, { recursive: true, mode: 0o700 });
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { mode: 0o700 });
  try {
    let database: BackupManifest["database"];
    const fileNames: string[] = [];
    if (options.database.driver === "postgres") {
      const { pool, ownsPool, schema } = resolvePostgresConnection({
        connectionString: options.database.connectionString,
        ...(options.database.schema === undefined ? {} : { schema: options.database.schema }),
        maxConnections: 1,
      });
      try {
        const dump = await dumpPostgres(pool, schema, path.join(workDir, POSTGRES_DUMP_FILE));
        database = { driver: "postgres", schemaVersion: dump.schemaVersion, rows: dump.rows };
      } finally {
        if (ownsPool) {
          await pool.end();
        }
      }
      fileNames.push(POSTGRES_DUMP_FILE);
    } else {
      const copy = path.join(workDir, "database.sqlite");
      copySqlite(options.database.path, copy);
      checkSqlite(copy);
      await gzipFile(copy, path.join(workDir, SQLITE_DUMP_FILE));
      await rm(copy, { force: true });
      database = { driver: "sqlite" };
      fileNames.push(SQLITE_DUMP_FILE);
    }

    const folders = BACKUP_FOLDERS.filter((folder) =>
      existsSync(path.join(options.dataDir, folder)),
    );
    if (folders.length > 0) {
      await runTar(["-czf", path.join(workDir, FILES_ARCHIVE), "-C", options.dataDir, ...folders], {
        allowChanged: true,
      });
      fileNames.push(FILES_ARCHIVE);
    }

    const files: BackupFileEntry[] = [];
    for (const name of fileNames) {
      files.push({ name, ...(await sha256File(path.join(workDir, name))) });
    }
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      id,
      createdAt: started.toISOString(),
      reason: options.reason,
      durationMs: Math.max(0, now().getTime() - started.getTime()),
      database,
      folders,
      files,
    };
    await writeFile(path.join(workDir, BACKUP_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(workDir, finalDir);
    return manifest;
  } catch (error) {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Deletes the oldest backups beyond `keep`. Returns the ids deleted. */
export async function pruneBackups(dir: string, keep: number): Promise<string[]> {
  const backups = await listBackups(dir);
  const removed: string[] = [];
  for (const old of backups.slice(keep)) {
    await rm(path.join(dir, old.id), { recursive: true, force: true });
    removed.push(old.id);
  }
  return removed;
}

// --- The nightly schedule -------------------------------------------------

export interface CompanyBackups {
  readonly settings: BackupSettings;
  status(): Promise<BackupStatus>;
  /** Makes a backup now. Waits for one already running instead of starting a second. */
  run(reason?: BackupReason): Promise<BackupManifest>;
  /** Starts the nightly schedule (when enabled). */
  start(): void;
  /** Stops the schedule and waits for a running backup to finish. */
  stop(): Promise<void>;
}

export interface CreateCompanyBackupsOptions {
  readonly dataDir: string;
  readonly database: BackupDatabase;
  readonly settings: BackupSettings;
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
  /** Called when a backup starts, finishes or fails. */
  readonly onChange?: (status: BackupStatus) => void;
  /** How often the schedule checks whether a backup is due. Defaults to 5 minutes. */
  readonly checkEveryMs?: number;
  /** Wait after start before the first backup when there is none yet. Defaults to 1 minute. */
  readonly firstBackupDelayMs?: number;
}

export function createCompanyBackups(options: CreateCompanyBackupsOptions): CompanyBackups {
  const { settings } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => undefined);
  let running: Promise<BackupManifest> | undefined;
  let lastError: { at: string; message: string } | undefined;
  let timer: NodeJS.Timeout | undefined;
  let startedAt: Date | undefined;

  const nextAt = async (): Promise<Date | undefined> => {
    if (!settings.enabled || startedAt === undefined) {
      return undefined;
    }
    const [latest] = await listBackups(settings.dir);
    if (latest === undefined) {
      return new Date(startedAt.getTime() + (options.firstBackupDelayMs ?? 60_000));
    }
    return nextBackupTime(new Date(latest.createdAt), settings.hour);
  };

  const status = async (): Promise<BackupStatus> => {
    const due = await nextAt();
    return {
      enabled: settings.enabled,
      dir: settings.dir,
      keep: settings.keep,
      hour: settings.hour,
      running: running !== undefined,
      ...(due === undefined ? {} : { nextAt: due.toISOString() }),
      ...(lastError === undefined ? {} : { lastError }),
      backups: (await listBackups(settings.dir)).map(summarize),
    };
  };

  const notify = () => {
    if (options.onChange !== undefined) {
      void status()
        .then(options.onChange)
        .catch(() => undefined);
    }
  };

  const run = (reason: BackupReason = "manual"): Promise<BackupManifest> => {
    if (running !== undefined) {
      return running;
    }
    const attempt = (async () => {
      try {
        const manifest = await createBackup({
          dataDir: options.dataDir,
          dir: settings.dir,
          database: options.database,
          reason,
          now,
        });
        lastError = undefined;
        const removed = await pruneBackups(settings.dir, settings.keep);
        log(
          `Backup ${manifest.id} saved in ${settings.dir}${removed.length > 0 ? `; removed ${removed.length} older` : ""}.`,
        );
        return manifest;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lastError = { at: now().toISOString(), message };
        log(`Backup failed: ${message}`);
        throw error;
      }
    })();
    running = attempt;
    notify();
    void attempt
      .catch(() => undefined)
      .finally(() => {
        running = undefined;
        notify();
      });
    return attempt;
  };

  const tick = async () => {
    if (running !== undefined) {
      return;
    }
    const due = await nextAt();
    if (due === undefined || now().getTime() < due.getTime()) {
      return;
    }
    // A failed attempt is retried on the next check rather than in a tight loop.
    if (lastError !== undefined && now().getTime() - Date.parse(lastError.at) < 30 * 60_000) {
      return;
    }
    const [latest] = await listBackups(settings.dir);
    await run(latest === undefined ? "first" : "nightly").catch(() => undefined);
  };

  return {
    settings,
    status,
    run,
    start() {
      if (!settings.enabled || timer !== undefined) {
        return;
      }
      startedAt = now();
      // Folders left by a backup that was cut off (the process stopped mid-way).
      void readdir(settings.dir)
        .then((names) =>
          Promise.all(
            names
              .filter((name) => name.endsWith(PARTIAL_SUFFIX))
              .map((name) => rm(path.join(settings.dir, name), { recursive: true, force: true })),
          ),
        )
        .catch(() => undefined);
      timer = setInterval(
        () => {
          void tick().catch(() => undefined);
        },
        options.checkEveryMs ?? 5 * 60_000,
      );
      timer.unref();
      const firstDelay = Math.min(options.firstBackupDelayMs ?? 60_000, 2_147_000_000);
      setTimeout(() => {
        if (timer !== undefined) {
          void tick().catch(() => undefined);
        }
      }, firstDelay + 1_000).unref();
    },
    async stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      await running?.catch(() => undefined);
    },
  };
}

/** Whether `folder` exists and is a folder. */
export async function folderExists(folder: string): Promise<boolean> {
  try {
    return (await stat(folder)).isDirectory();
  } catch {
    return false;
  }
}
