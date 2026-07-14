import {
  pgTable,
  pgEnum,
  serial,
  integer,
  text,
  timestamp,
  jsonb,
  check,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const orderStatusEnum = pgEnum("order_status", [
  "pending",
  "paid",
  "shipped",
  "delivered",
  "cancelled",
  "refunded",
]);

export const requestStatusEnum = pgEnum("request_status", [
  "open",
  "processing",
  "resolved",
  "escalated",
]);

export const runStatusEnum = pgEnum("run_status", [
  "running",
  "completed",
  "failed",
]);

export const actionTypeEnum = pgEnum("action_type", [
  "refund",
  "cancel_order",
  "send_replacement",
]);

export const actionStatusEnum = pgEnum("action_status", [
  "pending_review",
  "approved",
  "rejected",
  "auto_executed",
  "executed",
  "failed",
]);

export const refundStatusEnum = pgEnum("refund_status", ["succeeded"]);

export const customers = pgTable("customers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
});

export const orders = pgTable(
  "orders",
  {
    id: serial("id").primaryKey(),
    customerId: integer("customer_id")
      .notNull()
      .references(() => customers.id),
    status: orderStatusEnum("status").notNull(),
    totalAmountCents: integer("total_amount_cents").notNull(),
    amountRefundedCents: integer("amount_refunded_cents").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Database-level last line of defense against over-refunds. Even if every
    // application-level guardrail failed, Postgres rejects the write.
    check(
      "orders_refund_within_total",
      sql`${t.amountRefundedCents} >= 0 AND ${t.amountRefundedCents} <= ${t.totalAmountCents}`
    ),
  ]
);

export const supportRequests = pgTable("support_requests", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id")
    .notNull()
    .references(() => customers.id),
  message: text("message").notNull(),
  status: requestStatusEnum("status").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const agentRuns = pgTable("agent_runs", {
  id: serial("id").primaryKey(),
  requestId: integer("request_id")
    .notNull()
    .references(() => supportRequests.id),
  status: runStatusEnum("status").notNull().default("running"),
  reasoningSummary: text("reasoning_summary"),
  rawMessages: jsonb("raw_messages"),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const toolCalls = pgTable("tool_calls", {
  id: serial("id").primaryKey(),
  runId: integer("run_id")
    .notNull()
    .references(() => agentRuns.id),
  seq: integer("seq").notNull(),
  toolName: text("tool_name").notNull(),
  input: jsonb("input"),
  output: jsonb("output"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const actions = pgTable("actions", {
  id: serial("id").primaryKey(),
  runId: integer("run_id")
    .notNull()
    .references(() => agentRuns.id),
  requestId: integer("request_id")
    .notNull()
    .references(() => supportRequests.id),
  orderId: integer("order_id").references(() => orders.id),
  type: actionTypeEnum("type").notNull(),
  params: jsonb("params").notNull(),
  status: actionStatusEnum("status").notNull().default("pending_review"),
  riskReason: text("risk_reason"),
  decidedBy: text("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  executedAt: timestamp("executed_at", { withTimezone: true }),
  failureReason: text("failure_reason"),
});

export const refunds = pgTable(
  "refunds",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id")
      .notNull()
      .references(() => orders.id),
    actionId: integer("action_id")
      .notNull()
      .references(() => actions.id),
    amountCents: integer("amount_cents").notNull(),
    status: refundStatusEnum("status").notNull().default("succeeded"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Idempotency: one action can produce at most one refund row, ever.
    // A retried or double-dispatched execution hits a unique violation
    // instead of paying out twice.
    uniqueIndex("refunds_action_id_unique").on(t.actionId),
  ]
);

export type Customer = typeof customers.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type SupportRequest = typeof supportRequests.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
export type ToolCall = typeof toolCalls.$inferSelect;
export type Action = typeof actions.$inferSelect;
export type Refund = typeof refunds.$inferSelect;
