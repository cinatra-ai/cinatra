import "server-only";

// RSC-layer server-reference BRIDGE for the connector setup-page form actions
// (twenty-connector#39).
//
// THE LAYERING PROBLEM THIS SOLVES: the host publishes the setup-page actions
// through the capability registry from `register-host-connector-services`,
// which loads on the BOOT path (src/instrumentation.node.ts). Next.js compiles
// the instrumentation graph WITHOUT the "use server" reference transform, so
// the function instances published at boot — even though they are exports of a
// genuine `"use server"` module — carry NO server-reference marker
// (`$$typeof`/`$$id`). The connector captures those instances into its deps
// slot at activation (also boot) and binds them into `<form action={…}>`;
// React's RSC serializer rejects an unmarked function at form render (digest
// 1769553696 — the twenty setup page 500'd for every admin).
//
// The SAME module imported from a page/route graph IS compiled with the
// transform, and the compiler mints a DETERMINISTIC action id, identical
// across compilation layers. Boot runs before any page compile, so no page-
// layer instance can be published into the registry ahead of the connector's
// capture — but the registry and the connector deps slot hold the SAME
// function OBJECT (both globalThis-anchored). This module therefore runs in
// the CONNECTOR DISPATCH ROUTE's graph (see the import in
// src/app/connectors/[vendor]/[slug]/[subroute]/page.tsx) and reflects the
// compiler-minted reference metadata from its own (transformed) import of the
// "use server" module onto the boot-published function objects, IN PLACE:
//
//   - RENDER: the connector's captured deps member now carries `$$typeof` /
//     `$$id`, so React serializes it into the client payload like any other
//     server action.
//   - POST-BACK: the browser posts the compiler's action id, which resolves in
//     THIS route's server-reference manifest (the "use server" module is in
//     the route graph via this bridge) and executes the transformed module's
//     export — the exact same lazy-loaded host action, with its full authz.
//
// This adds NO new action surface: the ids it reflects are the ones the Next
// compiler already minted for `@/app/campaigns/connector-setup-actions`; the
// invocation path is Next's normal server-action dispatch. When every
// setup-page consumer moves to connector-local "use server" actions (the
// apify/github pattern), this bridge and the registry publication can retire
// together.
//
// Idempotent + fail-soft: re-evaluation (dev HMR, multiple layers) re-copies
// the same descriptors; a layer whose import is NOT transformed (no `$$id`,
// e.g. the BullMQ worker) and a not-yet-published registry are both no-ops.

import * as transformedSetupActions from "@/app/campaigns/connector-setup-actions";
import { resolveCapabilityProviders } from "@/lib/extension-capabilities-registry";
import { HOST_CONNECTOR_SERVICE_CAPABILITIES } from "@cinatra-ai/sdk-extensions/internal";

/** Published external-mcp-registry service member -> export of the
 * "use server" connector-setup-actions module it was published from. */
const MEMBER_TO_EXPORT = {
  createServerAction: "createExternalMcpServerAction",
  deleteServerAction: "deleteExternalMcpServerAction",
  saveTwentyConnectionAction: "saveTwentyConnectionAction",
  disconnectTwentyConnectionAction: "disconnectTwentyConnectionAction",
} as const;

/**
 * Copy the server-reference metadata (every own property the reference
 * transform added — `$$typeof`, `$$id`, `$$bound`, the `bind` override, … —
 * i.e. everything a plain async function does not carry) from `reference`
 * onto `target`, in place. Pure + exported for the unit regression.
 */
export function copyServerReferenceProps(
  reference: (formData: FormData) => Promise<void>,
  target: (formData: FormData) => Promise<void>,
): void {
  const descriptors = Object.getOwnPropertyDescriptors(reference);
  for (const [prop, descriptor] of Object.entries(descriptors)) {
    if (prop === "length" || prop === "name") continue;
    Object.defineProperty(target, prop, { ...descriptor, configurable: true });
  }
}

/**
 * Reflect the transformed layer's server-reference metadata onto the
 * boot-published action instances. Exported for the unit regression; the
 * module-scope call below wires the real registry + module.
 */
export function reflectConnectorSetupActionReferences(
  impl: Record<string, unknown> | undefined,
  transformed: Record<string, unknown>,
): void {
  if (!impl) return; // registry not published in this process (never on the serving path — boot precedes serving)
  for (const [member, exportName] of Object.entries(MEMBER_TO_EXPORT)) {
    const published = impl[member];
    const reference = transformed[exportName];
    if (typeof published !== "function" || typeof reference !== "function") continue;
    if (published === reference) continue; // single-compilation runtime (unit tests): already the reference
    if (!Object.getOwnPropertyDescriptor(reference, "$$id")) continue; // this layer's import is untransformed: nothing to reflect
    copyServerReferenceProps(
      reference as (formData: FormData) => Promise<void>,
      published as (formData: FormData) => Promise<void>,
    );
  }
}

reflectConnectorSetupActionReferences(
  resolveCapabilityProviders(
    HOST_CONNECTOR_SERVICE_CAPABILITIES.externalMcpRegistry,
  ).find((p) => p.packageName === "@cinatra-ai/host")?.impl as
    | Record<string, unknown>
    | undefined,
  transformedSetupActions,
);
