import { sql } from "drizzle-orm";
import type { Db, Tx } from "./db";

/**
 * Business-rule guardrails. These live in APPLICATION CODE, never in the
 * agent prompt: the prompt is advice, this function is enforcement.
 *
 * validateAction is called in two places:
 *  1. At proposal time (lib/policy.ts) to decide auto-execute vs escalate.
 *  2. INSIDE the execution transaction (lib/executor.ts) after the order row
 *     has been locked with SELECT ... FOR UPDATE. Re-running it there closes
 *     the time-of-check/time-of-use gap: the state it validates cannot change
 *     before the mutation commits.
 *
 * It returns typed results and never throws for business-rule violations.
 */

export type ValidateActionInput = {
  type: "refund" | "cancel_order" | "send_replacement";
  orderId: number;
  /** Required for refunds. */
  amountCents?: number;
  /** The customer who filed the support request (ownership check). */
  requestCustomerId: number;
};

export type GuardrailResult = { ok: true } | { ok: false; reason: string };

type OrderRow = {
  id: number;
  customer_id: number;
  status: string;
  total_amount_cents: number;
  amount_refunded_cents: number;
};

const CANCEL_BLOCKED_STATUSES = new Set([
  "shipped",
  "delivered",
  "refunded",
  "cancelled",
]);

const REFUND_BLOCKED_STATUSES = new Set(["refunded", "cancelled"]);

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export async function validateAction(
  tx: Tx | Db,
  input: ValidateActionInput
): Promise<GuardrailResult> {
  // Read through the caller's transaction handle. When the executor calls
  // this after FOR UPDATE, this read reflects the locked, current row state.
  const result = await tx.execute<OrderRow>(sql`
    SELECT id, customer_id, status, total_amount_cents, amount_refunded_cents
    FROM orders
    WHERE id = ${input.orderId}
  `);
  const order = result[0];

  if (!order) {
    return {
      ok: false,
      reason: `Order ${input.orderId} does not exist`,
    };
  }

  // Ownership: the order must belong to the customer who filed the request.
  // Blocks customer A (or a hallucinating agent) from acting on customer B's order.
  if (order.customer_id !== input.requestCustomerId) {
    return {
      ok: false,
      reason: `Order ${input.orderId} does not belong to the requesting customer`,
    };
  }

  if (input.type === "refund") {
    const amount = input.amountCents;
    if (amount === undefined || !Number.isInteger(amount) || amount <= 0) {
      return {
        ok: false,
        reason: `Refund amount must be a positive integer number of cents (got ${amount})`,
      };
    }
    if (REFUND_BLOCKED_STATUSES.has(order.status)) {
      return {
        ok: false,
        reason: `Cannot refund order ${order.id}: status is '${order.status}'`,
      };
    }
    const remaining = order.total_amount_cents - order.amount_refunded_cents;
    if (amount > remaining) {
      return {
        ok: false,
        reason: `Refund of ${formatCents(amount)} exceeds remaining refundable balance ${formatCents(remaining)} (total ${formatCents(order.total_amount_cents)}, already refunded ${formatCents(order.amount_refunded_cents)})`,
      };
    }
    return { ok: true };
  }

  if (input.type === "cancel_order") {
    if (CANCEL_BLOCKED_STATUSES.has(order.status)) {
      return {
        ok: false,
        reason: `Cannot cancel order ${order.id}: status is '${order.status}'`,
      };
    }
    return { ok: true };
  }

  // send_replacement: existence + ownership checks above are sufficient;
  // it never mutates the order row.
  return { ok: true };
}
