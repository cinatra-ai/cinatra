/**
 * THE COMPOSED COMMAND, WITH FIVE LEGS INSTEAD OF FOUR.
 *
 * Two claims, and both are about ORDER and REPETITION rather than about rows
 * (rows belong to the real-database tier):
 *
 *   1. The account leg runs FIRST — the wizard's own order, where the Account
 *      step is step 1 of the rail. The four existing legs never read the current
 *      user (the provider leg passes a null actor on purpose), so nothing forces
 *      this order from below; what forces it is that every intermediate state of
 *      this command should be a state a wizard run also passes through, and an
 *      instance carrying a namespace and a provider but no administrator is not
 *      one of them.
 *   2. A second run over the same input writes nothing more and makes no
 *      further call, the new leg included.
 *
 * The members that leave the process are injected, as they are for the sibling
 * legs. The namespace leg runs for real against the unit tier's in-memory
 * metadata store, so the order below is an order of two legs actually running.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { provisionDevInstance } from "@/lib/dev-instance-provisioning/provision-instance";

const RUNTIME_ENV_KEYS = ["CINATRA_RUNTIME_MODE", "APP_RUNTIME_MODE"] as const;

// Synthetic values. Not credentials, and never treated as any.
const PASSWORD = "synthetic-administrator-password-5f21";
const EMAIL = "operator@example.test";

let calls: string[] = [];
let seated = false;

beforeEach(() => {
  calls = [];
  seated = false;
  // The account leg asks for a DECLARED development runtime; the composed
  // command is what an operator runs on one.
  process.env.CINATRA_RUNTIME_MODE = "development";
});

afterEach(() => {
  for (const key of RUNTIME_ENV_KEYS) delete process.env[key];
});

function deps() {
  return {
    // The account leg's members.
    hasAnyUsers: async () => {
      calls.push("administrator:probe");
      return seated;
    },
    signUpEmail: async () => {
      calls.push("administrator:signUp");
      return {
        token: "synthetic-session-token-a77c",
        user: { id: "user-1" },
        headers: new Headers({ "set-cookie": "synthetic.session_token=v; Path=/" }),
      };
    },
    promoteInitialAdministrator: async () => {
      calls.push("administrator:promote");
      return true;
    },
    revokeSession: async () => {
      calls.push("administrator:revoke");
    },
    minimumPasswordLength: 12,
    maximumPasswordLength: 128,
    // The namespace leg's only outward member.
    attachMarketplaceConsumer: async () => {
      calls.push("namespace:attach");
    },
  };
}

describe("provisionDevInstance with a first-administrator leg", () => {
  it("seats the administrator BEFORE the namespace, as the wizard's rail does", async () => {
    const report = await provisionDevInstance(
      {
        firstAdministrator: { email: EMAIL, password: PASSWORD },
        namespace: {
          instanceNamespace: "administrator-order-a",
          instanceDisplayName: "Administrator Order A",
        },
      },
      deps(),
    );

    expect(calls).toEqual([
      "administrator:probe",
      "administrator:signUp",
      "administrator:promote",
      "administrator:revoke",
      "namespace:attach",
    ]);
    expect(report.firstAdministrator?.written).toBe(true);
    // The operator-facing report opens on the account step too.
    expect(report.notices[0]).toMatch(/administrator/i);
    expect(report.wrote).toBe(true);
  });

  it("stays idempotent on a second run: the account leg writes nothing and calls nothing", async () => {
    const request = {
      firstAdministrator: { email: EMAIL, password: PASSWORD },
      namespace: {
        instanceNamespace: "administrator-order-b",
        instanceDisplayName: "Administrator Order B",
      },
    };

    await provisionDevInstance(request, deps());

    // The instance now has an operator, exactly as it does after the first run.
    seated = true;
    calls = [];

    const second = await provisionDevInstance(request, deps());

    // The account leg asks its one question and stops: no sign-up, no
    // promotion, no revoke, no refusal.
    expect(calls).not.toContain("administrator:signUp");
    expect(calls).not.toContain("administrator:promote");
    expect(calls).not.toContain("administrator:revoke");
    expect(calls[0]).toBe("administrator:probe");
    expect(second.firstAdministrator?.written).toBe(false);
    expect(second.firstAdministrator?.alreadySeated).toBe(true);

    // The four older legs' own idempotency is a claim about ROWS, and this tier
    // stubs the metadata store (it remembers nothing between calls), so the
    // namespace leg re-writes here and the real-database tier is where that
    // claim is proved. What belongs here is the leg this file is about.
  });

  it("writes nothing at all on a second run once the account leg is the only one asked for", async () => {
    await provisionDevInstance(
      { firstAdministrator: { email: EMAIL, password: PASSWORD } },
      deps(),
    );

    seated = true;
    calls = [];

    const second = await provisionDevInstance(
      { firstAdministrator: { email: EMAIL, password: PASSWORD } },
      deps(),
    );

    expect(calls).toEqual(["administrator:probe"]);
    expect(second.wrote).toBe(false);
    expect(second.notices).toEqual([
      "First administrator: this instance already has one — nothing written.",
    ]);
  });

  it("says nothing about the password in any operator-facing line", async () => {
    const report = await provisionDevInstance(
      {
        firstAdministrator: { email: EMAIL, name: "The Operator", password: PASSWORD },
        namespace: {
          instanceNamespace: "administrator-order-c",
          instanceDisplayName: "Administrator Order C",
        },
      },
      deps(),
    );
    expect(JSON.stringify(report)).not.toContain(PASSWORD);
  });

  it("leaves the other four legs alone when no administrator is asked for", async () => {
    const report = await provisionDevInstance(
      {
        namespace: {
          instanceNamespace: "administrator-order-d",
          instanceDisplayName: "Administrator Order D",
        },
      },
      deps(),
    );
    expect(calls).toEqual(["namespace:attach"]);
    expect(report.firstAdministrator).toBeNull();
  });

  it("runs the other four legs on an instance that declares no runtime at all", async () => {
    // The strict gate is the ACCOUNT leg's, not the command's: a run that seats
    // nobody keeps working exactly as it did before this leg existed.
    for (const key of RUNTIME_ENV_KEYS) delete process.env[key];
    const report = await provisionDevInstance(
      {
        namespace: {
          instanceNamespace: "administrator-order-e",
          instanceDisplayName: "Administrator Order E",
        },
      },
      deps(),
    );
    expect(report.namespace?.written).toBe(true);
  });
});
