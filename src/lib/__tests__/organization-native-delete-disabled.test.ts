import { describe, it, expect } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { buildCinatraOrganizationPlugin } from "../better-auth-plugins";

// ---------------------------------------------------------------------------
// cinatra#1936 regression: organization deletion has exactly ONE door — the
// reference-guarded Danger-zone action (src/lib/organization-delete.ts,
// cinatra#1928). Better Auth's native `/organization/delete` endpoint is an
// UNGUARDED cascade delete; the runtime disables it via the plugin's
// first-party `disableOrganizationDeletion` option (threaded through
// `buildCinatraOrganizationPlugin` in src/lib/better-auth-plugins.ts, set
// `true` in src/lib/auth.ts). Upstream enforcement (better-auth 1.6.23,
// plugins/organization/routes/crud-org.mjs) throws 404
// `ORGANIZATION_DELETION_DISABLED` as the endpoint's FIRST gate — before the
// session lookup — so the refusal is identical on BOTH transports:
//   - raw HTTP  (`auth.handler(new Request(...))`)
//   - in-process (`auth.api.deleteOrganization(...)`)
// The controls below prove the refusal comes from the option (not a harness
// artifact) and pin the `!== undefined` threading: an explicit `false` must
// reach upstream instead of being dropped by a truthiness spread.
//
// Same memory-adapter harness as organization-default-team-slug.test.ts: the
// real `betterAuth()` instance with the real cinatra organization plugin.
// ---------------------------------------------------------------------------

type OrgRow = { id?: string; name?: string; slug?: string };

// Seed every model the emailAndPassword + organization(teams) surface touches
// (the in-memory adapter throws "Model <x> not found" otherwise).
function makeDb(): Record<string, unknown[]> {
  return {
    user: [],
    account: [],
    session: [],
    verification: [],
    organization: [],
    member: [],
    invitation: [],
    team: [],
    teamMember: [],
  };
}

function makeAuth(
  db: Record<string, unknown[]>,
  organizationOptions: Parameters<typeof buildCinatraOrganizationPlugin>[0],
) {
  return betterAuth({
    appName: "Cinatra",
    secret: "test-secret-cinatra-1936-abcdefghijklmnop",
    emailAndPassword: { enabled: true },
    database: memoryAdapter(db),
    plugins: [buildCinatraOrganizationPlugin(organizationOptions)],
  });
}

// Sign up an owner and capture BOTH the user id and a session cookie
// (signUpEmail auto-signs-in; `asResponse: true` exposes Set-Cookie). The
// delete endpoint requires a session AFTER the disable gate — the controls
// need a real owner session to prove deletion still works when enabled.
async function seedOwnerWithSession(auth: ReturnType<typeof makeAuth>) {
  const email = `owner-${crypto.randomUUID()}@example.test`;
  const password = "correct-horse-battery-staple";
  const res = await auth.api.signUpEmail({
    body: { email, password, name: "Org Owner" },
    asResponse: true,
  });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  expect(cookie).not.toBe("");
  const body = (await res.json()) as { user: { id: string } };
  return { userId: body.user.id, cookie };
}

async function seedOrg(
  auth: ReturnType<typeof makeAuth>,
  userId: string,
): Promise<string> {
  const org = await auth.api.createOrganization({
    body: { name: "Acme Corp", slug: "acme-corp", userId },
  });
  expect(org).toBeTruthy();
  return org!.id;
}

function httpDelete(
  auth: ReturnType<typeof makeAuth>,
  organizationId: string,
  cookie?: string,
) {
  return auth.handler(
    new Request("http://localhost/api/auth/organization/delete", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({ organizationId }),
    }),
  );
}

describe("native organization deletion disabled (cinatra#1936)", () => {
  it("in-process auth.api.deleteOrganization refuses and the org row survives", async () => {
    const db = makeDb();
    const auth = makeAuth(db, { disableOrganizationDeletion: true });
    const { userId, cookie } = await seedOwnerWithSession(auth);
    const organizationId = await seedOrg(auth, userId);

    await expect(
      auth.api.deleteOrganization({
        body: { organizationId },
        headers: new Headers({ cookie }),
      }),
    ).rejects.toMatchObject({
      body: { code: "ORGANIZATION_DELETION_DISABLED" },
    });

    const orgs = (db.organization ?? []) as OrgRow[];
    expect(orgs.some((o) => o.id === organizationId)).toBe(true);
  });

  it("raw HTTP POST /organization/delete refuses with 404 and the org row survives", async () => {
    const db = makeDb();
    const auth = makeAuth(db, { disableOrganizationDeletion: true });
    const { userId, cookie } = await seedOwnerWithSession(auth);
    const organizationId = await seedOrg(auth, userId);

    const res = await httpDelete(auth, organizationId, cookie);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("ORGANIZATION_DELETION_DISABLED");

    const orgs = (db.organization ?? []) as OrgRow[];
    expect(orgs.some((o) => o.id === organizationId)).toBe(true);
  });

  it("refusal precedes the session lookup: an unauthenticated POST gets the SAME 404 (not 401)", async () => {
    const db = makeDb();
    const auth = makeAuth(db, { disableOrganizationDeletion: true });
    const { userId } = await seedOwnerWithSession(auth);
    const organizationId = await seedOrg(auth, userId);

    const res = await httpDelete(auth, organizationId);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("ORGANIZATION_DELETION_DISABLED");
  });

  it("CONTROL: without the option the same owner+session flow deletes successfully", async () => {
    // Proves the refusals above come from `disableOrganizationDeletion`, not
    // from a harness artifact (bad cookie, missing membership, wrong route).
    const db = makeDb();
    const auth = makeAuth(db, {});
    const { userId, cookie } = await seedOwnerWithSession(auth);
    const organizationId = await seedOrg(auth, userId);

    const res = await httpDelete(auth, organizationId, cookie);
    expect(res.status).toBe(200);

    const orgs = (db.organization ?? []) as OrgRow[];
    expect(orgs.some((o) => o.id === organizationId)).toBe(false);
  });

  it("CONTROL: an explicit `false` reaches upstream (deletion works — the value is not dropped)", async () => {
    // Pins the `!== undefined` threading in buildCinatraOrganizationPlugin: a
    // truthiness-conditional spread would drop `false` too — indistinguishable
    // from the omitted-option control ABOVE, but this pin plus that control
    // together fail if threading ever flips to `?? true` (default-on) or the
    // option is hardcoded inside the factory.
    const db = makeDb();
    const auth = makeAuth(db, { disableOrganizationDeletion: false });
    const { userId, cookie } = await seedOwnerWithSession(auth);
    const organizationId = await seedOrg(auth, userId);

    const res = await httpDelete(auth, organizationId, cookie);
    expect(res.status).toBe(200);

    const orgs = (db.organization ?? []) as OrgRow[];
    expect(orgs.some((o) => o.id === organizationId)).toBe(false);
  });
});
