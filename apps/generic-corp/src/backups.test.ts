import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  openPostgresStorage,
  quoteIdentifier,
  resolvePostgresConnection,
} from "@generic-ai/plugin-storage-postgres";
import { afterEach, describe, expect, it } from "vitest";

import {
  type BackupDatabase,
  BackupError,
  createBackup,
  createCompanyBackups,
  listBackups,
  nextBackupTime,
  pruneBackups,
  readBackupSettings,
  verifyBackup,
} from "./backups.js";
import { restoreBackup, runRestoreCli } from "./restore.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "generic-corp-backups-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A data directory with a SQLite database and some company files. */
function sqliteCompany(): { dataDir: string; database: BackupDatabase & { driver: "sqlite" } } {
  const dataDir = tempDir();
  const dbPath = path.join(dataDir, "company.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
  db.prepare("INSERT INTO notes (body) VALUES (?)").run("before");
  db.close();
  mkdirSync(path.join(dataDir, "company", "drive", "goals", "g1", "deliverables"), {
    recursive: true,
  });
  writeFileSync(
    path.join(dataDir, "company", "drive", "goals", "g1", "deliverables", "brief.md"),
    "# Brief\n",
  );
  mkdirSync(path.join(dataDir, "company", "agents", "ceo", "sessions"), { recursive: true });
  writeFileSync(path.join(dataDir, "company", "agents", "ceo", "MEMORY.md"), "remember this\n");
  mkdirSync(path.join(dataDir, "sessions"), { recursive: true });
  writeFileSync(path.join(dataDir, "sessions", "s1.jsonl"), "{}\n");
  writeFileSync(path.join(dataDir, "model-auth.json"), '{"secret":true}');
  return { dataDir, database: { driver: "sqlite", path: dbPath } };
}

function notes(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare("SELECT body FROM notes ORDER BY id").all() as { body: string }[]).map(
      (row) => row.body,
    );
  } finally {
    db.close();
  }
}

describe("backup settings", () => {
  it("defaults to nightly at 3:00, keeping 7, in the data directory", () => {
    expect(readBackupSettings({}, "/data")).toEqual({
      enabled: true,
      dir: path.resolve("/data/backups"),
      keep: 7,
      hour: 3,
    });
    expect(
      readBackupSettings(
        {
          GENERIC_CORP_BACKUPS: "off",
          GENERIC_CORP_BACKUP_DIR: "/mnt/backups",
          GENERIC_CORP_BACKUP_KEEP: "30",
          GENERIC_CORP_BACKUP_HOUR: "0",
        },
        "/data",
      ),
    ).toEqual({ enabled: false, dir: path.resolve("/mnt/backups"), keep: 30, hour: 0 });
  });

  it("rejects bad values and a backup folder agents could write to", () => {
    expect(() => readBackupSettings({ GENERIC_CORP_BACKUP_HOUR: "24" }, "/data")).toThrow(
      BackupError,
    );
    expect(() => readBackupSettings({ GENERIC_CORP_BACKUP_KEEP: "0" }, "/data")).toThrow(
      BackupError,
    );
    expect(() => readBackupSettings({ GENERIC_CORP_BACKUPS: "sometimes" }, "/data")).toThrow(
      BackupError,
    );
    expect(() =>
      readBackupSettings({ GENERIC_CORP_BACKUP_DIR: "/data/company/drive/backups" }, "/data"),
    ).toThrow(/outside the company folder/);
  });

  it("schedules the next backup for the next occurrence of the hour", () => {
    const evening = new Date(2026, 10, 27, 22, 15);
    expect(nextBackupTime(evening, 3)).toEqual(new Date(2026, 10, 28, 3, 0));
    const early = new Date(2026, 10, 27, 1, 0);
    expect(nextBackupTime(early, 3)).toEqual(new Date(2026, 10, 27, 3, 0));
    const onTheHour = new Date(2026, 10, 27, 3, 0);
    expect(nextBackupTime(onTheHour, 3)).toEqual(new Date(2026, 10, 28, 3, 0));
  });
});

