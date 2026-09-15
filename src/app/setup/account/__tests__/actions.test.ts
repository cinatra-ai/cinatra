/**
 * The first-account step records the operator's registration choice.
 *
 * Registration is closed on a brand-new instance. The first-account step is
 * where the person setting the instance up says whether anyone else may create
 * an account, and this action is what takes that answer.
 *
 * Two windows, both covered here:
 *   - the bootstrap window (no human account exists yet): nobody can prove they
 *     are this instance's operator, because the step is reachable by anyone who
 *     can reach the instance. The answer is HELD in the caller's own browser
 *     and NOTHING is written to the instance — it is applied later, with the
 *     admin account this step creates.
 *   - after the bootstrap window (a human account exists): the write is
 *     admin-only and immediate, exactly like the access-control screen's own
 *     toggle.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ hasAnyBetterAuthUsers: vi.fn() }));
vi.mock("@/lib/auth-session", () => ({ requireAdminSession: vi.fn() }));
vi.mock("@/lib/authz/instance-mode", () => ({ setRegistrationClosed: vi.fn() }));
vi.mock("@/lib/bootstrap-registration-choice", () => ({
  writeBootstrapRegistrationChoice: vi.fn(),
  clearBootstrapRegistrationChoice: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

async function mocks() {
  const { hasAnyBetterAuthUsers } = await import("@/lib/auth");
  const { requireAdminSession } = await import("@/lib/auth-session");
  const { setRegistrationClosed } = await import("@/lib/authz/instance-mode");
  const { writeBootstrapRegistrationChoice, clearBootstrapRegistrationChoice } = await import(
    "@/lib/bootstrap-registration-choice"
  );
  return {
    hasAnyBetterAuthUsers: hasAnyBetterAuthUsers as unknown as ReturnType<typeof vi.fn>,
    requireAdminSession: requireAdminSession as unknown as ReturnType<typeof vi.fn>,
    setRegistrationClosed: setRegistrationClosed as unknown as ReturnType<typeof vi.fn>,
    hold: writeBootstrapRegistrationChoice as unknown as ReturnType<typeof vi.fn>,
    clearHeld: clearBootstrapRegistrationChoice as unknown as ReturnType<typeof vi.fn>,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("recordBootstrapRegistrationChoiceAction — bootstrap window (no account yet)", () => {
  it("holds CLOSED when the operator does not opt in, and writes nothing to the instance", async () => {
    const m = await mocks();
    m.hasAnyBetterAuthUsers.mockResolvedValue(false);
    const { recordBootstrapRegistrationChoiceAction } = await import("../actions");
    await recordBootstrapRegistrationChoiceAction(false);
    expect(m.hold).toHaveBeenCalledWith("closed");
    expect(m.setRegistrationClosed).not.toHaveBeenCalled();
    expect(m.requireAdminSession).not.toHaveBeenCalled();
  });

  it("SECURITY: opting in holds the answer in the caller's own browser — it never opens the instance on its own", async () => {
    const m = await mocks();
    m.hasAnyBetterAuthUsers.mockResolvedValue(false);
    const { recordBootstrapRegistrationChoiceAction } = await import("../actions");
    await recordBootstrapRegistrationChoiceAction(true);
    expect(m.hold).toHaveBeenCalledWith("open");
    // A passer-by on a brand-new instance must not be able to leave an open
    // door behind for the operator who arrives after them.
    expect(m.setRegistrationClosed).not.toHaveBeenCalled();
  });

  it("coerces a non-boolean answer to CLOSED rather than trusting it", async () => {
    const m = await mocks();
    m.hasAnyBetterAuthUsers.mockResolvedValue(false);
    const { recordBootstrapRegistrationChoiceAction } = await import("../actions");
    await recordBootstrapRegistrationChoiceAction("true" as unknown as boolean);
    expect(m.hold).toHaveBeenCalledWith("closed");
    expect(m.setRegistrationClosed).not.toHaveBeenCalled();
  });
});

describe("recordBootstrapRegistrationChoiceAction — after the bootstrap window", () => {
  it("SECURITY: a caller without an admin session cannot open registration once an account exists", async () => {
    const m = await mocks();
    m.hasAnyBetterAuthUsers.mockResolvedValue(true);
    m.requireAdminSession.mockRejectedValue(new Error("not an admin"));
    const { recordBootstrapRegistrationChoiceAction } = await import("../actions");
    await expect(recordBootstrapRegistrationChoiceAction(true)).rejects.toThrow("not an admin");
    expect(m.setRegistrationClosed).not.toHaveBeenCalled();
    expect(m.hold).not.toHaveBeenCalled();
  });

  it("an admin may still record the choice, and a held answer can no longer overwrite it", async () => {
    const m = await mocks();
    m.hasAnyBetterAuthUsers.mockResolvedValue(true);
    m.requireAdminSession.mockResolvedValue({ user: { id: "admin-1" } });
    const { recordBootstrapRegistrationChoiceAction } = await import("../actions");
    await recordBootstrapRegistrationChoiceAction(true);
    expect(m.requireAdminSession).toHaveBeenCalled();
    expect(m.setRegistrationClosed).toHaveBeenCalledWith(false);
    expect(m.clearHeld).toHaveBeenCalled();
  });
});

describe("the account-existence probe cannot be used to skip the check", () => {
  it("a failing probe is treated as 'an account exists' and demands an admin session", async () => {
    const m = await mocks();
    m.hasAnyBetterAuthUsers.mockRejectedValue(new Error("db unavailable"));
    m.requireAdminSession.mockRejectedValue(new Error("not an admin"));
    const { recordBootstrapRegistrationChoiceAction } = await import("../actions");
    await expect(recordBootstrapRegistrationChoiceAction(true)).rejects.toThrow("not an admin");
    expect(m.setRegistrationClosed).not.toHaveBeenCalled();
    expect(m.hold).not.toHaveBeenCalled();
  });
});
