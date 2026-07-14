import Anthropic from "@anthropic-ai/sdk";
import { eq, desc } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import { actions, customers, orders, refunds } from "./db/schema";
import { decideProposal } from "./policy";
import { executeAction } from "./executor";

/**
 * Agent tool definitions and executors.
 *
 * THE AGENT BOUNDARY: three read-only tools plus propose_action. The read
 * tools never throw for bad input — a hallucinated order id gets a
 * structured { found: false } the model can reason about. propose_action is
 * the agent's ONLY write, and all it writes is a row in `actions`; it never
 * touches orders or refunds. Whether a proposal executes is decided by
 * lib/policy.ts and carried out by lib/executor.ts — application code the
 * model cannot influence.
 *
 * Every input is Zod-parsed before it touches the database (hallucinated
 * shapes, negative amounts, string ids all bounce back as structured errors).
 */

export type ToolContext = {
  requestId: number;
  requestCustomerId: number;
  runId: number;
};

// ---------- Zod schemas (the enforcement side of each tool boundary) --------

const lookupOrderSchema = z.object({
  order_id: z.coerce.number().int().positive(),
});

const getCustomerOrdersSchema = z.object({
  customer_id: z.coerce.number().int().positive(),
});

const getRefundHistorySchema = z.object({
  order_id: z.coerce.number().int().positive(),
});

const proposeActionSchema = z
  .object({
    type: z.enum(["refund", "cancel_order", "send_replacement"]),
    order_id: z.coerce.number().int().positive(),
    params: z
      .object({
        amount_cents: z.coerce.number().int().positive().optional(),
      })
      .default({}),
    reasoning: z.string().min(1),
  })
  .refine((v) => v.type !== "refund" || v.params.amount_cents !== undefined, {
    message: "refund proposals require params.amount_cents",
  });

// ---------- Anthropic tool declarations (what the model sees) ---------------

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: "lookup_order",
    description:
      "Look up a single order by its numeric id. Returns order status, totals, refund progress and owner, or found=false if no such order exists.",
    input_schema: {
      type: "object",
      properties: {
        order_id: { type: "integer", description: "Numeric order id" },
      },
      required: ["order_id"],
    },
  },
  {
    name: "get_customer_orders",
    description:
      "List every order belonging to a customer id, newest first. Use this when the customer did not mention an order number.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "integer", description: "Numeric customer id" },
      },
      required: ["customer_id"],
    },
  },
  {
    name: "get_refund_history",
    description:
      "List all refunds already issued for an order, with the total refunded so far.",
    input_schema: {
      type: "object",
      properties: {
        order_id: { type: "integer", description: "Numeric order id" },
      },
      required: ["order_id"],
    },
  },
  {
    name: "propose_action",
    description:
      "Propose an action (refund, cancel_order, or send_replacement) for an order. This does NOT execute anything: the proposal is recorded and application policy decides whether it runs automatically or goes to a human reviewer. Amounts are integer cents. Propose at most one action per request.",
    input_schema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["refund", "cancel_order", "send_replacement"],
        },
        order_id: { type: "integer" },
        params: {
          type: "object",
          properties: {
            amount_cents: {
              type: "integer",
              description: "Refund amount in cents (required for refunds)",
            },
          },
        },
        reasoning: {
          type: "string",
          description: "One or two sentences on why this action is warranted",
        },
      },
      required: ["type", "order_id", "reasoning"],
    },
  },
];

// ---------- Tool executors ---------------------------------------------------

type Json = Record<string, unknown>;

async function lookupOrder(input: unknown): Promise<Json> {
  const parsed = lookupOrderSchema.safeParse(input);
  if (!parsed.success) {
    return { error: "invalid_input", detail: parsed.error.issues[0]?.message };
  }
  const [row] = await db
    .select({
      id: orders.id,
      customerId: orders.customerId,
      status: orders.status,
      totalAmountCents: orders.totalAmountCents,
      amountRefundedCents: orders.amountRefundedCents,
      createdAt: orders.createdAt,
      customerName: customers.name,
    })
    .from(orders)
    .innerJoin(customers, eq(orders.customerId, customers.id))
    .where(eq(orders.id, parsed.data.order_id));

  if (!row) {
    // Structured not-found, never a throw: a hallucinated id becomes
    // something the model can reason about and relay honestly.
    return {
      found: false,
      order_id: parsed.data.order_id,
      message: `No order with id ${parsed.data.order_id} exists`,
    };
  }
  return {
    found: true,
    order: {
      id: row.id,
      customer_id: row.customerId,
      customer_name: row.customerName,
      status: row.status,
      total_amount_cents: row.totalAmountCents,
      amount_refunded_cents: row.amountRefundedCents,
      created_at: row.createdAt,
    },
  };
}

