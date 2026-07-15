# Support Operations Console

An AI-triaged support queue for an e-commerce store. An Anthropic tool-calling
agent investigates each support request and **proposes** actions (refund,
cancel, replacement). Application code — never the LLM — decides whether a
proposal auto-executes or escalates to a human, enforces every guardrail, and
performs all mutations inside locked database transactions.

**Core invariants**

- The agent's only write tool is `propose_action`; it never mutates orders or refunds.
- The only mutation path is `executeAction` in [lib/executor.ts](lib/executor.ts):
  one transaction, `SELECT ... FOR UPDATE` on the order row, re-run
  `validateAction` ([lib/guardrails.ts](lib/guardrails.ts)) against locked state, then mutate.
- Approval/rejection uses `UPDATE ... WHERE status = 'pending_review' RETURNING`
  ([app/api/actions/[id]/approve/route.ts](app/api/actions/%5Bid%5D/approve/route.ts)) —
  zero rows returned means you lost the race and get a 409 with the current row.
- Double-refund protection: `FOR UPDATE` lock, `CHECK (amount_refunded_cents <= total_amount_cents)`,
  unique index on `refunds.action_id`.

## Setup

Requirements: Node 20+, a Postgres database (Supabase works; use the
**transaction pooler** connection string, port 6543), an Anthropic API key.

```bash
cp .env.example .env.local     # then fill in:
# DATABASE_URL=postgresql://...pooler.supabase.com:6543/postgres
# ANTHROPIC_API_KEY=sk-ant-...

npm install
npx drizzle-kit push           # create tables, enums, CHECK constraint, unique index
npm run seed                   # deterministic test data (resets all tables)
npm run dev                    # http://localhost:3000
```

## Test Data

Run `npm run seed` to reset the database to this state.

### Customers
| ID | Name | Email |
|----|------|-------|
| 1 | Alice Nguyen | alice@example.com |
| 2 | Bob Martinez | bob@example.com |
| 3 | Carol Okafor | carol@example.com |
| 4 | David Kim | david@example.com |
| 5 | Emma Rossi | emma@example.com |

### Orders
| Order ID | Customer | Status | Total | Scenario |
|----------|----------|--------|-------|----------|
| 1001 | Alice | paid | $30.00 | Cancellable (not yet shipped) |
| 1002 | Bob | shipped | $75.50 | Cancel must be refused — already shipped |
| 1003 | Carol | delivered | $45.00 | Large refund — escalates to human review |
| 1004 | David | delivered | $8.00 | Small refund — auto-executes |
| 1005 | Emma | refunded | $25.00 | Already refunded — must be refused |
| 1006 | Alice | delivered | $50.00 | Partially refunded $20 — over-refund must be refused |

### Suggested test scenarios
- Submit "I want a refund for order 1004" as David Kim → expect auto-executed green badge
- Submit "I want a refund for order 1003" as Carol Okafor → expect escalated, approve it
- Submit "Cancel my order 1002" as Bob Martinez → expect escalated with shipped-order risk reason
- Submit "I want a refund for order 9999" as anyone → expect no action, hallucinated order handled cleanly
- Submit "I want a refund for order 1005" as Emma Rossi → expect refused, already refunded
- Open same escalation in two browser tabs, click Approve in both → expect one success, one "Already decided by" banner

## How to verify concurrency

### Automated test

```bash
npm run dev                                # in one terminal
npx tsx scripts/concurrency-test.ts        # in another
```

The script is rerunnable (it creates fresh fixtures each run) and asserts:

- **Phase 1** — two simultaneous approvals of the same action via
  `Promise.all`: exactly one 200 and one 409, exactly one refund row,
  `amount_refunded_cents` incremented exactly once.
- **Phase 2** — two *different* pending refunds on the same order that
  together exceed its total, approved simultaneously: the `FOR UPDATE` lock
  serializes execution, the loser fails in-transaction revalidation (422),
  and no over-refund occurs.

### Two curl commands (concurrent refund approvals)

Create an escalation (submit "Refund my $45 for order 1003" as Carol on the
home page after `npm run seed`), find its action id on the detail page (or
`actions` table), then fire both at once:

```bash
curl -s -X POST http://localhost:3000/api/actions/ACTION_ID/approve \
  -H "Content-Type: application/json" -d '{"reviewer":"alice"}' &
curl -s -X POST http://localhost:3000/api/actions/ACTION_ID/approve \
  -H "Content-Type: application/json" -d '{"reviewer":"bob"}' &
wait
```

One response is `200` with the executed action; the other is `409` with
`"Already decided by ..."` and the current row. The `refunds` table has
exactly one row for that action.

### Two-browser approval test

1. `npm run seed`, then submit *"Refund my $45 for order 1003"* as Carol.
2. Open the escalated request's detail page in **two different browsers**
   (or one normal + one incognito window). Set a different reviewer name in each.
3. Click **Approve & execute** in both as close to simultaneously as you can.
4. One browser gets the executed action. The other shows the amber banner
   *"Already decided by {name}"* and refreshes to the decided state.
5. Check the order: refunded exactly once. The queue (polling every 4s)
   shows the same state in both browsers.

## Deployment (Vercel + Supabase)

1. Push the repo to GitHub and import it into Vercel.
2. Set env vars in Vercel: `DATABASE_URL` (Supabase **transaction pooler**
   string, port 6543 — serverless functions must not hold direct connections)
   and `ANTHROPIC_API_KEY`.
3. `npx drizzle-kit push` and `npm run seed` run locally against the same
   `DATABASE_URL` (they are one-time setup, not build steps).
4. Function duration: `app/api/requests/route.ts` sets `maxDuration = 60`
   (Hobby plan ceiling). The agent loop caps itself at 45s wall-clock and
   escalates to a human on timeout, so requests can't hang into the limit.
   On a Pro plan you may raise both.
5. The DB client ([lib/db/index.ts](lib/db/index.ts)) uses `prepare: false`
   (required by the transaction pooler) and a small `max` pool per instance.

## Commands

| Command | What it does |
|---------|--------------|
| `npm run dev` | dev server on :3000 |
| `npm run seed` | reset + seed deterministic data |
| `npm run build` | production build |
| `npx drizzle-kit push` | sync schema to the database |
| `npx tsx scripts/concurrency-test.ts` | concurrency assertions (needs dev server) |

See [ARCHITECTURE.md](ARCHITECTURE.md) for design rationale.
