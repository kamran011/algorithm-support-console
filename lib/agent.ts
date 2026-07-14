import Anthropic from "@anthropic-ai/sdk";
import { and, eq } from "drizzle-orm";
import { db } from "./db";
import {
  actions,
  agentRuns,
  customers,
  supportRequests,
  toolCalls,
} from "./db/schema";
import { runTool, toolDefinitions, type ToolContext } from "./agent-tools";

/**
 * The agent loop: a real tool-use loop over the Anthropic Messages API.
 * The model decides which tools to call and when; nothing here hardcodes a
 * sequence. Hard limits are enforced in code: at most MAX_ITERATIONS model
 * turns and a WALL_CLOCK_BUDGET_MS deadline — on either limit the run is
 * marked failed and the request escalates to a human (bias to escalation;
 * a hung request during review would be worse than an amber badge).
 *
 * Note what is absent from the system prompt: refund caps, status rules,
 * ownership checks. Those live in lib/guardrails.ts and lib/policy.ts.
 * The prompt shapes behavior; the code enforces it.
 */

const MODEL = "claude-sonnet-4-6";
const MAX_ITERATIONS = 10;
const WALL_CLOCK_BUDGET_MS = 45_000;
const MAX_TOKENS = 1500;

const SYSTEM_PROMPT = `You are a support agent for an e-commerce store. You handle one customer support request at a time.

How to work:
- Use the read tools (lookup_order, get_customer_orders, get_refund_history) to verify the facts before doing anything. Never assume an order exists or what state it is in.
- If the customer's issue warrants a refund, cancellation, or replacement, call propose_action exactly once with clear reasoning. Proposals are reviewed by application policy and may go to a human; you do not execute anything yourself.
- Refund amounts are integer cents (e.g. $12.50 = 1250).
- If a tool reports that an order does not exist or does not match the customer, say so honestly instead of inventing details.
- If no action is needed (e.g. a status question), just answer the customer.
- Finish with a short plain-language summary of what you found and what you did.`;

export async function runAgent(requestId: number): Promise<void> {
  const [request] = await db
    .select({
      id: supportRequests.id,
      customerId: supportRequests.customerId,
      message: supportRequests.message,
      customerName: customers.name,
      customerEmail: customers.email,
    })
    .from(supportRequests)
    .innerJoin(customers, eq(supportRequests.customerId, customers.id))
    .where(eq(supportRequests.id, requestId));

  if (!request) throw new Error(`Support request ${requestId} not found`);

  const [run] = await db
    .insert(agentRuns)
    .values({ requestId, status: "running" })
    .returning();

  const ctx: ToolContext = {
    requestId,
    requestCustomerId: request.customerId,
    runId: run.id,
  };

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const deadline = Date.now() + WALL_CLOCK_BUDGET_MS;

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Support request #${request.id} from customer #${request.customerId} (${request.customerName}, ${request.customerEmail}):\n\n"${request.message}"`,
    },
  ];

  let seq = 0;
  let failure: string | null = null;

  try {
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        failure = `Wall-clock budget of ${WALL_CLOCK_BUDGET_MS / 1000}s exhausted after ${iteration} iterations`;
        break;
      }

      const response = await anthropic.messages.create(
        {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          tools: toolDefinitions,
          messages,
        },
        { timeout: remaining }
      );

      messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason !== "tool_use") break; // end_turn: done

      // Execute every tool_use block, persist each call as it happens, and
      // feed the results back so the model can keep reasoning.
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        seq += 1;
        let output: Record<string, unknown>;
        try {
          output = await runTool(block.name, block.input, ctx);
        } catch (err) {
          // Tools are written not to throw, but if one does the model gets a
          // structured error rather than the loop dying.
          output = {
            error: "tool_execution_error",
            detail: err instanceof Error ? err.message : String(err),
          };
        }
        await db.insert(toolCalls).values({
          runId: run.id,
          seq,
          toolName: block.name,
          input: block.input,
          output,
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(output),
        });
      }
      messages.push({ role: "user", content: toolResults });

      if (iteration === MAX_ITERATIONS - 1) {
        failure = `Reached max iterations (${MAX_ITERATIONS}) without finishing`;
      }
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }

  // Reasoning summary: the model's final text output.
  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant");
  const summary =
    lastAssistant && Array.isArray(lastAssistant.content)
      ? lastAssistant.content
          .filter(
            (b): b is Anthropic.TextBlock =>
              typeof b === "object" && "type" in b && b.type === "text"
          )
          .map((b) => b.text)
          .join("\n")
      : "";

  await db
    .update(agentRuns)
    .set({
      status: failure ? "failed" : "completed",
      reasoningSummary: failure
        ? summary
          ? `${summary}\n\n[run failed: ${failure}]`
          : `[run failed: ${failure}]`
        : summary,
      rawMessages: messages,
      completedAt: new Date(),
    })
    .where(eq(agentRuns.id, run.id));

  // Settle the request status. Escalate when a human still needs to look:
  // either a proposal is pending review, or the run itself failed.
  const pending = await db
    .select({ id: actions.id })
    .from(actions)
    .where(
      and(eq(actions.requestId, requestId), eq(actions.status, "pending_review"))
    );

  const [current] = await db
    .select({ status: supportRequests.status })
    .from(supportRequests)
    .where(eq(supportRequests.id, requestId));

  let nextStatus: "resolved" | "escalated";
  if (pending.length > 0 || failure) {
    nextStatus = "escalated";
  } else if (current.status === "processing") {
    // No pending proposal and the executor didn't already settle it
    // (auto-execute marks the request resolved itself).
    nextStatus = "resolved";
  } else {
    return;
  }
  await db
    .update(supportRequests)
    .set({ status: nextStatus })
    .where(eq(supportRequests.id, requestId));
}
