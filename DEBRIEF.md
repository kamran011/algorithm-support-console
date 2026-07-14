# DEBRIEF — personal study guide

Not for reviewers. This is the cheat sheet for explaining every important
decision in this project out loud, with the exact file to point at.

---

## 1. The agent loop

**One-liner:** `runAgent` in `lib/agent.ts` is a while loop over the Anthropic
Messages API: send messages, if the model returns `tool_use` blocks execute
them and append `tool_result` blocks, repeat until `end_turn` or a hard limit
(10 iterations / 45s wall clock).

**Analogy:** a junior support rep who can look things up in any system, but
must file a request form for anything that touches money. They decide what to
look up and in what order. The form goes in a tray; someone else decides.

**Point at:** `lib/agent.ts`, `runAgent`, the `for` loop over
`anthropic.messages.create`.

**Likely question:** *"Why is this 'agentic' and not just a completion?"*
**Answer:** A single completion answers from the prompt alone. Here the model
chooses tools, observes real data, and adapts — for "refund order 9999" it
calls `lookup_order`, sees `found: false`, then checks the customer's actual
orders before answering. The control flow is decided by the model at runtime;
only the limits are decided by my code. Max iterations exists because a loop
that lets a model decide when to stop needs a stop the model doesn't control.

## 2. The agent boundary (propose, never execute)

**One-liner:** the agent's only write tool is `propose_action`, which inserts
a row into `actions` and nothing else; orders and refunds are only ever
mutated by `executeAction`.

**Analogy:** a bank teller trainee who can read any account screen, but every
transaction slip goes to the manager's tray. The trainee can write slips all
day; no money moves until the manager acts.

**Point at:** `lib/agent-tools.ts`, `proposeAction` (the insert), versus
`lib/executor.ts`, `executeAction` (the only writes to orders/refunds).

**Likely question:** *"Why not let the agent execute small refunds directly?"*
**Answer:** Small refunds *do* auto-execute — but the decision is made by
`decideProposal` in `lib/policy.ts`, deterministic application code, not by
the model. The model can't even express "execute"; its vocabulary ends at
"propose". That means a jailbroken or hallucinating model can at worst create
an embarrassing proposal that a human sees and rejects.

## 3. Guardrails in code vs prompt

**One-liner:** every business rule (over-refund, wrong status, ownership,
existence) lives in `validateAction` in `lib/guardrails.ts` and is checked in
application code; the system prompt contains behavioral guidance only.

**Analogy:** a "do not enter" sign vs a locked door. The prompt is the sign —
nice, usually respected. `validateAction` is the lock: it doesn't matter what
the model was told or what it believes, the door doesn't open.

**Point at:** `lib/guardrails.ts`, `validateAction`. The exact rules: order
must exist; order must belong to the requesting customer
(`support_request.customer_id === order.customer_id`); refund amount must be
a positive integer ≤ `total_amount_cents - amount_refunded_cents`; no refunds
on `refunded`/`cancelled` orders; no cancels on
`shipped`/`delivered`/`refunded`/`cancelled` orders.

**Likely question:** *"The prompt says 'propose at most one action' — isn't
that a guardrail in the prompt?"*
**Answer:** That's shaping, and it's allowed to fail. If the model proposes
three actions, each one still passes through policy and guardrails
independently; the worst case is extra rows for a human to reject. Prompt
rules are for quality; code rules are for safety. Nothing that protects money
or state relies on the prompt.

## 4. Re-validation inside the transaction (TOCTOU)

**One-liner:** `executeAction` re-runs `validateAction` *inside* the
transaction, after `SELECT ... FOR UPDATE`, because any check done earlier
describes a state that may no longer exist.

**Analogy:** spotting a free parking space from across the lot vs checking
again as you pull in. Between the look and the arrival, someone else may have
taken it. The check that counts is the one made when you're committed and the
space can't change under you.

**Point at:** `lib/executor.ts`, `executeAction` — the comment "Layer 2:
re-validate against locked state (TOCTOU)".

**Likely question:** *"You validate at proposal time too — why twice?"*
**Answer:** The proposal-time check (in `decideProposal`) is routing: does
this qualify for auto-execution or should a human see it? It can be minutes or
days stale by the time someone clicks approve. The in-transaction check is
enforcement against the row as it exists right now, under lock. First check
decides *where it goes*; second check decides *whether it happens*.

## 5. SELECT ... FOR UPDATE (row locks)

**One-liner:** `FOR UPDATE` takes an exclusive row lock; a second transaction
touching the same row blocks until the first commits, then sees the committed
new state.