describe("SQLite backups", () => {
  it("backs up the database and company files, and restores them", async () => {
    const { dataDir, database } = sqliteCompany();
    const dir = path.join(dataDir, "backups");
    const manifest = await createBackup({ dataDir, dir, database, reason: "manual" });
    expect(manifest.database.driver).toBe("sqlite");
    expect(manifest.folders).toEqual(["company", "sessions"]);
    expect(manifest.files.map((file) => file.name)).toEqual(["database.sqlite.gz", "files.tar.gz"]);
    await verifyBackup(path.join(dir, manifest.id));

    // Work goes on after the backup.
    const db = new DatabaseSync(database.path);
    db.prepare("INSERT INTO notes (body) VALUES (?)").run("after");
    db.close();
    writeFileSync(
      path.join(dataDir, "company", "drive", "goals", "g1", "deliverables", "brief.md"),
      "changed",
    );
    writeFileSync(path.join(dataDir, "company", "drive", "new.md"), "new");
    mkdirSync(path.join(dataDir, "artifacts"));

    const logs: string[] = [];
    const result = await restoreBackup({
      backupDir: path.join(dir, manifest.id),
      dataDir,
      database,
      safetyBackupDir: dir,
      log: (line) => logs.push(line),
    });
    expect(notes(database.path)).toEqual(["before"]);
    expect(
      readFileSync(
        path.join(dataDir, "company", "drive", "goals", "g1", "deliverables", "brief.md"),
        "utf8",
      ),
    ).toBe("# Brief\n");
    expect(existsSync(path.join(dataDir, "company", "drive", "new.md"))).toBe(false);
    expect(existsSync(path.join(dataDir, "artifacts"))).toBe(false);
    expect(readFileSync(path.join(dataDir, "company", "agents", "ceo", "MEMORY.md"), "utf8")).toBe(
      "remember this\n",
    );
    // The sign-in is not part of a backup and a restore leaves it alone.
    expect(readFileSync(path.join(dataDir, "model-auth.json"), "utf8")).toBe('{"secret":true}');

    // The state from before the restore was kept, so the restore can be undone.
    expect(result.safetyBackup).toBeDefined();
    await restoreBackup({
      backupDir: path.join(dir, result.safetyBackup as string),
      dataDir,
      database,
    });
    expect(notes(database.path)).toEqual(["before", "after"]);
    expect(readFileSync(path.join(dataDir, "company", "drive", "new.md"), "utf8")).toBe("new");
  });

  it("refuses a damaged backup and one of the other database", async () => {
    const { dataDir, database } = sqliteCompany();
    const dir = path.join(dataDir, "backups");
    const manifest = await createBackup({ dataDir, dir, database, reason: "manual" });
    const backupDir = path.join(dir, manifest.id);
    await expect(
      restoreBackup({
        backupDir,
        dataDir,
        database: { driver: "postgres", connectionString: "postgres://nowhere/db" },
      }),
    ).rejects.toThrow(/Unset DATABASE_URL/);

    await appendFile(path.join(backupDir, "files.tar.gz"), "x");
    await expect(verifyBackup(backupDir)).rejects.toThrow(/damaged/);
    await expect(restoreBackup({ backupDir, dataDir, database })).rejects.toThrow(/damaged/);
    expect(notes(database.path)).toEqual(["before"]);
  });

  it("leaves nothing behind when a backup fails", async () => {
    const dataDir = tempDir();
    const dir = path.join(dataDir, "backups");
    await expect(
      createBackup({
        dataDir,
        dir,
        database: { driver: "sqlite", path: path.join(dataDir, "missing.sqlite") },
        reason: "manual",
      }),
    ).rejects.toThrow(/does not exist/);
    expect(await listBackups(dir)).toEqual([]);
  });

  it("keeps only the newest backups", async () => {
    const { dataDir, database } = sqliteCompany();
    const dir = path.join(dataDir, "backups");
    let clock = Date.parse("2026-11-01T03:00:00Z");
    for (let day = 0; day < 4; day += 1) {
      await createBackup({
        dataDir,
        dir,
        database,
        reason: "nightly",
        now: () => new Date(clock),
      });
      clock += 86_400_000;
    }
    const removed = await pruneBackups(dir, 2);
    expect(removed).toHaveLength(2);
    const left = await listBackups(dir);
    expect(left.map((backup) => backup.createdAt)).toEqual([
      "2026-11-04T03:00:00.000Z",
      "2026-11-03T03:00:00.000Z",
    ]);
  });
});

