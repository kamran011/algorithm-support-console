import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { actions, supportRequests } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  reviewer: z.string().trim().min(1, "reviewer name is required"),
});

/**
 * POST /api/actions/[id]/reject
 *
 * Same atomic compare-and-swap as the approve route:
 * UPDATE ... WHERE status = 'pending_review' RETURNING. If a concurrent
 * approve (or reject) already decided this action, the WHERE matches zero
 * rows and we respond 409 with the current row. This means an
 * approve/reject race also has exactly one winner.
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

  const claimed = await db
    .update(actions)
    .set({
      status: "rejected",
      decidedBy: reviewer,
      decidedAt: sql`now()`,
    })
    .where(and(eq(actions.id, actionId), eq(actions.status, "pending_review")))
    .returning();

  if (claimed.length === 0) {
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

  // A rejected proposal settles the request (the human chose "do nothing").
  await db
    .update(supportRequests)
    .set({ status: "resolved" })
    .where(eq(supportRequests.id, claimed[0].requestId));

  return NextResponse.json({ action: claimed[0] });
}
