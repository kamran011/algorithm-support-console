import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

// Supabase transaction pooler (port 6543) does not support prepared
// statements. Keep the pool small: each serverless instance opens its own
// connections and the pooler has client limits. But NOT 1 — with a single
// connection, a reserved transaction plus queued concurrent queries can
// starve the pool and wedge every request; 4 gives concurrent
// approve/execute transactions their own connections while staying well
// under pooler limits.
const client = postgres(process.env.DATABASE_URL, {
  prepare: false,
  max: 4,
});

export const db = drizzle(client, { schema });

export type Db = typeof db;
// The transaction handle passed to db.transaction callbacks; guardrails and
// the executor accept this so validation always runs on the same connection
// that holds the row locks.
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