describe("the backup schedule", () => {
  it("makes one backup at a time, prunes, reports status and notifies", async () => {
    const { dataDir, database } = sqliteCompany();
    const dir = path.join(dataDir, "backups");
    const changes: boolean[] = [];
    let clock = Date.parse("2026-11-01T10:00:00Z");
    const backups = createCompanyBackups({
      dataDir,
      database,
      settings: { enabled: true, dir, keep: 2, hour: 3 },
      now: () => new Date(clock),
      onChange: (status) => changes.push(status.running),
      checkEveryMs: 60_000,
      firstBackupDelayMs: 60_000,
    });
    backups.start();
    cleanups.push(() => backups.stop());

    const before = await backups.status();
    expect(before.backups).toEqual([]);
    expect(before.nextAt).toBe("2026-11-01T10:01:00.000Z");

    const first = backups.run("manual");
    const again = backups.run("manual");
    expect(again).toBe(first);
    expect((await backups.status()).running).toBe(true);
    await first;
    for (let index = 0; index < 3; index += 1) {
      clock += 1_000;
      await backups.run("manual");
    }
    const after = await backups.status();
    expect(after.running).toBe(false);
    expect(after.backups).toHaveLength(2);
    expect(after.nextAt).toBe(
      nextBackupTime(new Date(after.backups[0]?.createdAt as string), 3).toISOString(),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(changes).toContain(true);
    expect(changes.at(-1)).toBe(false);
  });

  it("reports the last failure until a backup succeeds", async () => {
    const dataDir = tempDir();
    const backups = createCompanyBackups({
      dataDir,
      database: { driver: "sqlite", path: path.join(dataDir, "missing.sqlite") },
      settings: { enabled: false, dir: path.join(dataDir, "backups"), keep: 7, hour: 3 },
    });
    await expect(backups.run()).rejects.toThrow(/does not exist/);
    const status = await backups.status();
    expect(status.lastError?.message).toMatch(/does not exist/);
    expect(status.nextAt).toBeUndefined();
  });
});

describe("restore command", () => {
  it("lists backups, explains a restore, and restores only with --yes", async () => {
    const { dataDir, database } = sqliteCompany();
    const env = { GENERIC_CORP_DATA_DIR: dataDir };
    const logs: string[] = [];
    const log = (line: string) => logs.push(line);

    expect(await runRestoreCli({ argv: [], env, log })).toBe(0);
    expect(logs.join("\n")).toMatch(/No backups/);

    const manifest = await createBackup({
      dataDir,
      dir: path.join(dataDir, "backups"),
      database,
      reason: "nightly",
    });
    const db = new DatabaseSync(database.path);
    db.prepare("INSERT INTO notes (body) VALUES (?)").run("after");
    db.close();

    logs.length = 0;
    expect(await runRestoreCli({ argv: [], env, log })).toBe(0);
    expect(logs.join("\n")).toContain(manifest.id);

    logs.length = 0;
    expect(await runRestoreCli({ argv: ["latest"], env, log })).toBe(0);
    expect(logs.join("\n")).toMatch(/Nothing changed/);
    expect(notes(database.path)).toEqual(["before", "after"]);

    logs.length = 0;
    expect(await runRestoreCli({ argv: [manifest.id, "--yes"], env, log })).toBe(0);
    expect(notes(database.path)).toEqual(["before"]);
    expect(logs.join("\n")).toMatch(/To undo, restore/);
    expect(await runRestoreCli({ argv: ["--bogus"], env, log })).toBe(2);
  });
});

const postgresUrl = process.env["GENERIC_AI_TEST_POSTGRES_URL"];

describe.skipIf(postgresUrl === undefined)("Postgres backups", () => {
  it("exports every table and restores it, sequences included", async () => {
    const url = postgresUrl as string;
    const schema = `gc_backup_${randomBytes(5).toString("hex")}`;
    const database: BackupDatabase = { driver: "postgres", connectionString: url, schema };
    const { pool } = resolvePostgresConnection({ connectionString: url, schema });
    cleanups.push(async () => {
      await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      await pool.end();
    });

    const storage = await openPostgresStorage({ connectionString: url, schema });
    const queue = storage.queue<{ n: number }>({ leaseMs: 60_000 });
    await storage.storage.set({
      key: { namespace: "generic-corp", collection: "agents", id: "ceo" },
      value: { title: "CEO", note: 'quotes " and \\ backslashes' },
      updatedAt: new Date().toISOString(),
    });
    await queue.enqueue({ name: "turn", payload: { n: 1 } });
    await queue.enqueue({ name: "turn", payload: { n: 2 } });
    await storage.pool.query(
      `INSERT INTO ${quoteIdentifier(schema)}.runs
         (run_id, root_scope_id, status, envelope, version, created_at, updated_at)
       VALUES ('run-1', 'scope', 'succeeded', '{"a":[1,2]}', 1,
               '2026-11-27T03:04:05.678+00', '2026-11-27T03:04:06.789+00')`,
    );
    await storage.close();

    const dataDir = tempDir();
    mkdirSync(path.join(dataDir, "company", "drive"), { recursive: true });
    writeFileSync(path.join(dataDir, "company", "drive", "a.md"), "a");
    const dir = path.join(dataDir, "backups");
    const manifest = await createBackup({ dataDir, dir, database, reason: "manual" });
    expect(manifest.database.rows).toMatchObject({ kv_records: 1, queue_jobs: 2 });
    expect(manifest.database.schemaVersion).toBeGreaterThan(0);

    const changed = await openPostgresStorage({ connectionString: url, schema });
    await changed.storage.delete({ namespace: "generic-corp", collection: "agents", id: "ceo" });
    await changed.close();

    const result = await restoreBackup({
      backupDir: path.join(dir, manifest.id),
      dataDir,
      database,
      safetyBackupDir: dir,
    });
    expect(result.rows).toMatchObject({ kv_records: 1, queue_jobs: 2 });

    const restored = await openPostgresStorage({ connectionString: url, schema });
    const record = await restored.storage.get({
      namespace: "generic-corp",
      collection: "agents",
      id: "ceo",
    });
    expect(record?.value).toEqual({ title: "CEO", note: 'quotes " and \\ backslashes' });
    // The queue's sequence moved past the restored jobs, so new jobs still come after them.
    const restoredQueue = restored.queue<{ n: number }>({ leaseMs: 60_000 });
    await restoredQueue.enqueue({ name: "turn", payload: { n: 3 } });
    const seqs = await restored.pool.query<{ seq: string }>(
      `SELECT seq FROM ${quoteIdentifier(schema)}.queue_jobs ORDER BY seq`,
    );
    expect(new Set(seqs.rows.map((row) => row.seq)).size).toBe(3);
    expect(await restored.schemaVersion()).toBe(manifest.database.schemaVersion);
    const runs = await restored.pool.query<{ envelope: unknown; created: string }>(
      `SELECT envelope, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS created
         FROM ${quoteIdentifier(schema)}.runs`,
    );
    expect(runs.rows).toEqual([{ envelope: { a: [1, 2] }, created: "2026-11-27T03:04:05.678" }]);
    await restored.close();
  });
});
