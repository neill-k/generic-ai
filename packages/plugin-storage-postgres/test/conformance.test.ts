import { durableQueueConformanceCases, runStoreConformanceCases } from "@generic-ai/sdk/testing";
import { describe, it } from "vitest";
import { migratePostgres, PostgresQueue, PostgresRunStore } from "../src/index.js";
import { createTestPool, dropSchema, postgresUrl, uniqueSchema } from "./helpers.js";

describe.skipIf(!postgresUrl)("postgres run store conformance", () => {
  for (const testCase of runStoreConformanceCases(async (clock) => {
    const pool = createTestPool();
    const schema = uniqueSchema();
    await migratePostgres(pool, schema);
    return {
      store: new PostgresRunStore(pool, schema, { now: clock.now }),
      reopen: async () => new PostgresRunStore(pool, schema, { now: clock.now }),
      dispose: async () => {
        await dropSchema(pool, schema);
        await pool.end();
      },
    };
  })) {
    it(testCase.name, testCase.run);
  }
});

describe.skipIf(!postgresUrl)("postgres durable queue conformance", () => {
  for (const testCase of durableQueueConformanceCases(async (clock) => {
    const pool = createTestPool();
    const schema = uniqueSchema();
    await migratePostgres(pool, schema);
    return {
      queue: new PostgresQueue(pool, schema, { now: clock.now }),
      reopen: async () => new PostgresQueue(pool, schema, { now: clock.now }),
      dispose: async () => {
        await dropSchema(pool, schema);
        await pool.end();
      },
    };
  })) {
    it(testCase.name, testCase.run);
  }
});
