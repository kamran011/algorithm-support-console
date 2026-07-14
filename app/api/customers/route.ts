import { NextResponse } from "next/server";
import { asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { customers } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

/** GET /api/customers — seeded customers for the new-request form. */
export async function GET() {
  const rows = await db.select().from(customers).orderBy(asc(customers.id));
  return NextResponse.json({ customers: rows });
}
