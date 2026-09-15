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
// The predicate is the codebase's own (`isAppDevelopmentMode()` /
// `getAppRuntimeMode()`, reading CINATRA_RUNTIME_MODE / APP_RUNTIME_MODE), so
// this path can never disagree with the rest of the app about which runtime it
// is in. It is INDEPENDENT of, and additional to, the admin-session
// authorization the wizard's own actions require: nothing here replaces that
// gate, and nothing here is reachable from a browser at all.
// -----------------------------------------------------------------------------

import { getAppRuntimeMode, isAppDevelopmentMode } from "@/lib/runtime-mode";

export class DevelopmentRuntimeRefusedError extends Error {
  readonly runtimeMode: string;

  constructor(operation: string, runtimeMode: string) {
    super(
      `${operation} is a development-only provisioning write and was refused: ` +
        `this instance runs in the "${runtimeMode}" runtime.`,
    );
    this.name = "DevelopmentRuntimeRefusedError";
    this.runtimeMode = runtimeMode;
  }
}

const RUNTIME_MODE_ENV_KEYS = ["CINATRA_RUNTIME_MODE", "APP_RUNTIME_MODE"] as const;

/** Did an operator SAY which runtime this is, or is the mode merely defaulted? */
function runtimeModeWasDeclared(): boolean {
  return RUNTIME_MODE_ENV_KEYS.some((key) => {
    const value = process.env[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

/**
 * Refuse BEFORE any write when the instance is not a development runtime.
 *
 * TWO conditions, and the second is the one the canonical predicate cannot
 * carry on its own. `getAppRuntimeMode()` treats an UNSET mode as development —
 * the whole app does, and this gate must never disagree with the app about
 * which runtime it is in. But "nobody declared a mode" is not the same claim as
 * "this is a development instance", and a production BUILD always declares
 * itself through NODE_ENV. So an undeclared runtime mode under
 * `NODE_ENV=production` is refused as the ambiguity it is, while a declared
 * development mode still passes under a production build (a developer running a
 * production build locally is exactly who this command is for).
 */
export function assertDevelopmentRuntime(operation: string): void {
  if (!isAppDevelopmentMode()) {
    throw new DevelopmentRuntimeRefusedError(operation, getAppRuntimeMode());
  }
  if (!runtimeModeWasDeclared() && process.env.NODE_ENV === "production") {
    throw new DevelopmentRuntimeRefusedError(
      operation,
      "undeclared under a production build (NODE_ENV=production, no CINATRA_RUNTIME_MODE)",
    );
  }
}
