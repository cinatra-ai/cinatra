// -----------------------------------------------------------------------------
// THE RUNTIME GATE the development-only provisioning writes ask for THEMSELVES.
//
// Every wrapper in this directory calls `assertDevelopmentRuntime` as its first
// executable statement — not once at the top of the composed command. A single
// top-level gate is a gate on ONE caller; a member that is only ever safe in
// development has to be safe no matter who reaches it, including a future
// caller nobody has written yet. Mirrors `assertDevSetupHostOnly`, which the
// host already applies to its dev-boot provisioning members.
//
// The gate starts from the codebase's own predicate (`isAppDevelopmentMode()` /
// `getAppRuntimeMode()`, reading CINATRA_RUNTIME_MODE / APP_RUNTIME_MODE) and
// then asks for MORE than it. That predicate is a two-value projection: every
// spelling that is not a production one projects onto "development". Right for
// a feature switch, too generous for a setup command that writes — so this gate
// requires a runtime mode it recognises BY NAME and fails closed on everything
// else. It therefore disagrees with the app about which runtime it is in, on
// purpose and in the CLOSED direction only: it refuses runtimes the shared
// reading would call development, and it never accepts one the shared reading
// calls production.
//
// It is INDEPENDENT of, and additional to, the admin-session authorization the
// wizard's own actions require: nothing here replaces that gate, and nothing
// here is reachable from a browser at all.
// -----------------------------------------------------------------------------

import { getAppRuntimeMode, isAppDevelopmentMode } from "@/lib/runtime-mode";

export class DevelopmentRuntimeRefusedError extends Error {
  readonly runtimeMode: string;

  constructor(operation: string, runtimeMode: string, because?: string) {
    super(
      `${operation} is a development-only provisioning write and was refused: ` +
        (because ?? `this instance runs in the "${runtimeMode}" runtime.`),
    );
    this.name = "DevelopmentRuntimeRefusedError";
    this.runtimeMode = runtimeMode;
  }
}

const RUNTIME_MODE_ENV_KEYS = ["CINATRA_RUNTIME_MODE", "APP_RUNTIME_MODE"] as const;

/**
 * The runtime-mode spellings this command accepts as a development instance,
 * compared with surrounding blanks trimmed and letter case folded. Exactly one
 * today, and the list is the single source the refusal message reads from.
 *
 * `development` is the one spelling every strict development-only switch in the
 * codebase tests for (`CINATRA_RUNTIME_MODE === "development"`) and the one
 * `.env.example` ships, so it is exactly what this gate accepts.
 *
 * A SHORT FORM is deliberately absent. The shared reading accepts `prod`
 * alongside `production` (`src/lib/runtime-mode.ts`), but that works only
 * because the strict switches are NEGATIVE tests — `!== "development"` — so a
 * short form still turns every development path off. A short development form
 * is the opposite: it is a positive miss. An instance declaring one would
 * receive these development-only writes while every development path in the app
 * stayed off, so the gate does not recognise it.
 *
 * `demo` is not a member either: a demo instance IS a development instance and
 * declares `CINATRA_RUNTIME_MODE=development`, carrying its overlay on the
 * separate `CINATRA_INSTALL_PROFILE` axis (`src/lib/install-profile.ts`), so no
 * shipped install writes it here.
 */
const DEVELOPMENT_RUNTIME_SPELLINGS = ["development"] as const;

const RUNTIME_MODE_ENV_PHRASE = RUNTIME_MODE_ENV_KEYS.join(" / ");
const ACCEPTED_SPELLINGS_PHRASE = DEVELOPMENT_RUNTIME_SPELLINGS.map(
  (spelling) => `"${spelling}"`,
).join(" or ");

/**
 * The runtime mode an operator DECLARED, or `null` when nobody did.
 *
 * Same key precedence as `getAppRuntimeMode()`: the first key carrying a
 * non-blank value wins, and a blank value is not a declaration.
 */
function declaredRuntimeMode(): string | null {
  for (const key of RUNTIME_MODE_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

/** Is `value` a development spelling this command recognises? */
function isDevelopmentSpelling(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (DEVELOPMENT_RUNTIME_SPELLINGS as readonly string[]).includes(normalized);
}

/**
 * Refuse BEFORE any write unless this instance is a development instance.
 *
 * THREE conditions, and the last two ask for more than the canonical predicate
 * carries on its own.
 *
 *   1. The shared reading calls this a production runtime → refused.
 *   2. A DECLARED runtime mode that is not a development spelling above →
 *      refused, under every build. The shared reading projects every
 *      non-production spelling onto "development"; this command recognises its
 *      development instances by name instead, so a setup command fails closed
 *      on a mode it does not recognise rather than treating a short form,
 *      `staging`, `preview` or a misspelling as a development instance. This is
 *      the one place the gate disagrees with the app about which runtime it is
 *      in, and it disagrees only in the closed direction.
 *   3. An UNDECLARED runtime mode under `NODE_ENV=production` → refused. The
 *      shared reading defaults an undeclared mode to development explicitly
 *      (`getAppRuntimeMode()` returns "development" when no key carries a
 *      value), and the gate keeps parity with it: an undeclared mode is
 *      accepted whenever the build is not a production one. "Nobody declared a
 *      mode" is not the same claim as "this is a development instance", though,
 *      and a production BUILD does declare itself through NODE_ENV — so that
 *      one combination is refused as the ambiguity it is.
 *
 * A declared development mode still passes under a production build: a
 * developer running a production build locally is exactly who this command is
 * for.
 *
 * A refusal names the variable and the spellings this command accepts. It never
 * repeats a value the environment supplied.
 */
export function assertDevelopmentRuntime(operation: string): void {
  if (!isAppDevelopmentMode()) {
    throw new DevelopmentRuntimeRefusedError(operation, getAppRuntimeMode());
  }

  const declared = declaredRuntimeMode();
  if (declared !== null) {
    if (!isDevelopmentSpelling(declared)) {
      throw new DevelopmentRuntimeRefusedError(
        operation,
        "a declared runtime mode this command does not recognise",
        `${RUNTIME_MODE_ENV_PHRASE} declares a runtime mode this command does not ` +
          `recognise. It runs on development instances only and accepts ` +
          `${ACCEPTED_SPELLINGS_PHRASE} (any letter case, surrounding blanks trimmed).`,
      );
    }
    return;
  }

  if (process.env.NODE_ENV === "production") {
    throw new DevelopmentRuntimeRefusedError(
      operation,
      "an undeclared runtime mode under a production build",
      `no ${RUNTIME_MODE_ENV_PHRASE} is set and NODE_ENV is "production". This command ` +
        `runs on development instances only: declare ${ACCEPTED_SPELLINGS_PHRASE} to name ` +
        `this one.`,
    );
  }
}
