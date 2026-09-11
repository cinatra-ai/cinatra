/**
 * The registration answer given on the first-account step is HELD in the
 * operator's own browser and only reaches the instance with the first admin's
 * session.
 *
 * Why it works that way: the first-account step is reachable by anyone who can
 * reach a brand-new instance, so an answer written straight to the instance
 * there would let a passer-by open registration on somebody else's instance and
 * walk away. These arms pin that a held answer is applied ONLY for a platform
 * admin, only while the instance carries no answer of its own, and never at all
 * when anything cannot be read.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const cookieStore = new Map<string, string>();
const cookieSet = vi.fn((name: string, value: string, options?: unknown) => {
  void options;
  cookieStore.set(name, value);
});
const cookieDelete = vi.fn((name: string) => {
  cookieStore.delete(name);
});
let cookiesThrow = false;

vi.mock("next/headers", () => ({
  cookies: async () => {
    if (cookiesThrow) throw new Error("outside a request");
    return {
      get: (name: string) =>
        cookieStore.has(name) ? { name, value: cookieStore.get(name) as string } : undefined,
      set: (name: string, value: string, options?: unknown) => cookieSet(name, value, options),
      delete: (name: string) => cookieDelete(name),
    };
  },
}));

const setRegistrationClosed = vi.fn(async (closed: boolean) => {
  void closed;
});
vi.mock("@/lib/authz/instance-mode", () => ({
  setRegistrationClosed: (closed: boolean) => setRegistrationClosed(closed),
}));

const readConnectorConfigFromDatabase = vi.fn();
vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: (...args: unknown[]) => readConnectorConfigFromDatabase(...args),
}));

const ADMIN = { user: { id: "u1", role: "user,admin" } };
const MEMBER = { user: { id: "u2", role: "user" } };

beforeEach(() => {
  vi.clearAllMocks();
  cookieStore.clear();
  cookiesThrow = false;
  readConnectorConfigFromDatabase.mockReturnValue(null);
});

async function lib() {
  return await import("../bootstrap-registration-choice");
}

describe("holding the answer", () => {
  it("keeps it out of reach of scripts and other sites", async () => {
    const { writeBootstrapRegistrationChoice, BOOTSTRAP_REGISTRATION_CHOICE_COOKIE } = await lib();
    await writeBootstrapRegistrationChoice("open");
    expect(cookieSet).toHaveBeenCalledWith(
      BOOTSTRAP_REGISTRATION_CHOICE_COOKIE,
      "open",
      expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/" }),
    );
  });

  it("reads back only the two answers it knows, and nothing when it cannot read at all", async () => {
    const { readBootstrapRegistrationChoice, BOOTSTRAP_REGISTRATION_CHOICE_COOKIE } = await lib();
    cookieStore.set(BOOTSTRAP_REGISTRATION_CHOICE_COOKIE, "open");
    expect(await readBootstrapRegistrationChoice()).toBe("open");
    cookieStore.set(BOOTSTRAP_REGISTRATION_CHOICE_COOKIE, "closed");
    expect(await readBootstrapRegistrationChoice()).toBe("closed");
    cookieStore.set(BOOTSTRAP_REGISTRATION_CHOICE_COOKIE, "yes please");
    expect(await readBootstrapRegistrationChoice()).toBeNull();
    cookiesThrow = true;
    expect(await readBootstrapRegistrationChoice()).toBeNull();
  });
});

describe("applying the held answer", () => {
  it("opens the instance for the admin whose browser gave the answer", async () => {
    const { applyPendingBootstrapRegistrationChoice, BOOTSTRAP_REGISTRATION_CHOICE_COOKIE } =
      await lib();
    cookieStore.set(BOOTSTRAP_REGISTRATION_CHOICE_COOKIE, "open");
    expect(await applyPendingBootstrapRegistrationChoice(ADMIN)).toBe(true);
    expect(setRegistrationClosed).toHaveBeenCalledWith(false);
    expect(cookieDelete).toHaveBeenCalledWith(BOOTSTRAP_REGISTRATION_CHOICE_COOKIE);
  });

  it("records the closed answer explicitly when that is what was said", async () => {
    const { applyPendingBootstrapRegistrationChoice, BOOTSTRAP_REGISTRATION_CHOICE_COOKIE } =
      await lib();
    cookieStore.set(BOOTSTRAP_REGISTRATION_CHOICE_COOKIE, "closed");
    expect(await applyPendingBootstrapRegistrationChoice(ADMIN)).toBe(true);
    expect(setRegistrationClosed).toHaveBeenCalledWith(true);
  });

  it("SECURITY: a visitor who never becomes an admin cannot open the instance", async () => {
    const { applyPendingBootstrapRegistrationChoice, BOOTSTRAP_REGISTRATION_CHOICE_COOKIE } =
      await lib();
    cookieStore.set(BOOTSTRAP_REGISTRATION_CHOICE_COOKIE, "open");
    expect(await applyPendingBootstrapRegistrationChoice(MEMBER)).toBe(false);
    expect(await applyPendingBootstrapRegistrationChoice(null)).toBe(false);
    expect(setRegistrationClosed).not.toHaveBeenCalled();
  });

  it("SECURITY: an answer the instance has since made its own is never overwritten", async () => {
    const { applyPendingBootstrapRegistrationChoice, BOOTSTRAP_REGISTRATION_CHOICE_COOKIE } =
      await lib();
    cookieStore.set(BOOTSTRAP_REGISTRATION_CHOICE_COOKIE, "open");
    readConnectorConfigFromDatabase.mockReturnValue({ closedRegistration: true });
    expect(await applyPendingBootstrapRegistrationChoice(ADMIN)).toBe(false);
    expect(setRegistrationClosed).not.toHaveBeenCalled();
  });

  it("does nothing when no answer is held", async () => {
    const { applyPendingBootstrapRegistrationChoice } = await lib();
    expect(await applyPendingBootstrapRegistrationChoice(ADMIN)).toBe(false);
    expect(setRegistrationClosed).not.toHaveBeenCalled();
  });

  it("FAIL SAFE: a settings read that fails leaves the instance closed and never throws", async () => {
    const { applyPendingBootstrapRegistrationChoice, BOOTSTRAP_REGISTRATION_CHOICE_COOKIE } =
      await lib();
    cookieStore.set(BOOTSTRAP_REGISTRATION_CHOICE_COOKIE, "open");
    readConnectorConfigFromDatabase.mockImplementation(() => {
      throw new Error("db unavailable");
    });
    expect(await applyPendingBootstrapRegistrationChoice(ADMIN)).toBe(false);
    expect(setRegistrationClosed).not.toHaveBeenCalled();
  });

  it("keeps an instance with other settings but no answer of its own eligible", async () => {
    const { applyPendingBootstrapRegistrationChoice, BOOTSTRAP_REGISTRATION_CHOICE_COOKIE } =
      await lib();
    cookieStore.set(BOOTSTRAP_REGISTRATION_CHOICE_COOKIE, "open");
    readConnectorConfigFromDatabase.mockReturnValue({ singleOrg: true });
    expect(await applyPendingBootstrapRegistrationChoice(ADMIN)).toBe(true);
    expect(setRegistrationClosed).toHaveBeenCalledWith(false);
  });
});
