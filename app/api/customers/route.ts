import { NextResponse } from "next/server";
import { asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { customers } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

/** GET /api/customers — seeded customers for the new-request form, excluding test fixtures. */
export async function GET() {
  const rows = await db.select().from(customers).orderBy(asc(customers.id));
  const filtered = rows.filter(
    (c) => !c.name.includes("Concurrency") && !c.name.includes("Test")
  );
  return NextResponse.json({ customers: filtered });
}
