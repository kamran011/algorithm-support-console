/**
 * Deterministic seed. Resets all tables and creates the exact scenarios the
 * assessment tests against:
 *
 *   order 1001: paid, not shipped            -> cancellable
 *   order 1002: shipped                      -> cancel must be refused
 *   order 1003: delivered, $45.00            -> refundable, escalates (> $10)
 *   order 1004: delivered, $8.00             -> small refund, auto-executes
 *   order 1005: already fully refunded       -> refund must be refused
 *   order 1006: partially refunded $20/$50   -> over-refund of remainder refused
 *
 * Run with: npm run seed
 */
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  // Import after dotenv so DATABASE_URL is present when lib/db initializes.
  const { db } = await import("../lib/db");
  const { sql } = await import("drizzle-orm");
  const {
    customers,
    orders,
    supportRequests,
    agentRuns,
    toolCalls,
    actions,
    refunds,
  } = await import("../lib/db/schema");

  console.log("Resetting tables...");
  await db.execute(sql`
    TRUNCATE refunds, actions, tool_calls, agent_runs, support_requests, orders, customers
    RESTART IDENTITY CASCADE
  `);

  console.log("Seeding customers...");
  await db.insert(customers).values([
    { id: 1, name: "Alice Nguyen", email: "alice@example.com" },
    { id: 2, name: "Bob Martinez", email: "bob@example.com" },
    { id: 3, name: "Carol Okafor", email: "carol@example.com" },
    { id: 4, name: "David Kim", email: "david@example.com" },
    { id: 5, name: "Emma Rossi", email: "emma@example.com" },
  ]);

  console.log("Seeding orders 1001-1006...");
  const day = 24 * 60 * 60 * 1000;
  const daysAgo = (n: number) => new Date(Date.now() - n * day);
  await db.insert(orders).values([
    // 1001: paid, not shipped -> cancellable
    {
      id: 1001,
      customerId: 1,
      status: "paid",
      totalAmountCents: 3200,
      amountRefundedCents: 0,
      createdAt: daysAgo(1),
    },
    // 1002: shipped -> cancel must be refused
    {
      id: 1002,
      customerId: 2,
      status: "shipped",
      totalAmountCents: 7550,
      amountRefundedCents: 0,
      createdAt: daysAgo(3),
    },
    // 1003: delivered, $45.00 -> refundable but escalates (above $10 auto cap)
    {
      id: 1003,
      customerId: 3,
      status: "delivered",
      totalAmountCents: 4500,
      amountRefundedCents: 0,
      createdAt: daysAgo(6),
    },
    // 1004: delivered, $8.00 -> small refund auto-executes
    {
      id: 1004,
      customerId: 4,
      status: "delivered",
      totalAmountCents: 800,
      amountRefundedCents: 0,
      createdAt: daysAgo(5),
    },
    // 1005: already fully refunded -> further refunds refused
    {
      id: 1005,
      customerId: 5,
      status: "refunded",
      totalAmountCents: 2500,
      amountRefundedCents: 2500,
      createdAt: daysAgo(14),
    },
    // 1006: partially refunded $20 of $50 -> refund > $30 remainder refused
    {
      id: 1006,
      customerId: 1,
      status: "delivered",
      totalAmountCents: 5000,
      amountRefundedCents: 2000,
      createdAt: daysAgo(10),
    },
  ]);

  console.log("Seeding historical resolved requests (queue realism)...");
  // 1005's full refund and 1006's partial refund each get a believable
  // request -> run -> executed action -> refund chain so refund history and
  // the refunds.action_id unique index reflect reality.
  await db.insert(supportRequests).values([
    {
      id: 1,
      customerId: 5,
      message:
        "My order arrived completely broken. I want my money back for order 1005.",
      status: "resolved",
      createdAt: daysAgo(12),
    },
    {
      id: 2,
      customerId: 1,
      message:
        "Two of the five items in order 1006 were missing from the box. Please refund those.",
      status: "resolved",
      createdAt: daysAgo(8),
    },
    {
      id: 3,
      customerId: 2,
      message: "Just checking when order 1002 will arrive. Any tracking info?",
      status: "resolved",
      createdAt: daysAgo(2),
    },
  ]);

  await db.insert(agentRuns).values([
    {
      id: 1,
      requestId: 1,
      status: "completed",
      reasoningSummary:
        "Customer reports order 1005 arrived broken. Verified the order belongs to this customer and is delivered. Proposed a full refund of $25.00; escalated for human review because the amount exceeds the auto-execute cap.",
      rawMessages: [],
      startedAt: daysAgo(12),
      completedAt: daysAgo(12),
    },
    {
      id: 2,
      requestId: 2,
      status: "completed",
      reasoningSummary:
        "Customer reports 2 of 5 items missing from order 1006. Verified ownership and delivery. Proposed a partial refund of $20.00; escalated for human review because the amount exceeds the auto-execute cap.",
      rawMessages: [],
      startedAt: daysAgo(8),
      completedAt: daysAgo(8),
    },
    {
      id: 3,
      requestId: 3,
      status: "completed",
      reasoningSummary:
        "Shipping status question about order 1002. Confirmed the order is shipped. No action needed; answered with status information.",
      rawMessages: [],
      startedAt: daysAgo(2),
      completedAt: daysAgo(2),
    },
  ]);

  await db.insert(toolCalls).values([
    {
      runId: 1,
      seq: 1,
      toolName: "lookup_order",
      input: { order_id: 1005 },
      output: {
        found: true,
        order: { id: 1005, status: "delivered", total_amount_cents: 2500 },
      },
      createdAt: daysAgo(12),
    },
    {
      runId: 1,
      seq: 2,
      toolName: "propose_action",
      input: {
        type: "refund",
        order_id: 1005,
        params: { amount_cents: 2500 },
        reasoning: "Order arrived broken; full refund requested.",
      },
      output: { action_id: 1, decision: "pending_review" },
      createdAt: daysAgo(12),
    },
    {
      runId: 2,
      seq: 1,
      toolName: "lookup_order",
      input: { order_id: 1006 },
      output: {
        found: true,
        order: { id: 1006, status: "delivered", total_amount_cents: 5000 },
      },
      createdAt: daysAgo(8),
    },
    {
      runId: 2,
      seq: 2,
      toolName: "propose_action",
      input: {
        type: "refund",
        order_id: 1006,
        params: { amount_cents: 2000 },
        reasoning: "2 of 5 items missing; refund their share.",
      },
      output: { action_id: 2, decision: "pending_review" },
      createdAt: daysAgo(8),
    },
    {
      runId: 3,
      seq: 1,
      toolName: "lookup_order",
      input: { order_id: 1002 },
      output: {
        found: true,
        order: { id: 1002, status: "shipped", total_amount_cents: 7550 },
      },
      createdAt: daysAgo(2),
    },
  ]);

  await db.insert(actions).values([
    {
      id: 1,
      runId: 1,
      requestId: 1,
      orderId: 1005,
      type: "refund",
      params: { amount_cents: 2500 },
      status: "executed",
      riskReason: "Refund amount $25.00 exceeds $10.00 auto-execute cap",
      decidedBy: "seed-reviewer",
      decidedAt: daysAgo(12),
      executedAt: daysAgo(12),
    },
    {
      id: 2,
      runId: 2,
      requestId: 2,
      orderId: 1006,
      type: "refund",
      params: { amount_cents: 2000 },
      status: "executed",
      riskReason: "Refund amount $20.00 exceeds $10.00 auto-execute cap",
      decidedBy: "seed-reviewer",
      decidedAt: daysAgo(8),
      executedAt: daysAgo(8),
    },
  ]);

  await db.insert(refunds).values([
    {
      orderId: 1005,
      actionId: 1,
      amountCents: 2500,
      status: "succeeded",
      createdAt: daysAgo(12),
    },
    {
      orderId: 1006,
      actionId: 2,
      amountCents: 2000,
      status: "succeeded",
      createdAt: daysAgo(8),
    },
  ]);

  // Explicit ids were used above; bump each serial sequence past them so new
  // inserts don't collide.
  console.log("Resetting sequences...");
  await db.execute(sql`SELECT setval('customers_id_seq', 5)`);
  await db.execute(sql`SELECT setval('orders_id_seq', 1006)`);
  await db.execute(sql`SELECT setval('support_requests_id_seq', 3)`);
  await db.execute(sql`SELECT setval('agent_runs_id_seq', 3)`);
  await db.execute(
    sql`SELECT setval('tool_calls_id_seq', (SELECT max(id) FROM tool_calls))`
  );
  await db.execute(sql`SELECT setval('actions_id_seq', 2)`);
  await db.execute(
    sql`SELECT setval('refunds_id_seq', (SELECT max(id) FROM refunds))`
  );

  console.log("Seed complete: 5 customers, orders 1001-1006, 3 resolved requests.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
