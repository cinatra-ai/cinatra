/**
 * THE ONE SETUP STEP THAT STILL NEEDED A BROWSER, AND THE FIVE THINGS THAT
 * MAKE IT SAFE TO DO WITHOUT ONE.
 *
 *   1. It refuses unless the instance SAYS it is a development one — the
 *      strict gate, not the shared one its four siblings use, and before it
 *      reads anything at all. The shared gate refuses any declared mode that is
 *      not `development`; the strict gate adds that the mode be declared.
 *   2. The account is created through the PRODUCT'S OWN server-side sign-up and
 *      promoted by the PRODUCT'S OWN first-user one-shot. This leg writes no
 *      row, hashes nothing, and sets no role: a source claim, because that is a
 *      claim about the shape of the code, and doubles cannot make it.
 *   3. The session that sign-up mints is ENDED. The library signs the new
 *      account in unconditionally; a command has no browser to hold that
 *      session, so leaving it alive would leave a live administrator session
 *      behind that nobody holds.
 *   4. A seat that is already taken is a NORMAL outcome: nothing written,
 *      nothing called, and nothing said about which addresses exist.
 *   5. The password never reaches an outcome, a notice, a message or a cause —
 *      including when the refusal that comes back from the endpoint quotes it.
 *
 * The doubles here are the ones the siblings use: the members that leave this
 * module are injected, and nothing else is faked. There is no database harness
 * — the real-database tier is where row claims belong.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AdministratorPasswordRefusedError,
  provisionFirstAdministrator,
  type ProvisionFirstAdministratorDeps,
} from "@/lib/dev-instance-provisioning/provision-first-administrator";
import {
  DeclaredDevelopmentRuntimeRequiredError,
  DevelopmentRuntimeRefusedError,
} from "@/lib/dev-instance-provisioning/runtime-gate";

const RUNTIME_ENV_KEYS = ["CINATRA_RUNTIME_MODE", "APP_RUNTIME_MODE"] as const;

function declareRuntime(value?: string) {
  for (const key of RUNTIME_ENV_KEYS) delete process.env[key];
  if (value !== undefined) process.env.CINATRA_RUNTIME_MODE = value;
}

afterEach(() => {
  for (const key of RUNTIME_ENV_KEYS) delete process.env[key];
});

// Synthetic values. Not credentials, and never treated as any.
const PASSWORD = "synthetic-administrator-password-5f21";
const EMAIL = "operator@example.test";
const TOKEN = "synthetic-session-token-a77c";

type Recorder = {
  calls: string[];
  deps: ProvisionFirstAdministratorDeps;
  signUpBodies: Array<{ email: string; password: string; name: string }>;
  promoted: string[];
  revoked: Array<{ token: string; headers: Headers | null | undefined }>;
};

/** Every member that leaves the module, recorded in the order it is reached. */
function recorder(options?: {
  hasAnyUsers?: boolean;
  userId?: string | null;
  token?: string | null;
  promoted?: boolean;
  signUpThrows?: unknown;
  promoteThrows?: unknown;
  revokeThrows?: unknown;
  setCookie?: string | null;
  minimumPasswordLength?: number;
  maximumPasswordLength?: number;
}): Recorder {
  const calls: string[] = [];
  const signUpBodies: Array<{ email: string; password: string; name: string }> = [];
  const promoted: string[] = [];
  const revoked: Array<{ token: string; headers: Headers | null | undefined }> = [];
  return {
    calls,
    signUpBodies,
    promoted,
    revoked,
    deps: {
      minimumPasswordLength: options?.minimumPasswordLength ?? 12,
      maximumPasswordLength: options?.maximumPasswordLength ?? 128,
      hasAnyUsers: async () => {
        calls.push("hasAnyUsers");
        return options?.hasAnyUsers ?? false;
      },
      signUpEmail: async (body) => {
        calls.push("signUpEmail");
        signUpBodies.push(body);
        if (options?.signUpThrows !== undefined) throw options.signUpThrows;
        const id = options?.userId === undefined ? "user-1" : options.userId;
        const setCookie =
          options?.setCookie === undefined
            ? "synthetic.session_token=cookie-value; Path=/"
            : options.setCookie;
        return {
          token: options?.token === undefined ? TOKEN : options.token,
          user: id === null ? null : { id },
          headers: setCookie === null ? null : new Headers({ "set-cookie": setCookie }),
        };
      },
      promoteInitialAdministrator: async (userId) => {
        calls.push("promoteInitialAdministrator");
        promoted.push(userId);
        if (options?.promoteThrows !== undefined) throw options.promoteThrows;
        return options?.promoted ?? true;
      },
      revokeSession: async (input) => {
        calls.push("revokeSession");
        revoked.push(input);
        if (options?.revokeThrows !== undefined) throw options.revokeThrows;
      },
    },
  };
}

