import { NextRequest, NextResponse } from "next/server";
import { desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  actions,
  agentRuns,
  customers,
  supportRequests,
} from "@/lib/db/schema";
import { runAgent } from "@/lib/agent";

// Vercel Hobby caps function duration at 60s; the agent loop's own 45s
// wall-clock budget keeps us safely inside it.
export const maxDuration = 60;
// Never serve a cached queue: reviewers race two browsers against this and
// must see honest current state.
export const dynamic = "force-dynamic";

const createSchema = z.object({
  customer_id: z.coerce.number().int().positive(),
  message: z.string().trim().min(1).max(2000),
});

/** POST /api/requests — create a support request and run the agent inline. */
export async function POST(req: NextRequest) {
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 }
    );
  }
  const { customer_id, message } = parsed.data;

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, customer_id));
  if (!customer) {
    return NextResponse.json(
      { error: `Customer ${customer_id} not found` },
      { status: 404 }
    );
  }

  const [request] = await db
    .insert(supportRequests)
    .values({ customerId: customer_id, message, status: "processing" })
    .returning();

  // Run the agent inline. runAgent handles its own failures (failed run ->
  // request escalated), so this only throws on truly unexpected errors.
  try {
    await runAgent(request.id);
  } catch (err) {
    await db
      .update(supportRequests)
      .set({ status: "escalated" })
      .where(eq(supportRequests.id, request.id));
    return NextResponse.json(
      {
        request_id: request.id,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }

  const [fresh] = await db
    .select()
    .from(supportRequests)
    .where(eq(supportRequests.id, request.id));
  return NextResponse.json({ request: fresh }, { status: 201 });
}

/** GET /api/requests — the queue, joined with latest run + latest action. */
export async function GET() {
  const requests = await db
    .select({
      id: supportRequests.id,
      customerId: supportRequests.customerId,
      customerName: customers.name,
      message: supportRequests.message,
      status: supportRequests.status,
      createdAt: supportRequests.createdAt,
    })
    .from(supportRequests)
    .innerJoin(customers, eq(supportRequests.customerId, customers.id))
    .where(ne(customers.name, "Concurrency Test"))
    .orderBy(desc(supportRequests.createdAt))
    .limit(100);

  const ids = requests.map((r) => r.id);
  const [allActions, allRuns] =
    ids.length === 0
      ? [[], []]
      : await Promise.all([
          db
            .select()
            .from(actions)
            .where(inArray(actions.requestId, ids))
            .orderBy(desc(actions.id)),
          db
            .select({
              id: agentRuns.id,
              requestId: agentRuns.requestId,
              status: agentRuns.status,
            })
            .from(agentRuns)
            .where(inArray(agentRuns.requestId, ids))
            .orderBy(desc(agentRuns.id)),
        ]);

  const rows = requests.map((r) => ({
    ...r,
    // .find on a desc-ordered list = latest per request
    latestAction: allActions.find((a) => a.requestId === r.id) ?? null,
    latestRun: allRuns.find((run) => run.requestId === r.id) ?? null,
  }));

  return NextResponse.json({ requests: rows });
}
