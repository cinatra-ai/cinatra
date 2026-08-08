# cinatra#2544 — live browser proof

Stack: this lane's own dev server (port 3344) on the shared verify Postgres
(`127.0.0.1:5634`, dedicated database `fix2544`) and a lane-scoped Redis, driven by
`tests/e2e/setup/04-setup-gate-soft-nav.spec.ts` through the setup-acceptance
harness (`pnpm test:e2e:setup`). The setup wizard is REAL — `CINATRA_E2E_SETUP_BYPASS`
is deliberately unset; only outbound provider HTTP is answered by the suite's
existing boundary stub.

## Before / after on the SAME spec

The middle arm drives the reported end-of-onboarding transition with Next `<Link>`
hops only — rail → the Model step's Continue → "Skip for now" → `/` → `/chat` —
so no server action revalidates the router cache and the root-layout snapshot
stays exactly as stale as it is for a real operator.

| `src/components/app-shell.tsx` | Result |
| --- | --- |
| `origin/main` (pre-fix) | **FAILS** — settle trace held **9 entries across only 2 distinct paths**: the `/ ↔ /setup` bounce |
| this branch | **PASSES** — 3/3 arms, trace never revisits a path, `window` marker survives (no document reload) |

The 9-vs-2 number is the whole point: loop freedom is asserted by counting
navigations, not by the absence of a crash. The bug never crashed.

## Arms

1. `2544-01-incomplete-lands-on-wizard` — a genuinely incomplete gate still routes a
   fresh load INTO the wizard, once, and stays there.
2. `2544-02-soft-nav-lands-and-stays` — finishing the wizard lands on the app and
   STAYS, with no bounce and no document reload.
3. `2544-03-setup-redirects-out-once` — a direct `/setup` visit on a configured
   instance redirects out once and never re-enters.

Screenshots are captured at both viewports the suite uses (`--narrow`, `--medium`).
