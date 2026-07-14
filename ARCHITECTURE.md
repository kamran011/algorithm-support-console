# Architecture

## Agent Boundary

The agent (`lib/agent.ts`, `runAgent`) is a genuine tool-use loop over the
Anthropic Messages API: the model chooses which tools to call, results are fed
back as `tool_result` blocks, and the loop continues until the model stops or
hits hard limits enforced in code (10 iterations, 45 seconds wall-clock —
on either limit the run is marked `failed` and the request escalates to a
human). Nothing about the tool sequence is hardcoded.

The boundary is asymmetric by design. The three read tools (`lookup_order`,
`get_customer_orders`, `get_refund_history` in `lib/agent-tools.ts`) can be
called freely and never throw — a hallucinated order id returns a structured
`{ found: false }` the model can reason about honestly. The single write tool,
`propose_action`, does exactly one thing: insert a row into `actions`. It
cannot touch `orders` or `refunds`. The decision about what happens to a
proposal belongs to `lib/policy.ts` (`decideProposal`), and the act of making
it real belongs to `lib/executor.ts` (`executeAction`). The model's output is
therefore always a *request*, never an *effect*.

The policy is deliberately narrow: auto-execute only refunds of at most 1000
cents on delivered orders that pass every guardrail; cancellations,
replacements, and everything else escalate to `pending_review` with a
`risk_reason`. The governing principle is that an incorrect refund is far
worse than over-escalating, so every ambiguous branch resolves to a human.

## Tool Design

Every tool input crosses a Zod boundary before touching the database
(`lib/agent-tools.ts`). Malformed inputs — string ids, negative amounts, a
refund without `amount_cents` — come back to the model as structured
`{ error: "invalid_input" }` tool results rather than exceptions, so a
confused model gets a chance to correct itself and a malicious-looking input
never reaches SQL. Tool calls are persisted to `tool_calls` (run id, sequence
number, input, output) as they happen, which is what the review UI renders as
the investigation timeline: the reviewer sees exactly what the agent looked at
before proposing, not a paraphrase of it.

Guardrails live in `lib/guardrails.ts` (`validateAction`), not in the prompt.
The system prompt tells the agent to verify facts and be honest — behavioral
shaping — but contains no refund caps, no status rules, no ownership rules.
Those are enforced twice in code: once at proposal time by `decideProposal`
(to route to auto-execute vs review), and again inside the execution
transaction against locked rows (to make the check binding). A prompt is a
sign on the door; `validateAction` is the lock.

## Failure Handling

Business-rule violations are values, not exceptions: `validateAction` returns
`{ ok: false, reason }`, and `executeAction` records that reason on the action
(`status = 'failed'`, `failure_reason`) and commits it, so a refused execution
is a visible, auditable outcome rather than a 500. Examples with the seed
data: a refund of $60 on order 1006 fails with "exceeds remaining refundable
balance $30.00"; a cancel of shipped order 1002 fails with "status is
'shipped'"; a request from customer A about customer B's order fails the
ownership check.

Losing an approval race is also not an error condition: the conditional
UPDATE in `app/api/actions/[id]/approve/route.ts` returns zero rows, the route
responds 409 with the current row, and the UI shows "Already decided by X"
and refreshes. Agent-level failures (timeout, max iterations, API errors)
mark the run `failed` and the request `escalated` — the queue shows a red
badge but the detail page still renders whatever tool calls did happen, so a
partial investigation is never lost. Database-level backstops (the CHECK
constraint and the unique index on `refunds.action_id`) turn any bug that
slips past all of the above into a rolled-back transaction recorded as a
failed action, never a wrong payout.

## Build vs Buy

In-scope builds were chosen because they are the assessment's subject matter:
the agent loop (~100 lines), the guardrail/policy layer, and the execution
transaction. Everything else leans on boring, proven pieces: Postgres locks
instead of a distributed lock service, Drizzle for typed SQL that keeps
`FOR UPDATE` visible, TanStack Query polling instead of a realtime channel.

In production I would buy/adopt rather than extend the hand-rolled versions:
a queue (pg-boss to stay in Postgres, or SQS) so agent runs happen in workers
instead of inline in the request; Langfuse or a similar LLM-observability tool
for tracing runs (the `raw_messages` jsonb column is the primitive version of
this); Sentry for error reporting; and Temporal if action execution grew
multi-step side effects (payment provider call + email + inventory) that need
durable retries. None of these change the core design — the agent boundary
and the locked execution path stay exactly as they are; they replace the
plumbing around it.

## Design Decisions

- **Single Next.js app** (frontend + route handlers). One deploy surface,
  shared TypeScript types between API and UI, zero CORS. I would split a
  backend out only when work stops fitting a request lifetime: long-running
  workers, queues, scheduled jobs.
- **Drizzle over Prisma**: the concurrency story *is* the assessment, and
  Drizzle lets the important SQL (`SELECT ... FOR UPDATE`, the conditional
  UPDATE, the arithmetic order update) be written literally where a reviewer
  can read it.
- **Supabase as plain Postgres**: no `@supabase/supabase-js`, no RLS, no
  Supabase Auth — just `DATABASE_URL` through the transaction pooler (port
  6543), which serverless requires. `prepare: false` because the pooler
  doesn't support prepared statements.
- **Pool size 4, not 1** (`lib/db/index.ts`): with `max: 1`, a reserved
  transaction plus concurrently queued queries can starve the pool and wedge
  every request (observed during testing, and it would have wedged during the
  two-browser review). 4 gives concurrent approve/execute transactions their
  own connections while staying far under pooler limits.
- **"Shipped with damage claim" auto-refunds are not implemented**: detecting
  a damage claim means trusting LLM interpretation of free text, which is
  exactly what the policy layer must not do. Shipped-order refunds always
  escalate; delivered-order refunds ≤ $10 auto-execute.
- **`send_replacement` executes as a record only**: there is no shipment
  table in scope, so an approved replacement marks the action executed
  without mutating the order. The approval flow and audit trail are identical
  to the other types.
- **Auto-executed actions pass through the same executor**: policy inserts
  the action pre-approved (`decided_by = 'auto-policy'`) and calls
  `executeAction`, ending in status `auto_executed`. One mutation path, two
  entry points, distinguishable in the queue.
- **Human decisions settle requests**: approve or reject marks the support
  request `resolved`; failed executions mark it `escalated` so it stays
  visible.
- **`drizzle-kit push` instead of migration files**: right tradeoff for a
  greenfield assessment; production would switch to generated migrations.
- **Explicit seed ids (1001–1006) with sequence resets** so the README, the
  test scenarios, and reviewer instructions can name exact orders.
