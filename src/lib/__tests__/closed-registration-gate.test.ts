/**
 * Closed-registration gate decision authority (D1–D5).
 *
 * Two layers, both exercised here:
 *   - the pure `decideRegistration` predicate (branch authority), and
 *   - the PRODUCTION orchestrator `resolveRegistrationDecision` — the EXACT
 *     function the `user.create.before` hook in auth.ts calls. The orchestrator
 *     tests inject `isClosed` / `countHumans` deps, so they cover the real
 *     production decision path (including the count-read FAILURE → FAIL CLOSED
 *     path, D4), not a reconstruction. auth.ts itself is never loaded here (top-
 *     level await + heavy plugin graph); it only adds the APIError throw on a
 *     "block" decision, which is contract-tested in closed-registration-api-error.
 */
import { describe, expect, it, vi } from "vitest";
import {
  decideRegistration,
  resolveRegistrationDecision,
  isHumanUserType,
  isAdminCreateContext,
  ADMIN_CREATE_USER_PATH,
  REGISTRATION_CLOSED_CODE,
} from "../closed-registration-gate";

describe("isHumanUserType (D3)", () => {
  it("treats only explicit 'assistant' as non-human", () => {
    expect(isHumanUserType("assistant")).toBe(false);
    expect(isHumanUserType("human")).toBe(true);
    expect(isHumanUserType(undefined)).toBe(true); // omitted → schema default human
    expect(isHumanUserType(null)).toBe(true);
    expect(isHumanUserType("")).toBe(true);
  });
});

describe("isAdminCreateContext (D1)", () => {
  it("matches the admin create-user endpoint path only", () => {
    expect(isAdminCreateContext("/admin/create-user")).toBe(true);
    expect(ADMIN_CREATE_USER_PATH).toBe("/admin/create-user");
  });
  it("does NOT match public sign-up / OAuth callback / null", () => {
    expect(isAdminCreateContext("/sign-up/email")).toBe(false);
    expect(isAdminCreateContext("/callback/:id")).toBe(false);
    expect(isAdminCreateContext("/callback/google")).toBe(false);
    expect(isAdminCreateContext(null)).toBe(false);
    expect(isAdminCreateContext(undefined)).toBe(false);
  });
});

describe("decideRegistration", () => {
  it("ALLOWS an assistant creation regardless of flag/count (D3)", () => {
    expect(
      decideRegistration({ userType: "assistant", path: "/sign-up/email", closed: true, humanCount: 5 }),
    ).toBe("allow");
  });

  it("ALLOWS admin-context creation even when closed + humans exist (D1)", () => {
    expect(
      decideRegistration({ userType: "human", path: ADMIN_CREATE_USER_PATH, closed: true, humanCount: 3 }),
    ).toBe("allow");
  });

  it("ALLOWS public email sign-up when registration is OPEN (D5)", () => {
    expect(
      decideRegistration({ userType: "human", path: "/sign-up/email", closed: false, humanCount: 10 }),
    ).toBe("allow");
  });

  it("ALLOWS the first human when zero humans exist, even if flag closed (D4 bootstrap)", () => {
    expect(
      decideRegistration({ userType: "human", path: "/sign-up/email", closed: true, humanCount: 0 }),
    ).toBe("allow");
  });

  it("BLOCKS public email sign-up when closed + >=1 human (D1/D2)", () => {
    expect(
      decideRegistration({ userType: "human", path: "/sign-up/email", closed: true, humanCount: 1 }),
    ).toBe("block");
  });

  it("BLOCKS OAuth first-login (callback path) when closed + >=1 human (D1)", () => {
    expect(
      decideRegistration({ userType: "human", path: "/callback/google", closed: true, humanCount: 2 }),
    ).toBe("block");
  });

  it("BLOCKS a null-ctx (no endpoint) public creation when closed + humans (D1 null→public)", () => {
    expect(
      decideRegistration({ userType: "human", path: null, closed: true, humanCount: 1 }),
    ).toBe("block");
  });
});

describe("APIError code constant (D2)", () => {
  it("exposes the stable REGISTRATION_CLOSED code", () => {
    expect(REGISTRATION_CLOSED_CODE).toBe("REGISTRATION_CLOSED");
  });
});

describe("resolveRegistrationDecision — PRODUCTION orchestrator (the path auth.ts calls)", () => {
  // Helpers to build injected deps and assert call counts (proves short-circuit
  // ordering: the count is only read when closed + public + human).
  const isClosed = (v: boolean) => vi.fn(async () => v);
  const countHumans = (v: number) => vi.fn(async () => v);
  const countThrows = () =>
    vi.fn(async () => {
      throw new Error("db unavailable");
    });

  it("assistant userType → allow (and never reads the toggle or count) — D3", async () => {
    const closed = isClosed(true);
    const count = countHumans(5);
    const decision = await resolveRegistrationDecision({
      user: { userType: "assistant" },
      ctx: { path: "/sign-up/email" },
      isClosed: closed,
      countHumans: count,
    });
    expect(decision).toBe("allow");
    expect(closed).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it("open (isClosed=false) → allow (and never reads the count) — D5", async () => {
    const count = countHumans(10);
    const decision = await resolveRegistrationDecision({
      user: { userType: "human" },
      ctx: { path: "/sign-up/email" },
      isClosed: isClosed(false),
      countHumans: count,
    });
    expect(decision).toBe("allow");
    expect(count).not.toHaveBeenCalled();
  });

  it("closed + admin ctx.path '/admin/create-user' → allow (count not read) — D1", async () => {
    const closed = isClosed(true);
    const count = countHumans(3);
    const decision = await resolveRegistrationDecision({
      user: { userType: "human" },
      ctx: { path: ADMIN_CREATE_USER_PATH },
      isClosed: closed,
      countHumans: count,
    });
    expect(decision).toBe("allow");
    // Admin short-circuits BEFORE the toggle/count are read.
    expect(closed).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it("closed + public '/sign-up/email' + countHumans=0 → allow (first-human bootstrap) — D4", async () => {
    const decision = await resolveRegistrationDecision({
      user: { userType: "human" },
      ctx: { path: "/sign-up/email" },
      isClosed: isClosed(true),
      countHumans: countHumans(0),
    });
    expect(decision).toBe("allow");
  });

  it("closed + public '/sign-up/email' + countHumans=1 → BLOCK — D1/D2", async () => {
    const decision = await resolveRegistrationDecision({
      user: { userType: "human" },
      ctx: { path: "/sign-up/email" },
      isClosed: isClosed(true),
      countHumans: countHumans(1),
    });
    expect(decision).toBe("block");
  });

  it("closed + null ctx + countHumans>=1 → BLOCK (null ctx is treated as public) — D1", async () => {
    const decision = await resolveRegistrationDecision({
      user: { userType: "human" },
      ctx: null,
      isClosed: isClosed(true),
      countHumans: countHumans(2),
    });
    expect(decision).toBe("block");
  });

  it("closed + countHumans throws → BLOCK (fail-closed) — D4", async () => {
    const decision = await resolveRegistrationDecision({
      user: { userType: "human" },
      ctx: { path: "/sign-up/email" },
      isClosed: isClosed(true),
      countHumans: countThrows(),
    });
    expect(decision).toBe("block");
  });

  it("closed + OAuth callback path + countHumans>=1 → BLOCK (covers social first-login) — D1", async () => {
    const decision = await resolveRegistrationDecision({
      user: { userType: "human" },
      ctx: { path: "/callback/google" },
      isClosed: isClosed(true),
      countHumans: countHumans(4),
    });
    expect(decision).toBe("block");
  });
});
