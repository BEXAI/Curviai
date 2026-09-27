import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface CreateDbOptions {
  /** Maximum pool connections. Serverless callers should keep this small. */
  max?: number;
  /** Set false when connecting through a transaction mode pooler like Supabase pgbouncer. */
  prepare?: boolean;
}

/**
 * Create a Drizzle database client over the postgres.js driver.
 * The caller owns the connection string; nothing is read from the environment here.
 */
export function createDb(connectionString: string, options: CreateDbOptions = {}): Db {
  if (!connectionString) {
    throw new Error("createDb requires a connection string");
  }
  const client = postgres(connectionString, {
    max: options.max ?? 5,
    prepare: options.prepare ?? true,
  });
  return drizzle(client, { schema });
}
