import type {
  JsonValue,
  StorageContract,
  StorageFilter,
  StorageKey,
  StorageRecord,
} from "@generic-ai/sdk";
import { type PostgresQueryable, quoteIdentifier, toJsonParam } from "./client.js";

type KvRow = {
  namespace: string;
  collection: string;
  id: string;
  value: unknown;
  metadata: Readonly<Record<string, JsonValue>> | null;
  updated_at: string;
};

/**
 * `StorageContract` over the `kv_records` table. Values must be
 * JSON-serializable.
 */
export class PostgresKvStorage implements StorageContract {
  readonly kind = "storage" as const;
  readonly driver = "postgres";
  readonly #db: PostgresQueryable;
  readonly #table: string;

  constructor(db: PostgresQueryable, schema: string) {
    this.#db = db;
    this.#table = `${quoteIdentifier(schema)}.kv_records`;
  }

  async get<TValue>(key: StorageKey): Promise<StorageRecord<TValue> | undefined> {
    const result = await this.#db.query<KvRow>(
      `SELECT * FROM ${this.#table} WHERE namespace = $1 AND collection = $2 AND id = $3`,
      [key.namespace, key.collection, key.id],
    );
    const row = result.rows[0];
    return row ? toRecord<TValue>(row) : undefined;
  }

  async set<TValue>(record: StorageRecord<TValue>): Promise<void> {
    if (record.value === undefined) {
      throw new TypeError("Postgres storage cannot store an undefined value.");
    }
    await this.#db.query(
      `INSERT INTO ${this.#table} (namespace, collection, id, value, metadata, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
       ON CONFLICT (namespace, collection, id) DO UPDATE
       SET value = EXCLUDED.value, metadata = EXCLUDED.metadata, updated_at = EXCLUDED.updated_at`,
      [
        record.key.namespace,
        record.key.collection,
        record.key.id,
        toJsonParam(record.value),
        toJsonParam(record.metadata),
        record.updatedAt,
      ],
    );
  }

  async delete(key: StorageKey): Promise<boolean> {
    const result = await this.#db.query(
      `DELETE FROM ${this.#table} WHERE namespace = $1 AND collection = $2 AND id = $3 RETURNING id`,
      [key.namespace, key.collection, key.id],
    );
    return result.rows.length > 0;
  }

  async list(filter: StorageFilter = {}): Promise<readonly StorageRecord[]> {
    const { clause, values } = filterClause(filter);
    const result = await this.#db.query<KvRow>(
      `SELECT * FROM ${this.#table} ${clause} ORDER BY namespace, collection, id`,
      values,
    );
    return result.rows.map((row) => toRecord(row));
  }

  async clear(filter: StorageFilter = {}): Promise<void> {
    const { clause, values } = filterClause(filter);
    await this.#db.query(`DELETE FROM ${this.#table} ${clause}`, values);
  }
}

function filterClause(filter: StorageFilter): { clause: string; values: unknown[] } {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (filter.namespace !== undefined) {
    values.push(filter.namespace);
    conditions.push(`namespace = $${values.length}`);
  }
  if (filter.collection !== undefined) {
    values.push(filter.collection);
    conditions.push(`collection = $${values.length}`);
  }
  if (filter.prefix !== undefined) {
    values.push(filter.prefix);
    conditions.push(`starts_with(id, $${values.length})`);
  }
  return {
    clause: conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`,
    values,
  };
}

function toRecord<TValue>(row: KvRow): StorageRecord<TValue> {
  return {
    key: { namespace: row.namespace, collection: row.collection, id: row.id },
    value: row.value as TValue,
    updatedAt: row.updated_at,
    ...(row.metadata === null ? {} : { metadata: row.metadata }),
  };
}