**Analogy:** one key to a changing room. The next person doesn't get an error
— they wait at the door, and when they get in, the room is in whatever state
the previous person left it. Nobody ever sees the room mid-change.

**Point at:** `lib/executor.ts`, `executeAction`:
`SELECT * FROM orders WHERE id = ${action.orderId} FOR UPDATE`.

**Likely question:** *"What exactly does the second transaction experience?"*
**Answer:** Its `FOR UPDATE` statement simply doesn't return until the first
transaction commits or rolls back. When it returns, subsequent reads in that
transaction see the updated row — e.g. `amount_refunded_cents` already
incremented — so `validateAction` fails with "exceeds remaining refundable
balance" and the action is marked failed. Blocking, then honest data. Phase 2
of `scripts/concurrency-test.ts` demonstrates exactly this.

## 6. The conditional UPDATE (compare-and-swap)

**One-liner:** approval is
`UPDATE actions SET status='approved', decided_by=$r, decided_at=now() WHERE
id=$1 AND status='pending_review' RETURNING *` — an atomic compare-and-swap;
zero rows returned means someone else already decided, respond 409.

**Analogy:** two people grabbing the last item on a shelf. The shelf, not the
shoppers, decides who got it. One hand closes on the item; the other closes on
air, and "air" (zero rows) is unambiguous.

**Point at:** `app/api/actions/[id]/approve/route.ts`, the `db.update(...)
.where(and(eq(id), eq(status,'pending_review'))).returning()` call and the big
comment above it.

**Likely question:** *"Why not check the status first, then update?"*
**Answer:** Read-then-write has a gap: both reviewers read `pending_review`,
both update, both believe they won. The conditional UPDATE moves the check
into the same atomic statement as the write — Postgres evaluates the WHERE
under the row lock, so exactly one session can transition the row out of
`pending_review`. It's optimistic concurrency: no lock held while a human
stares at the page, and the race is decided in one statement at the moment of
action.

## 7. CHECK constraint + unique index (last-line defenses)

**One-liner:** `CHECK (amount_refunded_cents BETWEEN 0 AND
total_amount_cents)` on `orders` and a unique index on `refunds.action_id`
make over-refunds and double payouts impossible at the storage layer, even if
every line of application code is wrong.

**Analogy:** the circuit breaker panel in a house. Every appliance can
misbehave simultaneously; the panel still cuts the power. You never plan to
rely on it — you plan for it to never fire — but you don't build without it.

**Point at:** `lib/db/schema.ts` — the `check(...)` on `orders` and
`uniqueIndex("refunds_action_id_unique")` on `refunds`.

**Likely question:** *"If the guardrails work, why do you need these?"*
**Answer:** Because the guardrails are code I wrote this week and the
constraints are enforced by Postgres on every write path that will ever
exist — including next year's admin script and a bug I haven't written yet.
Defense in depth: lock, revalidation, constraint, unique index. Each layer
assumes the layers above it have failed.

## 8. Polling vs websockets, and "honest concurrent state"

**One-liner:** TanStack Query refetches every 4s (`refetchInterval: 4000`,
`refetchOnWindowFocus`, invalidation after mutations); approval conflicts
surface as 409 + banner + refetch rather than pretending the click worked.

**Analogy:** a wall clock that's at most 4 seconds behind vs installing a
synchronized atomic clock network. For deciding whether to approve a refund,
4 seconds of staleness is irrelevant — what matters is that the moment you
*act*, the system tells you the truth.

**Point at:** `app/providers.tsx` (query defaults), and the 409 handling in
`app/requests/[id]/page.tsx` (`decide` mutation, the `conflict` banner).

**Likely question:** *"Why not websockets or SSE?"*
**Answer:** Correctness never depends on freshness here — the conditional
UPDATE decides races at write time, so the UI can afford to be a few seconds
stale. Websockets buy those seconds back at the cost of connection management,
serverless incompatibility, and reconnect logic. "Honest concurrent state"
means: polling converges every view within 4s, and when your action loses a
race you get a 409 with the winning row, a banner naming who decided, and a
refresh — never a silent failure or a fake success.

## 9. Single Next.js app vs separate backend

**One-liner:** one repo, one deploy: route handlers are the backend, pages are
the frontend, `lib/` types are shared by both.

**Analogy:** a food truck vs a restaurant with a separate kitchen building.
At this scale the truck is faster, cheaper, and nothing gets cold in transit.
You build the separate kitchen when you start catering (background work).

