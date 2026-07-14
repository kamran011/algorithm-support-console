import { NextRequest, NextResponse } from "next/server";
import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  actions,
  agentRuns,
  customers,
  orders,
  refunds,
  supportRequests,
  toolCalls,
} from "@/lib/db/schema";

// Reviewers poll this while racing approvals; never serve stale state.
export const dynamic = "force-dynamic";

/**
 * GET /api/requests/[id] — full detail: request, customer, latest agent run
 * (reasoning + tool calls in order), latest action, and the affected order
 * with its refund history.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const requestId = Number(id);
  if (!Number.isInteger(requestId)) {
    return NextResponse.json({ error: "Invalid request id" }, { status: 400 });
  }

  const [request] = await db
    .select({
      id: supportRequests.id,
      customerId: supportRequests.customerId,
      customerName: customers.name,
      customerEmail: customers.email,
      message: supportRequests.message,
      status: supportRequests.status,
      createdAt: supportRequests.createdAt,
    })
    .from(supportRequests)
    .innerJoin(customers, eq(supportRequests.customerId, customers.id))
    .where(eq(supportRequests.id, requestId));

  if (!request) {
    return NextResponse.json({ error: "Request not found" }, { status: 404 });
  }

  const [run] = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.requestId, requestId))
    .orderBy(desc(agentRuns.id))
    .limit(1);

  const calls = run
    ? await db
        .select()
        .from(toolCalls)
        .where(eq(toolCalls.runId, run.id))
        .orderBy(asc(toolCalls.seq))
    : [];

  const [action] = await db
    .select()
    .from(actions)
    .where(eq(actions.requestId, requestId))
    .orderBy(desc(actions.id))
    .limit(1);

  let order = null;
  let orderRefunds: (typeof refunds.$inferSelect)[] = [];
  if (action?.orderId) {
    const [o] = await db
      .select({
        id: orders.id,
        customerId: orders.customerId,
        customerName: customers.name,
        status: orders.status,
        totalAmountCents: orders.totalAmountCents,
        amountRefundedCents: orders.amountRefundedCents,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .innerJoin(customers, eq(orders.customerId, customers.id))
      .where(eq(orders.id, action.orderId));
    order = o ?? null;
    orderRefunds = await db
      .select()
      .from(refunds)
      .where(eq(refunds.orderId, action.orderId))
      .orderBy(desc(refunds.createdAt));
  }

  return NextResponse.json({
    request,
    run: run
      ? {
          id: run.id,
          status: run.status,
          reasoningSummary: run.reasoningSummary,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
        }
      : null,
    toolCalls: calls,
    action: action ?? null,
    order,
    refunds: orderRefunds,
  });
}
