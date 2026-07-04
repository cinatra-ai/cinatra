"use server";

// Serializable SERVER-ACTION REFERENCES for the connector setup-page deps
// (mcp-server-connector, cinatra#612; twenty-connector, twenty-connector#39).
//
// WHY THIS MODULE EXISTS — the RSC serialization rule (twenty-connector#39):
// the host publishes these actions through the capability registry
// (src/lib/register-host-connector-services.ts) and the connector binds them
// DIRECTLY into `<form action={…}>`. React only serializes a function into a
// client payload when it carries a server-reference marker, i.e. when it is
// an export of a `"use server"` module compiled by Next. A plain adapter
// closure defined in a non-`"use server"` module — the registry's previous
// lazy-import wrappers — is a fresh unmarked function, and the setup page
// 500s at form render ("Functions cannot be passed directly to Client
// Components…", digest 1769553696).
//
// WHY NOT top-level re-exports of `@/app/campaigns/actions`: that "use server"
// module carries a heavy nango/wordpress/llm edge graph. This module is
// imported STATICALLY by the boot-path registry binder AND by the connector
// dispatch route, so a static edge to the actions module would drag that
// graph onto the synchronous boot path and into every unit test whose module
// graph reaches the binder (the registry's original reason for lazy
// importing). Each wrapper below therefore lazy-imports the implementation on
// FIRST INVOCATION — but because the wrappers themselves are exports of this
// `"use server"` module, they are genuine server-action references at render
// time. Boot/test-collection stays light; the RSC contract is satisfied.
//
// POST-back resolution: the connector dispatch route
// (src/app/connectors/[vendor]/[slug]/[subroute]/page.tsx) anchors this module
// into its route graph with a side-effect import so the action ids resolve on
// that route in a production build (the registry publication alone lives only
// in the instrumentation graph).
//
// The underlying actions own the FULL authorization boundary (platform-admin
// gate, URL guard, live key probe, Nango import, row writes, redirects) —
// these wrappers add NO behavior and MUST stay logic-free.

/** Add-form create/upsert for the "MCP Servers" connector setup page
 * (cinatra#612). */
export async function createExternalMcpServerAction(
  formData: FormData,
): Promise<void> {
  const { createExternalMcpServerAction: impl } = await import(
    "@/app/campaigns/actions"
  );
  await impl(formData);
}

/** Per-row delete for the "MCP Servers" connector setup page (cinatra#612). */
export async function deleteExternalMcpServerAction(
  formData: FormData,
): Promise<void> {
  const { deleteExternalMcpServerAction: impl } = await import(
    "@/app/campaigns/actions"
  );
  await impl(formData);
}

/** Connect-form save for the Twenty CRM connector setup page
 * (twenty-connector#39). */
export async function saveTwentyConnectionAction(
  formData: FormData,
): Promise<void> {
  const { saveTwentyConnectionAction: impl } = await import(
    "@/app/campaigns/actions"
  );
  await impl(formData);
}

/** Disconnect for the Twenty CRM connector setup page
 * (twenty-connector#39). */
export async function disconnectTwentyConnectionAction(
  formData: FormData,
): Promise<void> {
  const { disconnectTwentyConnectionAction: impl } = await import(
    "@/app/campaigns/actions"
  );
  await impl(formData);
}
