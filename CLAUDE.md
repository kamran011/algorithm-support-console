# Support Operations Console (timed 8-hour assessment)

## Stack
- Next.js 15 App Router, TypeScript strict, single repo (frontend + API routes together)
- Drizzle ORM + Supabase Postgres via DATABASE_URL (transaction pooler, port 6543)
- Supabase is used as PLAIN POSTGRES ONLY. Never install or use @supabase/supabase-js, RLS, or Supabase Auth.
- @anthropic-ai/sdk for the agent loop, model claude-sonnet-4-6, key in ANTHROPIC_API_KEY
- TanStack Query (refetchInterval 4000, refetchOnWindowFocus, invalidate after mutations)
- Zod at every tool/input boundary, Tailwind for styling, clarity over polish

## Non-negotiable invariants
- The agent's ONLY write tool is propose_action. It never mutates orders or refunds.
- The ONLY mutation path is executeAction in lib/executor.ts: single transaction, SELECT ... FOR UPDATE on the order row, re-run validateAction (lib/guardrails.ts) against locked state, then mutate.
- Guardrails live in application code, never in the prompt.
- Approval/rejection uses conditional UPDATE ... WHERE status = 'pending_review' RETURNING; zero rows returned means lost the race, respond 409 with current row.
- Double-refund protection layers: FOR UPDATE lock, CHECK (amount_refunded_cents <= total_amount_cents), unique index on refunds.action_id.

## Validation loop (run after every significant change)
- npx tsc --noEmit
- npm run build
- npx tsx scripts/concurrency-test.ts (must stay green once it exists)
Fix failures before moving to the next task.

## Commands
- npm run dev / npm run seed / npm run build
- Deploy target: Vercel (route handlers may set maxDuration = 300)

## Rules
- Never commit .env.local (must stay in .gitignore)
- Commit in small logical increments with clear messages
- Make reasonable decisions without asking; note them in ARCHITECTURE.md