describe("provisionFirstAdministrator: the strict runtime gate", () => {
  it("refuses outside a development runtime BEFORE it reads anything", async () => {
    declareRuntime("production");
    const r = recorder();

    await expect(
      provisionFirstAdministrator({ email: EMAIL, password: PASSWORD }, r.deps),
    ).rejects.toBeInstanceOf(DevelopmentRuntimeRefusedError);

    // Not "no write" — no READ either. The gate is the first statement, so a
    // production instance never even learns whether it has a user.
    expect(r.calls).toEqual([]);
  });

  it("refuses a runtime the instance declares as something ELSE", async () => {
    // A declared mode that is not `development` is refused under every build,
    // by the shared gate the strict one asks first. Nothing is read either way.
    for (const declared of ["staging", "dev", "developement", "preview", "test"]) {
      declareRuntime(declared);
      const r = recorder();
      await expect(
        provisionFirstAdministrator({ email: EMAIL, password: PASSWORD }, r.deps),
      ).rejects.toBeInstanceOf(DevelopmentRuntimeRefusedError);
      expect(r.calls).toEqual([]);
    }
  });

  it("refuses an UNDECLARED runtime, even under a development build", async () => {
    // The one requirement the strict gate adds to the shared one: the shared
    // gate accepts an undeclared mode here, and seating an administrator asks
    // for a mode the instance actually declared.
    declareRuntime(undefined);
    const r = recorder();
    await expect(
      provisionFirstAdministrator({ email: EMAIL, password: PASSWORD }, r.deps),
    ).rejects.toBeInstanceOf(DeclaredDevelopmentRuntimeRequiredError);
    expect(r.calls).toEqual([]);
  });

  it("accepts the spelling a development instance declares", async () => {
    for (const declared of ["development", " Development ", "DEVELOPMENT"]) {
      declareRuntime(declared);
      const r = recorder();
      const outcome = await provisionFirstAdministrator(
        { email: EMAIL, password: PASSWORD },
        r.deps,
      );
      expect(outcome.written, `"${declared}" must be accepted`).toBe(true);
    }
  });
});

describe("provisionFirstAdministrator: a fresh instance", () => {
  it("creates the account through the product's own sign-up, exactly once", async () => {
    declareRuntime("development");
    const r = recorder();

    const outcome = await provisionFirstAdministrator(
      { email: EMAIL, name: "The Operator", password: PASSWORD },
      r.deps,
    );

    expect(r.signUpBodies).toEqual([
      { email: EMAIL, password: PASSWORD, name: "The Operator" },
    ]);
    expect(outcome).toEqual({
      written: true,
      email: EMAIL,
      alreadySeated: false,
      administrator: true,
    });
  });

  it("reaches the first-user bootstrap with the new account, after the sign-up", async () => {
    declareRuntime("development");
    const r = recorder({ userId: "user-77" });

    await provisionFirstAdministrator({ email: EMAIL, password: PASSWORD }, r.deps);

    expect(r.calls).toEqual([
      "hasAnyUsers",
      "signUpEmail",
      "promoteInitialAdministrator",
      "revokeSession",
    ]);
    expect(r.promoted).toEqual(["user-77"]);
  });

  it("falls back to the address's local part when no display name is given", async () => {
    declareRuntime("development");
    const r = recorder();
    await provisionFirstAdministrator({ email: EMAIL, password: PASSWORD }, r.deps);
    expect(r.signUpBodies[0].name).toBe("operator");
  });

  it("reports a declined promotion instead of claiming an administrator", async () => {
    declareRuntime("development");
    const r = recorder({ promoted: false });
    const outcome = await provisionFirstAdministrator(
      { email: EMAIL, password: PASSWORD },
      r.deps,
    );
    expect(outcome.written).toBe(true);
    expect(outcome.administrator).toBe(false);
  });
});

