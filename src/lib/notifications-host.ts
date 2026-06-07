// ---------------------------------------------------------------------------
// Notifications host wiring.
//
// Registers the host adapters the @cinatra-ai/notifications server modules
// need. Side-effect-imported at the TOP of every direct `/server` entry path
// so `setNotificationsHostAdapters()` runs (idempotently) before the FIRST
// `@cinatra-ai/notifications/server` use on that path:
//   (a) src/lib/notifications.ts        — the facade
//   (b) src/app/api/notifications/stream/route.ts — the SSE route (imports
//       /server directly, bypassing the facade)
//   (c) src/lib/background-jobs.ts      — THE CRITICAL ONE: the BullMQ worker
//       is eagerly started from src/instrumentation.node.ts:361 and reaches
//       the writers via the background-jobs.ts :1062/:1114 dynamic /server
//       imports; that path imports NEITHER the facade NOR the stream route.
//
// WHY this boot-reachable module does NOT widen the boot graph with the
// package:
//   - It imports the setter ONLY from the TRUE LEAF
//     `@cinatra-ai/notifications/host-adapters` (zero runtime deps, no
//     server graph, no `@/`) — NOT from `/server`. So the boot-time
//     top-level `@/lib/notifications-host` import does NOT load
//     service/realtime/recipient-policy/request-actor.
//   - Its only OTHER static imports are host `@/lib/database` (ALREADY a
//     top-level import in background-jobs.ts at line 6) + `@/lib/postgres-sync`
//     (a leaf) + (type-only, erased) the two ActorContext types for the
//     drift assertion.
//   - Its `getAuthSession`/`buildActorContext` adapters are LAZY async
//     wrappers (dynamic import INSIDE the fn) so the
//     `@/lib/auth-session` -> `@/lib/auth` top-level-await Google-OAuth
//     chain stays OFF the boot graph.
// ---------------------------------------------------------------------------

import { setNotificationsHostAdapters } from "@cinatra-ai/notifications/host-adapters";
import type { NotificationsHostAdapters } from "@cinatra-ai/notifications/host-adapters";

import {
  ensurePostgresSchema,
  getPostgresConnectionString,
} from "@/lib/database";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";

// Bidirectional compile-time compatibility assertion. Package code must not
// cast its ActorContext type onto a narrower host type. Host
// @/lib/authz/actor-context is the source of truth; the package copy in
// host-adapters.ts is drift-guarded by these two assignments — if the host
// type gains/changes a required field, `pnpm typecheck` fails HERE until the
// package copy is updated. Both imports are `import type` (erased at runtime —
// they do NOT widen the boot graph).
import type { ActorContext as HostActorContext } from "@/lib/authz/actor-context";
import type { ActorContext as PackageActorContext } from "@cinatra-ai/notifications/host-adapters";

const _hostAssignableFromPackage: HostActorContext =
  {} as PackageActorContext;
const _packageAssignableFromHost: PackageActorContext =
  {} as HostActorContext;
// Reference them so the unused-locals lint/compiler does not strip the
// assertion (the assignment itself is the type check).
void _hostAssignableFromPackage;
void _packageAssignableFromHost;

const adapters: NotificationsHostAdapters = {
  getPostgresConnectionString,
  ensurePostgresSchema,
  // Matches recipient policy schema resolution:
  // `process.env.SUPABASE_SCHEMA?.trim() || "cinatra"`.
  postgresSchema: process.env.SUPABASE_SCHEMA?.trim() || "cinatra",
  runPostgresQueriesSync,
  // LAZY async wrappers — dynamic import INSIDE the fn so the
  // @/lib/auth-session -> @/lib/auth top-level-await Google-OAuth/DB chain
  // stays OFF the Next.js boot graph (background-jobs.ts is boot-reachable).
  getAuthSession: async () =>
    (await import("@/lib/auth-session")).getAuthSession(),
  buildActorContext: async (session) =>
    (await import("@/lib/authz/enforce")).buildActorContext(session),
};

// Module-load side-effect. Idempotent — multiple entry paths each
// side-effect-import this module; calling the setter again with an
// equivalent adapter is harmless.
setNotificationsHostAdapters(adapters);
