import { sql } from "drizzle-orm";
import type { Db, Tx } from "./db";
import {
  validateAction,
  formatCents,
  type ValidateActionInput,
} from "./guardrails";

/**
 * Decision policy: auto-execute vs escalate to a human. Lives in APPLICATION
 * CODE — the agent proposes, this code decides. The core principle: an
 * incorrect refund is far worse than over-escalating, so every branch that
 * is not the one narrow safe case escalates.
 *
 * Auto-execute ONLY when ALL of:
 *   - type is refund
 *   - amount <= 1000 cents ($10.00)
 *   - order status is 'delivered'  (see note below)
 *   - every guardrail in validateAction passes
 *
 * Cancellations and replacements ALWAYS escalate.
 *
 * Note on "shipped with damage claim": the spec allows auto-refunding shipped
 * orders when there is a damage claim, but detecting "damage claim" would
 * mean trusting LLM interpretation of free text — exactly what policy code
 * must not do. Shipped-order refunds therefore always escalate; the amber
 * queue is the cost, a wrong payout would be the alternative.
 */

export const AUTO_REFUND_CAP_CENTS = 1000;

export type PolicyDecision =
  | { decision: "auto_execute" }
  | { decision: "escalate"; riskReason: string };

export async function decideProposal(
  tx: Tx | Db,
  input: ValidateActionInput
): Promise<PolicyDecision> {
  if (input.type === "cancel_order") {
    return {
      decision: "escalate",
      riskReason: "Cancellations always require human review",
    };
  }
  if (input.type === "send_replacement") {
    return {
      decision: "escalate",
      riskReason: "Replacements always require human review",
    };
  }

  // type === 'refund'
  const amount = input.amountCents ?? 0;

  // Guardrails first: a proposal that already violates a business rule is
  // shown to a human with the violation as its risk reason, never executed.
  const verdict = await validateAction(tx, input);
  if (!verdict.ok) {
    return { decision: "escalate", riskReason: `Guardrail: ${verdict.reason}` };
  }

  if (amount > AUTO_REFUND_CAP_CENTS) {
    return {
      decision: "escalate",
      riskReason: `Refund amount ${formatCents(amount)} exceeds ${formatCents(AUTO_REFUND_CAP_CENTS)} auto-execute cap`,
    };
  }

  const rows = await tx.execute<{ status: string }>(
    sql`SELECT status FROM orders WHERE id = ${input.orderId}`
  );
  const status = rows[0]?.status;
  if (status !== "delivered") {
    return {
      decision: "escalate",
      riskReason: `Order status '${status}' is not eligible for auto-refund (only delivered orders qualify)`,
    };
  }

  return { decision: "auto_execute" };
}
