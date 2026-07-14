import { eq, sql } from "drizzle-orm";
import { db } from "./db";
import { actions, orders, refunds, supportRequests } from "./db/schema";
import type { Action } from "./db/schema";
import { validateAction } from "./guardrails";

/**
 * lib/executor.ts — THE ONLY MUTATION PATH.
 *
 * Nothing else in the codebase writes to orders or refunds. The agent can
 * only insert `actions` rows (via propose_action); this function is what
 * turns an approved action into a real state change, inside a single
 * transaction with the order row locked.
 *
 * Concurrency guarantees, in layers:
 *  1. SELECT ... FOR UPDATE on the order row — a concurrent execution against
 *     the same order blocks here until this transaction commits, then sees
 *     the updated amount_refunded_cents and fails guardrail validation.
 *  2. validateAction re-runs INSIDE the transaction against the locked row
 *     (TOCTOU protection — proposal-time checks are advisory only).
 *  3. CHECK (amount_refunded_cents <= total_amount_cents) — database-level
 *     backstop even if 1 and 2 were somehow bypassed.
 *  4. UNIQUE index on refunds.action_id — one action can never pay out twice.
 */

export type ExecutionResult =
  | { ok: true; action: Action }
  | { ok: false; reason: string; action: Action | null };

export type ActionParams = { amount_cents?: number };

export async function executeAction(
  actionId: number,
  executedBy: string,
  // Human-approved actions end as 'executed'; policy-approved ones as
  // 'auto_executed' so the queue can distinguish them.
  finalStatus: "executed" | "auto_executed" = "executed"
): Promise<ExecutionResult> {
  try {
    return await db.transaction(async (tx) => {
      // Lock the action row first: serializes any double-dispatch of the
      // same action (the approve route's conditional UPDATE already prevents
      // this, but the executor defends itself independently).
      const actionRows = await tx.execute<{ id: number }>(
        sql`SELECT id FROM actions WHERE id = ${actionId} FOR UPDATE`
      );
      if (actionRows.length === 0) {
        return { ok: false as const, reason: `Action ${actionId} does not exist`, action: null };
      }
      const [action] = await tx
        .select()
        .from(actions)
        .where(eq(actions.id, actionId));

      if (action.status !== "approved") {
        return {
          ok: false as const,
          reason: `Action ${actionId} is not approved (status: '${action.status}')`,
          action,
        };
      }
      if (action.orderId === null) {
        return await markFailed(tx, action, "Action has no order_id");
      }

      const [request] = await tx
        .select()
        .from(supportRequests)
        .where(eq(supportRequests.id, action.requestId));

      // ---- Layer 1: row lock ------------------------------------------------
      // Any concurrent executeAction on the same order queues up on this lock
      // and, once it acquires it, sees the state THIS transaction committed.
      await tx.execute(
        sql`SELECT * FROM orders WHERE id = ${action.orderId} FOR UPDATE`
      );

      // ---- Layer 2: re-validate against locked state (TOCTOU) --------------
      const params = (action.params ?? {}) as ActionParams;
      const verdict = await validateAction(tx, {
        type: action.type,
        orderId: action.orderId,
        amountCents: params.amount_cents,
        requestCustomerId: request.customerId,
      });
      if (!verdict.ok) {
        // Business-rule failure: record it on the action and commit that.
        // We do NOT throw — the transaction commits with status 'failed'.
        return await markFailed(tx, action, verdict.reason);
      }

      // ---- Mutation ---------------------------------------------------------
      if (action.type === "refund") {
        const amount = params.amount_cents!;
        // Layer 4: unique index on refunds.action_id makes this insert
        // idempotent-or-fail; a duplicate execution can never pay out twice.
        await tx.insert(refunds).values({
          orderId: action.orderId,
          actionId: action.id,
          amountCents: amount,
        });
        // Layer 3: the CHECK constraint on orders would reject this UPDATE
        // if it ever pushed amount_refunded_cents past total_amount_cents.
        await tx.execute(sql`
          UPDATE orders
          SET amount_refunded_cents = amount_refunded_cents + ${amount},
              status = CASE
                WHEN amount_refunded_cents + ${amount} >= total_amount_cents
                THEN 'refunded'::order_status
                ELSE status
              END
          WHERE id = ${action.orderId}
        `);
      } else if (action.type === "cancel_order") {
        await tx
          .update(orders)
          .set({ status: "cancelled" })
          .where(eq(orders.id, action.orderId));
      }
      // send_replacement: recorded and approved, but there is no shipment
      // table in this scope — no order mutation (see ARCHITECTURE.md).

      const [executed] = await tx
        .update(actions)
        .set({ status: finalStatus, executedAt: new Date() })
        .where(eq(actions.id, action.id))
        .returning();

      // The request is settled by this execution.
      await tx
        .update(supportRequests)
        .set({ status: "resolved" })
        .where(eq(supportRequests.id, action.requestId));

      return { ok: true as const, action: executed };
    });
  } catch (err) {
    // Unexpected failure (e.g. unique-violation or CHECK-violation from the
    // database backstops, connection loss). The transaction rolled back;
    // record the failure on the action in a fresh statement.
    const reason = err instanceof Error ? err.message : String(err);
    const [failed] = await db
      .update(actions)
      .set({ status: "failed", failureReason: reason })
      .where(eq(actions.id, actionId))
      .returning();
    return { ok: false, reason, action: failed ?? null };
  }
}

async function markFailed(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  action: Action,
  reason: string
): Promise<ExecutionResult> {
  const [failed] = await tx
    .update(actions)
    .set({ status: "failed", failureReason: reason })
    .where(eq(actions.id, action.id))
    .returning();
  // A failed execution needs human eyes: keep/mark the request escalated.
  await tx
    .update(supportRequests)
    .set({ status: "escalated" })
    .where(eq(supportRequests.id, action.requestId));
  return { ok: false, reason, action: failed };
}
