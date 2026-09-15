/**
 * The design-conformance seed route performs REAL extension-lifecycle writes
 * (install / lock / archive / force-delete of `installed_extension` rows) under
 * a synthetic platform-admin actor, and it is deliberately exempt from the
 * sign-in redirect so the sessionless CI harness can reach it. Its ONLY
 * authorization boundary is therefore the presented capability, and this file
 * is the proof that the boundary holds BEFORE any write can happen.
 *
 * Every refusal arm asserts TWO things, not one:
 *   - the answer is 404 (indistinguishable from "no such route"), and
 *   - the canonical store was NEVER touched — no list, no install, no
 *     transition — because a fence that refuses the caller after writing is
 *     not a fence.
 *
 * The store modules are mocked at their package specifiers, so a refusal path
 * that DID reach them would light up as a called spy rather than as a database
 * error that could be mistaken for an unrelated environment problem. Each
 * refusal is paired with the SAME request one variable away from passing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const store = vi.hoisted(() => ({
  listInstalledExtensions: vi.fn(),
  installExtensionManifest: vi.fn(),
  transitionExtensionLifecycle: vi.fn(),
}));

vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  listInstalledExtensions: store.listInstalledExtensions,
}));
vi.mock("@cinatra-ai/extensions/lifecycle-primitive", () => ({
  installExtensionManifest: store.installExtensionManifest,
  transitionExtensionLifecycle: store.transitionExtensionLifecycle,
}));

import { CONFORMANCE_SEED_CAPABILITY_ENV } from "@/lib/test-support/conformance-seed-fence";
import { SEEDED_INSTALLED_EXTENSIONS } from "../../seed-data";
import { DELETE, POST } from "../route";

const CAPABILITY = "conformance-seed-capability-with-enough-entropy-0123456789";
const RUN_ID = "vitest-fence";

/**
 * A request shaped exactly as the handlers read it. `json` is a spy so a
 * refusal can be proven to have happened BEFORE the body was even read — the
 * store is loaded strictly after the body parse, so an unread body is an
 * independent witness that no write path was entered.
 */
function seedRequest(
  headers: Record<string, string>,
  body: unknown = { runId: RUN_ID },
) {
  const lower = new Map(
    Object.entries({ "content-type": "application/json", ...headers }).map(([k, v]) => [
      k.toLowerCase(),
      v,
    ]),
  );
  const json = vi.fn(async () => body);
  const req = {
    url: "http://127.0.0.1:3101/design-fixtures/conformance/seed",
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    json,
  } as unknown as NextRequest;
  return { req, json };
}

const PRESENTED = { authorization: `Bearer ${CAPABILITY}` };

function expectNoStoreContact() {
  expect(store.listInstalledExtensions).not.toHaveBeenCalled();
  expect(store.installExtensionManifest).not.toHaveBeenCalled();
  expect(store.transitionExtensionLifecycle).not.toHaveBeenCalled();
}

let armed: string | undefined;

beforeEach(() => {
  armed = process.env[CONFORMANCE_SEED_CAPABILITY_ENV];
  store.listInstalledExtensions.mockReset().mockResolvedValue([]);
  store.installExtensionManifest.mockReset().mockResolvedValue(undefined);
  store.transitionExtensionLifecycle.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  if (armed === undefined) delete process.env[CONFORMANCE_SEED_CAPABILITY_ENV];
  else process.env[CONFORMANCE_SEED_CAPABILITY_ENV] = armed;
});

describe("no capability armed — the default of every stack", () => {
  beforeEach(() => {
    delete process.env[CONFORMANCE_SEED_CAPABILITY_ENV];
  });

  it("POST answers 404 and performs no write", async () => {
    const { req, json } = seedRequest({});
    const res = await POST(req);
    expect(res.status).toBe(404);
    expect(json).not.toHaveBeenCalled();
    expectNoStoreContact();
  });

  it("DELETE answers 404 and performs no write", async () => {
    const { req, json } = seedRequest({});
    const res = await DELETE(req);
    expect(res.status).toBe(404);
    expect(json).not.toHaveBeenCalled();
    expectNoStoreContact();
  });

  it("POST still answers 404 when a caller presents a token anyway", async () => {
    const { req } = seedRequest(PRESENTED);
    expect((await POST(req)).status).toBe(404);
    expectNoStoreContact();
  });
});

