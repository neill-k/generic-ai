import pg from "pg";

/** Result shape shared by `pg` clients and pools. */
export interface PostgresQueryResult<TRow> {
  readonly rows: TRow[];
  readonly rowCount: number | null;
}

/** Anything that can run a parameterized query: a `pg.Pool`, `pg.Client`, or pooled client. */
export interface PostgresQueryable {
  query<TRow = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresQueryResult<TRow>>;
}

export interface PostgresPoolClient extends PostgresQueryable {
  release(error?: Error | boolean): void;
}

/** The subset of `pg.Pool` the storage needs. Pass your own pool to share it with the app. */
export interface PostgresPool extends PostgresQueryable {
  connect(): Promise<PostgresPoolClient>;
  end(): Promise<void>;
}

export interface PostgresConnectionOptions {
  /** An existing pool. The storage does not end a pool it did not create. */
  readonly pool?: PostgresPool;
  /** Used to create a pool when `pool` is not given. */
  readonly connectionString?: string;
  /** Pool size when the storage creates the pool. Defaults to 10. */
  readonly maxConnections?: number;
  /** Database schema holding the tables. Defaults to `generic_ai`. */
  readonly schema?: string;
  /**
   * Called when an idle pooled connection fails, for example when the database
   * restarts. The pool drops that connection and opens a new one on the next
   * query. Defaults to a warning on stderr. Only used for a pool the storage
   * creates; without a listener, `pg` would crash the process instead.
   */
  readonly onPoolError?: (error: Error) => void;
}

export interface ResolvedPostgresConnection {
  readonly pool: PostgresPool;
  readonly ownsPool: boolean;
  readonly schema: string;
}

export const DEFAULT_POSTGRES_SCHEMA = "generic_ai";

export function resolvePostgresConnection(
  options: PostgresConnectionOptions,
): ResolvedPostgresConnection {
  const schema = normalizeSchemaName(options.schema ?? DEFAULT_POSTGRES_SCHEMA);
  if (options.pool) {
    return { pool: options.pool, ownsPool: false, schema };
  }
  const connectionString = options.connectionString ?? process.env["DATABASE_URL"];
  if (connectionString === undefined || connectionString.trim().length === 0) {
    throw new TypeError(
      "Postgres storage needs a `pool`, a `connectionString`, or the DATABASE_URL environment variable.",
    );
  }
  const pgPool = new pg.Pool({
    connectionString,
    max: options.maxConnections ?? 10,
  });
  const onPoolError =
    options.onPoolError ??
    ((error: Error) => {
      console.warn(
        `Postgres connection lost; it will reconnect on the next query: ${error.message}`,
      );
    });
  pgPool.on("error", (error) => onPoolError(error));
  const pool = pgPool as unknown as PostgresPool;
  return { pool, ownsPool: true, schema };
}

const SCHEMA_NAME_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

export function normalizeSchemaName(schema: string): string {
  if (!SCHEMA_NAME_PATTERN.test(schema)) {
    throw new TypeError(
      `Invalid Postgres schema name "${schema}". Use lowercase letters, digits and underscores.`,
    );
  }
  return schema;
}

/** Quotes a validated identifier. */
export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** Runs `operation` inside a transaction on a dedicated pooled connection. */
export async function withTransaction<T>(
  pool: PostgresPool,
  operation: (client: PostgresQueryable) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let released = false;
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      client.release(rollbackError instanceof Error ? rollbackError : true);
      released = true;
    }
    throw error;
  } finally {
    if (!released) {
      client.release();
    }
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505"
  );
}

export function toIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    return new Date(value).toISOString();
  }
  if (typeof value === "number") {
    return new Date(value).toISOString();
  }
  throw new TypeError(`Expected a timestamp, received ${typeof value}.`);
}

export function toEpochMs(value: string | number | Date): number {
  const epoch =
    value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(epoch)) {
    throw new TypeError(`Invalid timestamp: ${String(value)}`);
  }
  return epoch;
}

/** Serializes a value for a `$n::jsonb` parameter. */
export function toJsonParam(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}
