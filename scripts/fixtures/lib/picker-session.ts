// The session the type picker's server action reads, in the development media
// fixture's process (no request, so no cookie session). The fixture's loader
// (picker-action-session.mjs) gives `src/app/artifacts/upload-typing-actions.ts`
// this module in place of `@/lib/auth-session`; every other importer keeps the
// real one. The session and the actor are the product's own session-free road
// for a known user (`resolveUserContextForUserId`, as MCP and background runs
// use), anchored on the fixture's organization. Outside `runAsPickerUser` the
// reads refuse, so the action never runs without the fixture's user.
import { AsyncLocalStorage } from "node:async_hooks";
import { resolveUserContextForUserId } from "@/lib/auth-session";

export * from "@/lib/auth-session";

type PickerSession = {
  session: { user: { id: string; role: string | null }; session: { activeOrganizationId: string } };
  actor: Awaited<ReturnType<typeof resolveUserContextForUserId>>["actorContext"];
};

const current = new AsyncLocalStorage<PickerSession>();

function read(): PickerSession {
  const s = current.getStore();
  if (!s) throw new Error("The type picker's action read a session outside the fixture's picker session");
  return s;
}

export async function getAuthSession() {
  return read().session;
}

export async function getActorContext() {
  return read().actor;
}

/** Run `fn` with the user's own session in the organization. */
export async function runAsPickerUser<T>(ids: { orgId: string; userId: string }, fn: () => Promise<T>): Promise<T> {
  const resolved = await resolveUserContextForUserId(ids.userId, { activeOrganizationId: ids.orgId });
  if (resolved.sessionOrgId !== ids.orgId) {
    throw new Error(`The user's resolved session is not the organization ${ids.orgId}`);
  }
  const session = { user: { id: ids.userId, role: null }, session: { activeOrganizationId: ids.orgId } };
  return current.run({ session, actor: resolved.actorContext }, fn);
}