describe("provisionFirstAdministrator: the session the sign-up mints", () => {
  it("is revoked with the token the sign-up returned, AFTER the promotion", async () => {
    declareRuntime("development");
    const r = recorder();

    await provisionFirstAdministrator({ email: EMAIL, password: PASSWORD }, r.deps);

    expect(r.calls.indexOf("revokeSession")).toBeGreaterThan(
      r.calls.indexOf("promoteInitialAdministrator"),
    );
    expect(r.revoked).toHaveLength(1);
    expect(r.revoked[0].token).toBe(TOKEN);
  });

  it("is revoked on the DECLINED path too — a session nobody holds is the hazard", async () => {
    declareRuntime("development");
    const r = recorder({ promoted: false });

    await provisionFirstAdministrator({ email: EMAIL, password: PASSWORD }, r.deps);

    expect(r.calls).toEqual([
      "hasAnyUsers",
      "signUpEmail",
      "promoteInitialAdministrator",
      "revokeSession",
    ]);
    expect(r.revoked[0].token).toBe(TOKEN);
  });

  it("carries the sign-up's own response headers, so the revoke can present the session", async () => {
    declareRuntime("development");
    const r = recorder();
    await provisionFirstAdministrator({ email: EMAIL, password: PASSWORD }, r.deps);
    expect(r.revoked[0].headers?.get("set-cookie")).toContain("synthetic.session_token=");
  });

  it("never lets the session token reach an outcome", async () => {
    declareRuntime("development");
    const r = recorder();
    const outcome = await provisionFirstAdministrator(
      { email: EMAIL, password: PASSWORD },
      r.deps,
    );
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
  });

  it("fails loudly when the session cannot be ended, without printing the token", async () => {
    declareRuntime("development");
    const hostile = Object.assign(new Error(`refused for ${TOKEN}`), {
      status: 401,
      body: { code: TOKEN },
    });
    const r = recorder({ revokeThrows: hostile });

    let caught: unknown = null;
    try {
      await provisionFirstAdministrator({ email: EMAIL, password: PASSWORD }, r.deps);
    } catch (error) {
      caught = error;
    }

    const error = caught as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/session/i);
    expect(error.message).not.toContain(TOKEN);
    expect(error.cause).toBeUndefined();
  });
});

describe("provisionFirstAdministrator: the promotion itself fails", () => {
  // The bootstrap writes the role, the default organization, the membership and
  // the sessions' organization in turn, AFTER its own guards. A throw part-way
  // leaves a state this leg cannot read back — and, before this, left the
  // session alive as well, which is the one hazard the revoke exists for.
  const PROMOTION_FAILURE = Object.assign(new Error(`bootstrap blew up on ${PASSWORD}`), {
    status: 500,
    body: { code: PASSWORD },
  });

  it("still ends the session, with the sign-up's token, after the promotion threw", async () => {
    declareRuntime("development");
    const r = recorder({ promoteThrows: PROMOTION_FAILURE });

    await expect(
      provisionFirstAdministrator({ email: EMAIL, password: PASSWORD }, r.deps),
    ).rejects.toThrow();

    expect(r.calls).toEqual([
      "hasAnyUsers",
      "signUpEmail",
      "promoteInitialAdministrator",
      "revokeSession",
    ]);
    expect(r.revoked).toHaveLength(1);
    expect(r.revoked[0].token).toBe(TOKEN);
  });

  it("names the account, says the promotion did not complete, and says the session WAS ended", async () => {
    declareRuntime("development");
    const r = recorder({ promoteThrows: PROMOTION_FAILURE });

    let caught: unknown = null;
    try {
      await provisionFirstAdministrator({ email: EMAIL, password: PASSWORD }, r.deps);
    } catch (error) {
      caught = error;
    }

    const message = String((caught as Error).message);
    expect(message).toContain(EMAIL);
    expect(message).toMatch(/did not complete|unknown/i);
    expect(message).toMatch(/session[^.]*ended/i);
    // The underlying failure only as the allowlisted machine detail.
    expect(message).toContain("500");
    expect(message).not.toContain(PASSWORD);
    expect(message).not.toContain(TOKEN);
    expect((caught as Error).cause).toBeUndefined();
  });

  it("says BOTH when the promotion throws and the session cannot be ended either", async () => {
    declareRuntime("development");
    const revokeFailure = Object.assign(new Error(`revoke blew up on ${TOKEN}`), {
      status: 401,
      body: { code: TOKEN },
    });
    const r = recorder({ promoteThrows: PROMOTION_FAILURE, revokeThrows: revokeFailure });

    let caught: unknown = null;
    try {
      await provisionFirstAdministrator({ email: EMAIL, password: PASSWORD }, r.deps);
    } catch (error) {
      caught = error;
    }

    const message = String((caught as Error).message);
    // ONE error carrying both facts, not a revoke failure that hid the first.
    expect(message).toContain(EMAIL);
    expect(message).toMatch(/did not complete|unknown/i);
    expect(message).toMatch(/still live/i);
    expect(message).toContain("500");
    expect(message).toContain("401");
    expect(message).not.toContain(PASSWORD);
    expect(message).not.toContain(TOKEN);
  });
});

