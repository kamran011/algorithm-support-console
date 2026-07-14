/**
 * Concurrency test. Requires the app running (npm run dev) on
 * APP_URL (default http://localhost:3000).
 *
 * Phase 1 — double-approval race:
 *   two simultaneous POST /api/actions/[id]/approve for the SAME action.
 *   Expect exactly one 200 and one 409, exactly one refund row, and the
 *   order's amount_refunded_cents incremented exactly once.
 *
 * Phase 2 — over-refund race:
 *   two DIFFERENT pending actions on the same order, each refunding more
 *   than half the balance, approved simultaneously. Both win their own
 *   CAS, but the executor's FOR UPDATE lock serializes them: the second
 *   re-validates against the updated balance and fails. Expect exactly one
 *   refund row and no over-refund.
 *
 * Rerunnable: each run creates its own fresh rows (tagged by a test email)
 * and deletes leftovers from previous runs first.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

const APP_URL = process.env.APP_URL ?? "http://localhost:3000";
const TEST_EMAIL = "concurrency-test@example.com";

let failures = 0;
function assert(cond: boolean, label: string, detail?: unknown) {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}`, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

async function main() {
  const { db } = await import("../lib/db");
  const { eq, inArray, sql } = await import("drizzle-orm");
  const {
    actions,
    agentRuns,
    customers,
    orders,
    refunds,
    supportRequests,
  } = await import("../lib/db/schema");

  // ---- cleanup of any previous test run (idempotent reruns) ----------------
  const stale = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.email, TEST_EMAIL));
  if (stale.length > 0) {
    const staleIds = stale.map((c) => c.id);
    const staleOrders = await db
      .select({ id: orders.id })
      .from(orders)
      .where(inArray(orders.customerId, staleIds));
    const orderIds = staleOrders.map((o) => o.id);
    if (orderIds.length > 0) {
      await db.delete(refunds).where(inArray(refunds.orderId, orderIds));
    }
    const staleRequests = await db
      .select({ id: supportRequests.id })
      .from(supportRequests)
      .where(inArray(supportRequests.customerId, staleIds));
    const reqIds = staleRequests.map((r) => r.id);
    if (reqIds.length > 0) {
      await db.delete(actions).where(inArray(actions.requestId, reqIds));
      await db.delete(agentRuns).where(inArray(agentRuns.requestId, reqIds));
      await db
        .delete(supportRequests)
        .where(inArray(supportRequests.id, reqIds));
    }
    if (orderIds.length > 0) {
      await db.delete(orders).where(inArray(orders.id, orderIds));
    }
    await db.delete(customers).where(inArray(customers.id, staleIds));
    console.log(`Cleaned up ${stale.length} previous test customer(s).`);
  }

  // ---- fresh fixtures --------------------------------------------------------
  const [customer] = await db
    .insert(customers)
    .values({ name: "Concurrency Test", email: TEST_EMAIL })
    .returning();

  async function makeEscalatedRefund(orderTotal: number, amount: number) {
    const [order] = await db
      .insert(orders)
      .values({
        customerId: customer.id,
        status: "delivered",
        totalAmountCents: orderTotal,
      })
      .returning();
    const [request] = await db
      .insert(supportRequests)
      .values({
        customerId: customer.id,
        message: `[test fixture] refund ${amount} on order ${order.id}`,
        status: "escalated",
      })
      .returning();
    const [run] = await db
      .insert(agentRuns)
      .values({ requestId: request.id, status: "completed" })
      .returning();
    const [action] = await db
      .insert(actions)
      .values({
        runId: run.id,
        requestId: request.id,
        orderId: order.id,
        type: "refund",
        params: { amount_cents: amount },
        status: "pending_review",
        riskReason: "[test fixture] concurrency test escalation",
      })
      .returning();
    return { order, action };
  }

  const approve = (actionId: number, reviewer: string) =>
    fetch(`${APP_URL}/api/actions/${actionId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewer }),
    });

  // ============ Phase 1: double-approval race on ONE action ==================
  console.log("\nPhase 1: two simultaneous approvals of the same action");
  {
    const { order, action } = await makeEscalatedRefund(5000, 500);

    const [resA, resB] = await Promise.all([
      approve(action.id, "browser-alice"),
      approve(action.id, "browser-bob"),
    ]);
    const statuses = [resA.status, resB.status].sort();
    assert(
      statuses[0] === 200 && statuses[1] === 409,
      `exactly one 200 and one 409 (got ${statuses.join(", ")})`
    );

    const refundRows = await db
      .select()
      .from(refunds)
      .where(eq(refunds.actionId, action.id));
    assert(
      refundRows.length === 1,
      `exactly one refund row for the action (got ${refundRows.length})`
    );
    assert(
      refundRows[0]?.amountCents === 500,
      "refund row has the proposed amount"
    );

    const [freshOrder] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, order.id));
    assert(
      freshOrder.amountRefundedCents === 500,
      `amount_refunded_cents incremented exactly once (got ${freshOrder.amountRefundedCents})`
    );

    const [freshAction] = await db
      .select()
      .from(actions)
      .where(eq(actions.id, action.id));
    assert(freshAction.status === "executed", "action ended as 'executed'");
    assert(
      freshAction.decidedBy === "browser-alice" ||
        freshAction.decidedBy === "browser-bob",
      `decided_by is exactly one reviewer (got '${freshAction.decidedBy}')`
    );
  }

  // ============ Phase 2: over-refund race across TWO actions =================
  console.log(
    "\nPhase 2: two different refunds on one order, together exceeding its total"
  );
  {
    const { order, action: action1 } = await makeEscalatedRefund(5000, 3000);
    // Second pending action on the SAME order, also individually valid.
    const [request2] = await db
      .insert(supportRequests)
      .values({
        customerId: customer.id,
        message: `[test fixture] second refund on order ${order.id}`,
        status: "escalated",
      })
      .returning();
    const [run2] = await db
      .insert(agentRuns)
      .values({ requestId: request2.id, status: "completed" })
      .returning();
    const [action2] = await db
      .insert(actions)
      .values({
        runId: run2.id,
        requestId: request2.id,
        orderId: order.id,
        type: "refund",
        params: { amount_cents: 3000 },
        status: "pending_review",
        riskReason: "[test fixture] concurrency test escalation",
      })
      .returning();

    const [res1, res2] = await Promise.all([
      approve(action1.id, "browser-alice"),
      approve(action2.id, "browser-bob"),
    ]);
    // Both CAS updates succeed (different rows). One execution succeeds (200);
    // the other loses the FOR UPDATE race, re-validates against the updated
    // balance, and fails the guardrail (422).
    const statuses = [res1.status, res2.status].sort();
    assert(
      statuses[0] === 200 && statuses[1] === 422,
      `one 200 and one 422 guardrail failure (got ${statuses.join(", ")})`
    );

    const refundRows = await db
      .select()
      .from(refunds)
      .where(eq(refunds.orderId, order.id));
    assert(
      refundRows.length === 1,
      `exactly one refund row on the order (got ${refundRows.length})`
    );

    const [freshOrder] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, order.id));
    assert(
      freshOrder.amountRefundedCents === 3000,
      `no over-refund: amount_refunded_cents is 3000 (got ${freshOrder.amountRefundedCents})`
    );
    assert(
      freshOrder.amountRefundedCents <= freshOrder.totalAmountCents,
      "CHECK constraint invariant holds"
    );

    const finals = await db
      .select({ id: actions.id, status: actions.status, failureReason: actions.failureReason })
      .from(actions)
      .where(inArray(actions.id, [action1.id, action2.id]));
    const executed = finals.filter((a) => a.status === "executed");
    const failed = finals.filter((a) => a.status === "failed");
    assert(
      executed.length === 1 && failed.length === 1,
      "one action executed, one action failed",
      finals
    );
    assert(
      (failed[0]?.failureReason ?? "").includes("remaining refundable balance"),
      "loser failed with the over-refund guardrail reason",
      failed[0]?.failureReason
    );
  }

  // Sanity: the whole database still satisfies the refund invariant.
  const bad = await db.execute<{ id: number }>(
    sql`SELECT id FROM orders WHERE amount_refunded_cents > total_amount_cents`
  );
  assert(bad.length === 0, "no order anywhere is over-refunded");

  console.log(
    failures === 0
      ? "\nAll concurrency assertions passed."
      : `\n${failures} assertion(s) FAILED.`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Concurrency test crashed:", err);
  process.exit(1);
});
