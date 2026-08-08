/**
 * cinatra#2544 — the shell's reconciliation source must answer with the SAME
 * tri-state gate the root layout evaluates.
 *
 * AppShell no longer redirects off `connectionReady` (a root-layout snapshot
 * that client navigation never refreshes). It asks this route instead. That
 * makes two properties load-bearing, and each has an opposite failure mode:
 *
 *   1. It reports `evaluateSetupGate()` — the same derivation the layout runs —
 *      so the client and the layout can never re-create the split-brain #2503
 *      closed. Reporting `isSetupWizardComplete()` instead would reintroduce a
 *      second, independently-failing gate.
 *   2. It NEVER spells a failed read "incomplete". A 500 (what the old handler
 *      produced, because `isSetupWizardComplete()` propagates) is
 *      indistinguishable from a network failure at the client, and the client
 *      must be able to tell "not set up" from "could not find out" — the whole
 *      point of the fix.
 *
 * The sessionless branch is pinned as UNCHANGED: it discloses no gate at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: (args: unknown) => getSession(args) } },
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

const evaluateSetupGate = vi.fn();
vi.mock("@/lib/setup-wizard", () => ({
  evaluateSetupGate: () => evaluateSetupGate(),
}));

type Body = {
  authenticated: boolean;
  setupComplete: boolean;
  setupGate?: string;
};

async function callRoute(): Promise<Body> {
  const { GET } = await import("../route");
  const res = await GET();
  return (await res.json()) as Body;
}

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ user: { id: "u1" } });
});

afterEach(() => {
  vi.resetModules();
});

describe("authenticated — the tri-state gate", () => {
  it("reports complete, and the legacy boolean agrees", async () => {
    evaluateSetupGate.mockResolvedValue("complete");
    await expect(callRoute()).resolves.toEqual({
      authenticated: true,
      setupComplete: true,
      setupGate: "complete",
    });
  });

  it("reports a determinate incomplete", async () => {
    evaluateSetupGate.mockResolvedValue("incomplete");
    await expect(callRoute()).resolves.toEqual({
      authenticated: true,
      setupComplete: false,
      setupGate: "incomplete",
    });
  });

  it("reports INDETERMINATE as itself — never as incomplete", async () => {
    // The client redirects on `incomplete` and refuses to on anything else, so
    // this single field is what stops a backend blip from bouncing a working
    // instance into the wizard.
    evaluateSetupGate.mockResolvedValue("indeterminate");
    const body = await callRoute();
    expect(body.setupGate).toBe("indeterminate");
    expect(body.setupGate).not.toBe("incomplete");
    // The legacy boolean stays honest in its own terms: "not confirmed
    // complete". A caller that needs the distinction reads setupGate.
    expect(body.setupComplete).toBe(false);
  });

  it("answers 200 instead of throwing when the gate cannot be read", async () => {
    // The old handler called isSetupWizardComplete(), which PROPAGATES a read
    // failure — a 500 the client cannot distinguish from its own network being
    // down, so both collapsed into the same "assume not set up" guess.
    evaluateSetupGate.mockResolvedValue("indeterminate");
    const { GET } = await import("../route");
    const res = await GET();
    expect(res.status).toBe(200);
  });

  it("routes through evaluateSetupGate, the gate the root layout also reads", async () => {
    evaluateSetupGate.mockResolvedValue("complete");
    await callRoute();
    expect(evaluateSetupGate).toHaveBeenCalledTimes(1);
  });
});

describe("sessionless — unchanged, and deliberately silent", () => {
  it("discloses no gate to an anonymous caller", async () => {
    getSession.mockResolvedValue(null);
    const body = await callRoute();
    expect(body).toEqual({ authenticated: false, setupComplete: false });
    expect(body.setupGate).toBeUndefined();
  });

  it("does not even evaluate the gate without a session", async () => {
    getSession.mockResolvedValue(null);
    await callRoute();
    expect(evaluateSetupGate).not.toHaveBeenCalled();
  });
});
