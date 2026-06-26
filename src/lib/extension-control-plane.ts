import "server-only";

// THE single documented control-plane surface for extension activation state
// (acceptance criterion: "Extension activation state has a single documented
// control-plane surface").
//
// It aggregates — read-only — the PROCESS-LOCAL in-memory state of the extension
// runtime: the control-plane GENERATION + recent lifecycle transitions, plus the
// host-owned register-channel registries (MCP tools, capability providers, ctx.ui
// surfaces/actions, object types). It is what the operator diagnostic endpoint
// returns and the canonical place to read "what is live right now".
//
// ISOLATION (codex round-1): this surface exposes only NAMES / IDS / COUNTS — never
// handlers, provider `impl`s, surface payloads, object-type descriptors, secrets,
// config, source paths, store dirs, integrity material, or request context. It is
// PROCESS-LOCAL (this node's in-memory registries), NOT cluster-wide truth. The
// caller (the operator endpoint) is platform-admin gated.

import {
  getActivationControlPlaneSnapshot,
  type ActivationControlPlaneSnapshot,
} from "@/lib/extension-activation-generation";
import { snapshotExtensionMcpTools } from "@/lib/extension-mcp-registry";
import { snapshotCapabilityProviders } from "@/lib/extension-capabilities-registry";
import { snapshotExtensionUi } from "@/lib/extension-ui-registry";
import { snapshotObjectTypes } from "@/lib/extension-object-types-teardown";

export type ExtensionControlPlaneState = {
  /** PROCESS-LOCAL: the in-memory registry state of THIS node, not cluster-wide. */
  scope: "process-local";
  generation: ActivationControlPlaneSnapshot["generation"];
  lastTransitions: ActivationControlPlaneSnapshot["lastTransitions"];
  /** Extension-registered MCP tools — name + owning package only (no handlers). */
  mcpTools: { name: string; packageName: string }[];
  /** Capability providers — capability id + owning package only (no impls). */
  capabilityProviders: { capability: string; packageName: string }[];
  /** ctx.ui registrations — per-package counts + action ids only (no payloads). */
  uiSurfaces: {
    packageName: string;
    setupSurfaces: number;
    settingsSurfaces: number;
    actionIds: string[];
  }[];
  /** Registered object types — id + category only (no descriptors). */
  objectTypes: { type: string; category?: string }[];
};

/**
 * Aggregate the current control-plane state. Pure read of the in-memory
 * registries + the generation counter — no DB, no I/O, no secrets. Synchronous.
 */
export function getExtensionControlPlaneState(): ExtensionControlPlaneState {
  const { generation, lastTransitions } = getActivationControlPlaneSnapshot();
  return {
    scope: "process-local",
    generation,
    lastTransitions,
    mcpTools: snapshotExtensionMcpTools(),
    capabilityProviders: snapshotCapabilityProviders(),
    uiSurfaces: snapshotExtensionUi(),
    objectTypes: snapshotObjectTypes(),
  };
}
