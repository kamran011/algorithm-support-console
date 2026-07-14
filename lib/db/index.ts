import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

// Supabase transaction pooler (port 6543) does not support prepared
// statements, and each serverless invocation opens its own connections, so
// keep the pool at 1 to stay under the pooler's connection limits during
// concurrent traffic.
const client = postgres(process.env.DATABASE_URL, {
  prepare: false,
  max: 1,
});

export const db = drizzle(client, { schema });

export type Db = typeof db;
// The transaction handle passed to db.transaction callbacks; guardrails and
// the executor accept this so validation always runs on the same connection
// that holds the row locks.
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
