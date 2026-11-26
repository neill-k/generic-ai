import { randomBytes } from "node:crypto";
import pg from "pg";
import { quoteIdentifier, type PostgresPool } from "../src/index.js";

/**
 * Postgres tests run when GENERIC_AI_TEST_POSTGRES_URL points at a database
 * the tests may create schemas in. Each test gets its own schema.
 */
export const postgresUrl = process.env["GENERIC_AI_TEST_POSTGRES_URL"];

export function createTestPool(): PostgresPool {
  if (!postgresUrl) {
    throw new Error("GENERIC_AI_TEST_POSTGRES_URL is not set.");
  }
  return new pg.Pool({ connectionString: postgresUrl, max: 10 }) as unknown as PostgresPool;
}

export function uniqueSchema(prefix = "gai_test"): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

export async function dropSchema(pool: PostgresPool, schema: string): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
}