describe("provisionFirstAdministrator: what counts as a session having been minted", () => {
  it("ends nothing when the sign-up returned neither a token nor a cookie", async () => {
    declareRuntime("development");
    const r = recorder({ token: null, setCookie: null });

    const outcome = await provisionFirstAdministrator(
      { email: EMAIL, password: PASSWORD },
      r.deps,
    );

    expect(outcome.written).toBe(true);
    expect(r.calls).not.toContain("revokeSession");
  });

  it("FAILS LOUDLY when a session cookie came back with no token to end it by", async () => {
    declareRuntime("development");
    const r = recorder({ token: null });

    let caught: unknown = null;
    try {
      await provisionFirstAdministrator({ email: EMAIL, password: PASSWORD }, r.deps);
    } catch (error) {
      caught = error;
    }

    // A cookie IS evidence of a session. Skipping the revoke because no token
    // came back would leave exactly the session this leg exists to end.
    expect(caught).toBeInstanceOf(Error);
    const message = String((caught as Error).message);
    expect(message).toContain(EMAIL);
    expect(message).toMatch(/still live/i);
    expect(message).toMatch(/token/i);
    expect(r.calls).not.toContain("revokeSession");
  });

  it("gives its OWN failures a reason of their own, not 'none carried'", async () => {
    declareRuntime("development");
    // The default revoke refuses when no cookie came back to present. That is
    // this module's own refusal, and it carries no value — so it is quoted, not
    // swallowed as an endpoint refusal with no machine code would be.
    const r = recorder();
    r.deps.revokeSession = async () => {
      const { InternalProvisioningRefusal } = await import(
        "@/lib/dev-instance-provisioning/provision-first-administrator"
      );
      throw new InternalProvisioningRefusal("no session cookie came back from the sign-up");
    };

    let caught: unknown = null;
    try {
      await provisionFirstAdministrator({ email: EMAIL, password: PASSWORD }, r.deps);
    } catch (error) {
      caught = error;
    }

    const message = String((caught as Error).message);
    expect(message).toContain("no session cookie came back from the sign-up");
    expect(message).not.toContain("none carried");
  });
});

describe("provisionFirstAdministrator: the seat is already taken", () => {
  it("writes nothing, calls nothing, and reads as a normal outcome", async () => {
    declareRuntime("development");
    const r = recorder({ hasAnyUsers: true });

    const outcome = await provisionFirstAdministrator(
      { email: EMAIL, password: PASSWORD },
      r.deps,
    );

    expect(outcome).toEqual({
      written: false,
      email: EMAIL,
      alreadySeated: true,
      administrator: false,
    });
    // The probe, and then nothing: no sign-up, no promotion, no revoke, no throw.
    expect(r.calls).toEqual(["hasAnyUsers"]);
  });

  it("answers the same whether or not the address is the one on file", async () => {
    declareRuntime("development");
    const stranger = "somebody-else@example.test";
    for (const email of [EMAIL, stranger]) {
      const r = recorder({ hasAnyUsers: true });
      const outcome = await provisionFirstAdministrator({ email, password: PASSWORD }, r.deps);
      expect(outcome.alreadySeated).toBe(true);
      expect(outcome.written).toBe(false);
      expect(r.calls).toEqual(["hasAnyUsers"]);
      // Only the address it was HANDED comes back. The outcome of the stranger's
      // run says nothing whatsoever about the address the instance holds.
      expect(outcome.email).toBe(email);
    }

    const r = recorder({ hasAnyUsers: true });
    const outcome = await provisionFirstAdministrator(
      { email: stranger, password: PASSWORD },
      r.deps,
    );
    expect(JSON.stringify(outcome)).not.toContain(EMAIL);
  });

  it("does not even ask about the password policy once the seat is taken", async () => {
    declareRuntime("development");
    const r = recorder({ hasAnyUsers: true, minimumPasswordLength: 12 });
    const outcome = await provisionFirstAdministrator({ email: EMAIL, password: "short" }, r.deps);
    expect(outcome.alreadySeated).toBe(true);
  });
});