describe("armed, but the capability is not presented", () => {
  beforeEach(() => {
    process.env[CONFORMANCE_SEED_CAPABILITY_ENV] = CAPABILITY;
  });

  it("POST with NO authorization header answers 404 and performs no write", async () => {
    const { req, json } = seedRequest({});
    const res = await POST(req);
    expect(res.status).toBe(404);
    expect(json).not.toHaveBeenCalled();
    expectNoStoreContact();
  });

  it("POST with a WRONG token answers 404 and performs no write", async () => {
    const { req, json } = seedRequest({ authorization: "Bearer conformance-seed-not-the-real-capability-0000" });
    const res = await POST(req);
    expect(res.status).toBe(404);
    expect(json).not.toHaveBeenCalled();
    expectNoStoreContact();
  });

  it("DELETE with a WRONG token answers 404 and destroys nothing", async () => {
    const { req } = seedRequest({ authorization: "Bearer conformance-seed-not-the-real-capability-0000" });
    const res = await DELETE(req);
    expect(res.status).toBe(404);
    expectNoStoreContact();
  });

  it("POST from a REMOTE forwarded hop answers 404 even WITH the right token", async () => {
    const { req, json } = seedRequest({ ...PRESENTED, "x-forwarded-for": "203.0.113.7" });
    const res = await POST(req);
    expect(res.status).toBe(404);
    expect(json).not.toHaveBeenCalled();
    expectNoStoreContact();
  });

  it("DELETE from a REMOTE forwarded hop answers 404 even WITH the right token", async () => {
    const { req } = seedRequest({ ...PRESENTED, "x-forwarded-for": "203.0.113.7" });
    expect((await DELETE(req)).status).toBe(404);
    expectNoStoreContact();
  });
});

describe("POSITIVE CONTROLS — the presented capability preserves today's behaviour", () => {
  beforeEach(() => {
    process.env[CONFORMANCE_SEED_CAPABILITY_ENV] = CAPABILITY;
  });

  it("POST converges the namespace to the committed kit exactly as before", async () => {
    const { req } = seedRequest(PRESENTED);
    const res = await POST(req);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      runId: RUN_ID,
      installed: SEEDED_INSTALLED_EXTENSIONS.length,
      removed: 0,
      transitioned: 0,
      total: SEEDED_INSTALLED_EXTENSIONS.length,
    });
    expect(store.installExtensionManifest).toHaveBeenCalledTimes(
      SEEDED_INSTALLED_EXTENSIONS.length,
    );
  });

  it("POST still passes through a loopback forwarded chain (Next synthesises one)", async () => {
    const { req } = seedRequest({ ...PRESENTED, "x-forwarded-for": "127.0.0.1" });
    expect((await POST(req)).status).toBe(200);
    expect(store.installExtensionManifest).toHaveBeenCalled();
  });

  it("DELETE cleans the namespace exactly as before", async () => {
    const { req } = seedRequest(PRESENTED);
    const res = await DELETE(req);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ runId: RUN_ID, removed: 0 });
    expect(store.listInstalledExtensions).toHaveBeenCalled();
  });
});

describe("the namespace/runId validation is unchanged", () => {
  beforeEach(() => {
    process.env[CONFORMANCE_SEED_CAPABILITY_ENV] = CAPABILITY;
  });

  it("a presented capability with a MALFORMED runId still answers 400, not 404", async () => {
    const { req, json } = seedRequest(PRESENTED, { runId: "Not A Valid Run Id" });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(json).toHaveBeenCalled();
    expectNoStoreContact();
  });

  it("DELETE with a malformed runId still answers 400, not 404", async () => {
    const { req } = seedRequest(PRESENTED, { runId: "" });
    expect((await DELETE(req)).status).toBe(400);
    expectNoStoreContact();
  });
});
