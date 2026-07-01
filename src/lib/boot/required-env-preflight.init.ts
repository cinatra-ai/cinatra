// Side-effect preflight entry (cinatra#789 item 3).
//
// Importing this module RUNS the required-env preflight immediately, at module load.
// It is imported as the FIRST line of `src/instrumentation.node.ts`'s import block so
// it executes BEFORE every other DI-wiring binder (some of which — e.g. `@/lib/auth`
// via the register-* chain — throw at import on a missing env var). Running here lets
// the app fail with ONE clear, aggregated message naming every missing required var,
// before a downstream module throws a narrower error.
//
// The preflight ONLY arms in app-runtime production and NOT during the Next.js
// `next build` page-data phase (the image build runs NODE_ENV=production without the
// deploy secrets) — see required-env-preflight.ts for the scope guard. So this import
// is inert during the build and in dev; it enforces only at prod runtime boot.

import { runRequiredEnvPreflight } from "@/lib/boot/required-env-preflight";

runRequiredEnvPreflight();