**Point at:** the repo layout — `app/api/*` next to `app/*`, both importing
`lib/db/schema.ts` types.

**Likely question:** *"When would you split it?"*
**Answer:** When work stops fitting inside a request lifetime: long-running
agent jobs, queues, retries, scheduled work. The first real change would be
moving `runAgent` from inline-in-POST to a worker consuming a queue
(pg-boss/SQS). The domain modules (`lib/guardrails.ts`, `lib/executor.ts`,
`lib/policy.ts`) move unchanged — that's why they're plain functions, not
route code.

## 10. Drizzle, Supabase-as-Postgres, Zod

**One-liner:** Drizzle because the load-bearing SQL stays visible; Supabase
used purely as managed Postgres over `DATABASE_URL` (transaction pooler, port
6543, `prepare: false`); Zod because tool inputs come from a language model.

**Analogy (Zod):** a bouncer checking IDs at the door of every tool. The model
can *say* anything — `order_id: "lol"`, `amount_cents: -500` — but nothing
malformed gets past the door and into SQL.

**Point at:** `lib/db/index.ts` (client config), `lib/agent-tools.ts` (Zod
schemas and `safeParse` at the top of every tool), the raw
`sql\`SELECT ... FOR UPDATE\`` in `lib/executor.ts`.

**Likely question:** *"Why Drizzle over Prisma?"*
**Answer:** This assessment is graded on concurrency, and Drizzle lets me
write `SELECT ... FOR UPDATE` and the conditional UPDATE as visible SQL in
the exact spot a reviewer inspects. Prisma can do it via `$queryRaw` or
interactive transactions, but the crucial lines end up either escaping the
ORM or hidden inside it. Also: no RLS or Supabase Auth because the app has no
end-user auth surface — a reviewer name in localStorage is honest about its
security level (none, deliberately) instead of pretending.

## 11. Failure walkthroughs (know these cold)

**Hallucinated order 9999:** agent calls `lookup_order(9999)` → tool returns
`{ found: false, message: "No order with id 9999 exists" }` (no throw). The
model tells the customer the order doesn't exist; typically calls
`get_customer_orders` and lists their real orders. If it stubbornly proposed
an action anyway, `decideProposal` escalates it with "Guardrail: Order 9999
does not exist" — a human sees it and rejects. Verified live during the build.

**Refund $60 on order 1006 ($50 total, $20 refunded):** proposal escalates
(over cap); on approve, `validateAction` inside the transaction fails —
"Refund of $60.00 exceeds remaining refundable balance $30.00" — action
marked `failed` with that reason, order untouched.

**Customer A asks about customer B's order:** `validateAction` compares
`support_request.customer_id` to `order.customer_id` and refuses: "Order X
does not belong to the requesting customer". Escalation risk_reason carries
it; execution would refuse it independently.

## 12. Build vs Buy (production adoption list)

**One-liner:** built the things being assessed (agent loop, guardrails,
executor); would adopt infrastructure that takes months to get right.

- **pg-boss or SQS** — agent runs belong in a worker, not a request handler.
  pg-boss first: it's just Postgres, no new infra.
- **Langfuse** (or Braintrust/LangSmith) — `agent_runs.raw_messages` is a
  hand-rolled trace store; real tracing adds cost, latency, and eval tooling.
- **Sentry** — error visibility beyond `console.error`.
- **Temporal** — only if execution grows multi-step external side effects
  (payment API + email + inventory) needing durable retries; a Postgres
  transaction can't span a Stripe call.

**Likely question:** *"Why didn't you add a queue now?"*
**Answer:** Eight hours, and inline execution changes nothing about the
correctness story — the same `executeAction` runs either way. The queue is an
operational upgrade, not a safety one. I kept the seam clean so the swap is
mechanical.

## 13. The three files to point at

1. **`lib/guardrails.ts` — `validateAction`.** Every business rule, typed
   results, never throws for rule violations.
2. **`lib/executor.ts` — `executeAction`.** The only mutation path: one
   transaction, action row locked, order row locked with `FOR UPDATE`,
   re-validate, mutate, mark executed. Four labeled defense layers.
3. **`app/api/actions/[id]/approve/route.ts`.** The conditional
   UPDATE ... WHERE status='pending_review' RETURNING, the 409 path, and
   execution-in-the-same-request after winning.

---

## Rapid-fire Q&A

**1. What happens if two refunds arrive at the exact same millisecond?**
The database serializes them: one transaction gets the `FOR UPDATE` lock on
the order row, the other waits. The waiter then re-validates against the
committed state and fails the remaining-balance guardrail if the money is
gone. Exactly one refund row exists; Phase 2 of the concurrency test proves it.

