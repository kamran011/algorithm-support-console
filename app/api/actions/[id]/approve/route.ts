import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { actions } from "@/lib/db/schema";
import { executeAction } from "@/lib/executor";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  reviewer: z.string().trim().min(1, "reviewer name is required"),
});

/**
 * POST /api/actions/[id]/approve
 *
 * DOUBLE-APPROVAL PROTECTION (this is the pattern reviewers will race with
 * two browsers):
 *
 *   UPDATE actions
 *   SET status = 'approved', decided_by = $reviewer, decided_at = now()
 *   WHERE id = $1 AND status = 'pending_review'
 *   RETURNING *
 *
 * This is an atomic compare-and-swap. Postgres evaluates the WHERE against
 * the row's current committed state under its own row lock, so when two
 * reviewers approve simultaneously exactly ONE update matches; the other
 * matches zero rows because the status is no longer 'pending_review'.
 * Zero rows returned = lost the race = respond 409 with the current row so
 * the UI can show who actually decided it. No advisory locks, no
 * read-then-write gap — the database itself is the referee.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const actionId = Number(id);
  if (!Number.isInteger(actionId)) {
    return NextResponse.json({ error: "Invalid action id" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 }
    );
  }
  const { reviewer } = parsed.data;

  // The conditional UPDATE (compare-and-swap). See comment above.
  const claimed = await db
    .update(actions)
    .set({
      status: "approved",
      decidedBy: reviewer,
      decidedAt: sql`now()`,
    })
    .where(and(eq(actions.id, actionId), eq(actions.status, "pending_review")))
    .returning();

  if (claimed.length === 0) {
    // Lost the race (or action never existed / already decided).
    const [current] = await db
      .select()
      .from(actions)
      .where(eq(actions.id, actionId));
    if (!current) {
      return NextResponse.json({ error: "Action not found" }, { status: 404 });
    }
    return NextResponse.json(
      {
        error: `Already decided by ${current.decidedBy ?? "someone else"}`,
        action: current,
      },
      { status: 409 }
    );
  }

  // We won the race: execute in this same request. executeAction re-locks
  // and re-validates; a guardrail failure here marks the action 'failed'
  // rather than throwing.
  const result = await executeAction(actionId, reviewer, "executed");

  if (!result.ok) {
    return NextResponse.json(
      { error: result.reason, action: result.action },
      { status: 422 }
    );
  }
  return NextResponse.json({ action: result.action });
}