describe("provisionFirstAdministrator: the password", () => {
  it("names the MINIMUM rule on a refusal, and never the password", async () => {
    declareRuntime("development");
    const r = recorder({ minimumPasswordLength: 12 });
    const tooShort = "short-9f2";

    let caught: unknown = null;
    try {
      await provisionFirstAdministrator({ email: EMAIL, password: tooShort }, r.deps);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AdministratorPasswordRefusedError);
    const error = caught as AdministratorPasswordRefusedError;
    expect(error.message).toContain("at least 12 characters");
    expect(error.message).not.toContain(tooShort);
    expect(error.cause).toBeUndefined();
    // Refused BEFORE the account call, not after it.
    expect(r.calls).toEqual(["hasAnyUsers"]);
  });

  it("names the MAXIMUM rule too — the library refuses an over-long one as well", async () => {
    declareRuntime("development");
    const r = recorder({ maximumPasswordLength: 128 });
    const tooLong = "y".repeat(129);

    let caught: unknown = null;
    try {
      await provisionFirstAdministrator({ email: EMAIL, password: tooLong }, r.deps);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AdministratorPasswordRefusedError);
    expect((caught as Error).message).toContain("at most 128 characters");
    expect((caught as Error).message).not.toContain(tooLong);
    expect(r.calls).toEqual(["hasAnyUsers"]);
  });

  it("repeats nothing of an endpoint refusal that quotes the password", async () => {
    declareRuntime("development");
    // The worst case the rule exists for: a refusal whose message, code and
    // cause all carry the value that was sent.
    const hostile = Object.assign(new Error(`rejected the password ${PASSWORD}`), {
      status: 400,
      statusCode: 400,
      body: { code: PASSWORD, message: PASSWORD },
    });
    const r = recorder({ signUpThrows: hostile });

    let caught: unknown = null;
    try {
      await provisionFirstAdministrator({ email: EMAIL, password: PASSWORD }, r.deps);
    } catch (error) {
      caught = error;
    }

    const error = caught as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain(PASSWORD);
    expect(error.cause).toBeUndefined();
    expect(String(error.stack ?? "")).not.toContain(PASSWORD);
    // The account was never promoted, and no session was minted to revoke.
    expect(r.calls).toEqual(["hasAnyUsers", "signUpEmail"]);
  });

  it("keeps the password out of every outcome it returns", async () => {
    declareRuntime("development");
    const r = recorder();
    const outcome = await provisionFirstAdministrator(
      { email: EMAIL, name: "The Operator", password: PASSWORD },
      r.deps,
    );
    expect(JSON.stringify(outcome)).not.toContain(PASSWORD);
  });

  it("refuses a blank password by naming where a password travels", async () => {
    declareRuntime("development");
    const r = recorder();
    await expect(
      provisionFirstAdministrator({ email: EMAIL, password: "" }, r.deps),
    ).rejects.toThrow(/stdin/i);
    expect(r.calls).toEqual([]);
  });

  it("does not trim the password it was handed", async () => {
    declareRuntime("development");
    const r = recorder();
    const padded = `  ${PASSWORD}  `;
    await provisionFirstAdministrator({ email: EMAIL, password: padded }, r.deps);
    expect(r.signUpBodies[0].password).toBe(padded);
  });
});

// ---------------------------------------------------------------------------
// The shape claim: the DEFAULTS are the product's own members, and this module
// writes nothing itself. Doubles cannot prove either, and a source scan keeps
// holding for whatever somebody changes here later — the same instrument the
// gate's own suite uses for the same kind of claim.
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const LEG = readFileSync(
  path.join(ROOT, "src/lib/dev-instance-provisioning/provision-first-administrator.ts"),
  "utf8",
);

describe("the fifth leg reuses the product's own account path", () => {
  it("defaults to the authentication library's own server-side sign-up", () => {
    expect(LEG).toMatch(/auth\.api\.signUpEmail\(/);
  });

  it("asks the sign-up for its response headers, so the session can be presented", () => {
    expect(LEG).toMatch(/returnHeaders:\s*true/);
  });

  it("defaults to the library's own single-session revoke", () => {
    expect(LEG).toMatch(/auth\.api\.revokeSession\(/);
  });

  it("defaults to the product's own first-user bootstrap for the promotion", () => {
    expect(LEG).toMatch(/ensureInitialAdminBootstrap/);
  });

  it("defaults to the product's own reader for 'does a person hold this instance'", () => {
    expect(LEG).toMatch(/hasAnyBetterAuthUsers/);
  });

  it("hashes nothing, writes no user row, deletes no session row, and sets no role", () => {
    for (const forbidden of [
      /\bhash\w*\(/i,
      /\bbcrypt\b/i,
      /\bscrypt\b/i,
      /UPDATE\s+public/i,
      /INSERT\s+INTO/i,
      /DELETE\s+FROM/i,
      /role:\s*["']admin["']/,
      /betterAuthDb/,
      /drizzle/i,
      // The library's own endpoints only — never its internals.
      /internalAdapter/,
      /\$context/,
    ]) {
      expect(LEG, `the leg must not contain ${String(forbidden)}`).not.toMatch(forbidden);
    }
  });
});