**2. What if the LLM tries to refund a shipped order?**
The proposal is created — the agent is allowed to be wrong — but
`decideProposal` escalates it (only delivered orders auto-refund), and if a
human approves anyway, that's an allowed human decision; refunds are only
blocked on `refunded`/`cancelled` orders. The point: the model's belief never
decides; code and humans do.

**3. Why is approval the thing that executes, not the agent?**
Execution requires authority, and the agent has none by construction — its
only verb is "propose". Approval is where a human (or deterministic policy)
takes responsibility, so execution hangs off that decision, in the same
request, through the one audited path.

**4. How would you scale this to 10,000 requests/day?**
10k/day is ~7/minute — one Postgres and a queue handle it easily. Move agent
runs to workers (pg-boss), add indexes on the hot foreign keys, paginate the
queue endpoint. The locking design doesn't change: locks are per-order-row,
and contention on a single order stays rare at any scale.

**5. What breaks first under load?**
The inline agent run in POST /api/requests — it holds a serverless function
(and its DB connections) for up to 45s per submission. Concurrent submissions
exhaust pooler connections or function concurrency before anything else
hurts. That's why the production path is a queue + status polling, which the
UI already does.

**6. How do you know the agent didn't hallucinate the order data shown to the reviewer?**
The reviewer never reads the model's prose for facts. The order card is
rendered from a direct DB query (`/api/requests/[id]` joins the orders
table), and the tool-call timeline shows raw tool outputs — actual database
responses — not the model's summary of them. The model's text is labeled as
reasoning, and nothing downstream consumes it.

**7. Walk me through a double-approval race.**
Both reviewers see `pending_review`. Both POST approve. Postgres runs the two
conditional UPDATEs serially on the row: the first matches and transitions to
`approved`; the second's WHERE finds `status='approved'` and matches zero
rows. Zero rows → route fetches the current row and returns 409 → UI banner
"Already decided by X" and refresh. The winner's request goes on to execute.

**8. What if the process dies between approval and execution?**
The action is stuck at `approved` with `decided_by` set — visible, auditable,
and safe: nothing was paid. Re-running execution is idempotent-or-fail thanks
to the unique index on `refunds.action_id`. Production fix: an outbox/queue so
approval enqueues execution durably instead of doing it in-process.

**9. Why is the refund insert and the order update in one transaction?**
They're one fact: "this action paid this money". Split, a crash between them
leaves a refund row that the order total doesn't reflect (or vice versa).
Atomicity makes the invariant `sum(refunds) == amount_refunded_cents` hold at
every commit boundary.

**10. Why does `validateAction` return values instead of throwing?**
A rule violation is an expected outcome, not an exception — it has to be
recorded on the action and shown to humans. Typed `{ ok, reason }` forces
every caller to handle it; exceptions invite forgetting, and a forgotten
catch in money code is how wrong payouts happen.

**11. Why cap auto-refunds at $10 and only for delivered orders?**
The cap bounds the blast radius of full automation: worst case is small,
known, and per-order. Delivered-only because that's the state where "customer
has the goods and something's wrong" is least ambiguous. Everything else is
an amber row in a queue — cheap. The asymmetry is deliberate: a wrong refund
costs real money; over-escalation costs seconds of human attention.

**12. What stops the agent from proposing an action for a different customer's order?**
Nothing stops the *proposal* — and it doesn't need to. `validateAction`
compares the support request's customer_id to the order's customer_id at
policy time (escalates with the ownership reason) and again inside the
execution transaction (refuses). The tool context carries the request's
customer id from the server side; the model can't spoof it.

**13. Why store `raw_messages` on the run?**
Audit and debugging: when someone asks "why did the agent propose this?", the
full message history including every tool result is the answer. It's also the
dataset you'd need later for evals or fine-tuning judgment on escalations.

**14. What's the weakest part of this system?**
Reviewer identity is a localStorage name — fine for the assessment, unusable
for production audit. Second: inline agent execution ties request latency to
model latency. Both are deliberate scope cuts, and both have clean seams
(auth middleware on the two decision routes; queue behind the POST).

**15. If you had one more day, what would you add?**
Auth on approve/reject (even basic session auth), the queue for agent runs,
and a small eval harness: replay a fixed set of support messages through the
agent and assert the policy outcomes (auto vs escalate vs refuse) stay stable
across prompt and model changes. That last one is what makes the system safe
to iterate on.