async function getCustomerOrders(input: unknown): Promise<Json> {
  const parsed = getCustomerOrdersSchema.safeParse(input);
  if (!parsed.success) {
    return { error: "invalid_input", detail: parsed.error.issues[0]?.message };
  }
  const rows = await db
    .select()
    .from(orders)
    .where(eq(orders.customerId, parsed.data.customer_id))
    .orderBy(desc(orders.createdAt));
  return {
    customer_id: parsed.data.customer_id,
    orders: rows.map((o) => ({
      id: o.id,
      status: o.status,
      total_amount_cents: o.totalAmountCents,
      amount_refunded_cents: o.amountRefundedCents,
      created_at: o.createdAt,
    })),
  };
}

async function getRefundHistory(input: unknown): Promise<Json> {
  const parsed = getRefundHistorySchema.safeParse(input);
  if (!parsed.success) {
    return { error: "invalid_input", detail: parsed.error.issues[0]?.message };
  }
  const [order] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.id, parsed.data.order_id));
  if (!order) {
    return {
      found: false,
      order_id: parsed.data.order_id,
      message: `No order with id ${parsed.data.order_id} exists`,
    };
  }
  const rows = await db
    .select()
    .from(refunds)
    .where(eq(refunds.orderId, parsed.data.order_id))
    .orderBy(desc(refunds.createdAt));
  return {
    found: true,
    order_id: parsed.data.order_id,
    refunds: rows.map((r) => ({
      id: r.id,
      amount_cents: r.amountCents,
      status: r.status,
      created_at: r.createdAt,
    })),
    total_refunded_cents: rows.reduce((sum, r) => sum + r.amountCents, 0),
  };
}

/**
 * The agent's only write. Inserts an `actions` row; policy (application
 * code) decides its fate:
 *   - escalate    -> status 'pending_review' + risk_reason, human decides
 *   - auto_execute -> status 'approved' (decided_by 'auto-policy'), then the
 *     same executeAction path used by human approvals runs it, ending in
 *     'auto_executed' (or 'failed' if in-transaction guardrails refuse).
 */
async function proposeAction(input: unknown, ctx: ToolContext): Promise<Json> {
  const parsed = proposeActionSchema.safeParse(input);
  if (!parsed.success) {
    return { error: "invalid_input", detail: parsed.error.issues[0]?.message };
  }
  const { type, order_id, params, reasoning } = parsed.data;

  const decision = await decideProposal(db, {
    type,
    orderId: order_id,
    amountCents: params.amount_cents,
    requestCustomerId: ctx.requestCustomerId,
  });

  if (decision.decision === "escalate") {
    const [action] = await db
      .insert(actions)
      .values({
        runId: ctx.runId,
        requestId: ctx.requestId,
        orderId: order_id,
        type,
        params: { ...params, reasoning },
        status: "pending_review",
        riskReason: decision.riskReason,
      })
      .returning();
    return {
      action_id: action.id,
      decision: "escalated_to_human_review",
      risk_reason: decision.riskReason,
    };
  }

  // Auto-execute path: pre-approved by policy, executed through the one and
  // only mutation path (which re-locks and re-validates).
  const [action] = await db
    .insert(actions)
    .values({
      runId: ctx.runId,
      requestId: ctx.requestId,
      orderId: order_id,
      type,
      params: { ...params, reasoning },
      status: "approved",
      decidedBy: "auto-policy",
      decidedAt: new Date(),
    })
    .returning();

  const result = await executeAction(action.id, "auto-policy", "auto_executed");
  if (!result.ok) {
    return {
      action_id: action.id,
      decision: "execution_failed",
      reason: result.reason,
    };
  }
  return {
    action_id: action.id,
    decision: "auto_executed",
    amount_cents: params.amount_cents,
  };
}

export async function runTool(
  name: string,
  input: unknown,
  ctx: ToolContext
): Promise<Json> {
  switch (name) {
    case "lookup_order":
      return lookupOrder(input);
    case "get_customer_orders":
      return getCustomerOrders(input);
    case "get_refund_history":
      return getRefundHistory(input);
    case "propose_action":
      return proposeAction(input, ctx);
    default:
      return { error: "unknown_tool", detail: `No tool named '${name}'` };
  }
}
