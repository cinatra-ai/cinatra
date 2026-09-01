// -----------------------------------------------------------------------------
// LEG 4 — the PUBLIC ORIGIN, without a browser.
//
// The Development tab's action (`setMcpPublicBaseUrlAction`) is already thin: an
// admin gate, then `setMcpPublicBaseUrl` from `@cinatra-ai/mcp-server`, then two
// route revalidations. There is no route cache to drop outside a request, so
// this wrapper is the same writer with the gate swapped for the runtime one —
// no second row shape, no second validator. `setMcpPublicBaseUrl` composes the
// row through `buildMcpPublicBaseUrlRow`, the dependency-free shape module the
// published CLI's clone road writes through as well, so a row written here is
// byte-equivalent to a row written from either of the other two paths.
//
// THE RESTART STEP IS PART OF THE WRITE, not an afterthought. The OAuth audience
// allowlist is snapshotted once, at plugin construction — so until the app
// restarts, a token request naming the NEW origin is rejected outright and the
// PREVIOUS origin stays accepted. The screen says this in a notice and a toast;
// a command with no screen has to say it in its output, or the operator
// discovers it as a failed token request instead.
// -----------------------------------------------------------------------------

import {
  getMcpPublicBaseUrl,
  setMcpPublicBaseUrl,
} from "@cinatra-ai/mcp-server/credentials";
import { normaliseMcpPublicBaseUrl } from "@cinatra-ai/mcp-server/mcp-public-base-url-shape";
import { assertDevelopmentRuntime } from "@/lib/dev-instance-provisioning/runtime-gate";

/**
 * The one step the operator has to take for a changed origin to be in effect.
 * Mirrors the save toast and the tab's standing notice.
 */
export const PUBLIC_ORIGIN_RESTART_STEP =
  "Restart the app. The public origin is saved immediately, but the OAuth audience " +
  "allowlist external MCP clients bind their tokens to is derived once at startup: " +
  "until the app restarts, a token request naming the new origin is rejected and the " +
  "previous origin stays accepted.";

export type ProvisionPublicOriginOutcome = {
  written: boolean;
  publicOrigin: string | null;
  /** True when a restart is now owed. False when the row already said this. */
  restartRequired: boolean;
  restartStep: string;
};

export function provisionPublicOrigin(url: string | null): ProvisionPublicOriginOutcome {
  assertDevelopmentRuntime("provisionPublicOrigin");

  // The shape module validates and normalises; a bad URL throws HERE, before
  // anything is read or written, with the writer's own wording.
  const { url: normalized } = normaliseMcpPublicBaseUrl(url);
  const stored = getMcpPublicBaseUrl();

  if (stored.publicBaseUrl === normalized) {
    return {
      written: false,
      publicOrigin: stored.publicBaseUrl,
      restartRequired: false,
      restartStep: PUBLIC_ORIGIN_RESTART_STEP,
    };
  }

  setMcpPublicBaseUrl(url);
  return {
    written: true,
    publicOrigin: getMcpPublicBaseUrl().publicBaseUrl,
    restartRequired: true,
    restartStep: PUBLIC_ORIGIN_RESTART_STEP,
  };
}
