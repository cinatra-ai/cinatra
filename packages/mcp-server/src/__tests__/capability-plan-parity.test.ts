import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createMcpRuntimeServer } from "../runtime-server";
import {
  HOST_PRIMITIVE_OWNER_PACKAGE,
  HOST_PRIMITIVE_RELEASE_VERSION,
  planPrimitiveRegistration,
  plannedServableNames,
  plannedServableNormalizedNames,
  primitiveProvenanceStamp,
  readPrimitiveProvenance,
  type CapabilityPlan,
} from "../capability-plan";
import { evaluateDelegatedChatAdmission } from "../delegated-chat-evaluator";
import {
  coreDelegatedChatAdmissionSnapshot,
  coreDelegatedChatAdmittedNames,
} from "../core-delegated-chat-surface";
import { HOST_PRIMITIVE_DECLARATIONS } from "../host-primitive-declarations";

// ---------------------------------------------------------------------------
// REQUEST-SCOPED CAPABILITY PLAN ↔ ACTUAL REGISTRATION PARITY (cinatra#2817
// slice 1).
//
// THE PROPERTY UNDER TEST, stated as a defect: if the plan and the live server
// can disagree about what registered, then the catalog can advertise a
// primitive `tools/call` cannot resolve — or, worse, hide one it CAN. Slice 1's
// claim is that they cannot disagree, because `plan.servable` is recorded from
// inside the one choke point that registers.
//
// THE OBSERVABLE IS THE SDK'S OWN STATE, not the plan's. `_registeredTools` is
// the map `tools/list` is served from and `tools/call` resolves against, so
// reading it is a direct read of "what actually registered". Comparing the plan
// against itself would prove nothing.
// ---------------------------------------------------------------------------

/** The names the SDK server ACTUALLY holds — the map tools/list is served from. */
function actuallyRegistered(server: unknown): string[] {
  const registry = (server as { _registeredTools?: Record<string, unknown> })._registeredTools;
  if (!registry || typeof registry !== "object") {
    throw new Error(
      "could not read the SDK's registered-tool map — the parity check would be vacuous",
    );
  }
  return Object.keys(registry).sort();
}

const SCHEMA = z.object({});

type Reg = {
  name: string;
  config?: Record<string, unknown>;
  /** Registered a second time — the SDK rejects the duplicate. */
  expectThrow?: boolean;
};

async function buildWithPlan(input: {
  mode?: "unrestricted" | "delegated-chat";
  registrations: readonly Reg[];
}): Promise<{ plan: CapabilityPlan; registered: string[] }> {
  let plan: CapabilityPlan | undefined;
  const server = await createMcpRuntimeServer({
    name: "test",
    version: "0.0.0",
    toolPolicyMode: input.mode ?? "delegated-chat",
    // The request's admission snapshot. The CORE one: these cases are about the
    // plan/registration relationship, so the core surface stands in for a live
    // request's snapshot. A build handed NONE admits nothing (which the
    // fail-closed case below pins separately).
    delegatedChatAdmissionSnapshot: coreDelegatedChatAdmissionSnapshot(),
    onCapabilityPlan: (p) => {
      plan = p;
    },
    registerCapabilities: (toolServer) => {
      for (const reg of input.registrations) {
        const config = {
          title: reg.name,
          description: reg.name,
          inputSchema: SCHEMA,
          ...(reg.config ?? {}),
        };
        const call = () =>
          (
            toolServer.registerTool as unknown as (
              n: string,
              c: unknown,
              h: (...a: unknown[]) => unknown,
            ) => unknown
          )(reg.name, config, () => ({ content: [{ type: "text", text: "ok" }] }));
        if (reg.expectThrow) {
          expect(call).toThrow();
        } else {
          call();
        }
      }
    },
  });
  if (!plan) throw new Error("the capability plan was never emitted");
  return { plan, registered: actuallyRegistered(server) };
}

/** Provenance for a hot-installed extension primitive at an exact version. */
function extensionStamp(pkg: string, version: string, name: string, kind: "extension-default" | "extension-versioned" = "extension-default") {
  return primitiveProvenanceStamp({
    ownerPackage: pkg,
    resolvedVersion: version,
    dispatchTarget: { kind, packageName: pkg, version, name },
  });
}

// A legacy-admitted core name, so a case that is meant to REGISTER actually can
// under today's (pre-slice-3) delegated-chat perimeter.
const CORE_ADMITTED = coreDelegatedChatAdmittedNames()[0]!;
const CORE_ADMITTED_2 = coreDelegatedChatAdmittedNames()[1]!;

describe("plan ↔ actually-registered parity", () => {
  it("DEFAULT case: the plan's servable set is exactly what the SDK holds", async () => {
    const { plan, registered } = await buildWithPlan({
      registrations: [{ name: CORE_ADMITTED }, { name: CORE_ADMITTED_2 }],
    });
    // `system_screen_lookup` is the reserved built-in the runtime server adds
    // itself; it is in both sets or in neither.
    expect(plannedServableNames(plan)).toEqual(registered);
    expect(registered).toContain(CORE_ADMITTED);
  });

  it("UNRESTRICTED case: parity holds when nothing is filtered", async () => {
    const { plan, registered } = await buildWithPlan({
      mode: "unrestricted",
      registrations: [{ name: "acme_widget_catalog_list" }, { name: "objects_delete" }],
    });
    expect(plannedServableNames(plan)).toEqual(registered);
    expect(registered).toContain("objects_delete");
  });

  it("HOT-INSTALLED case: a refused connector primitive is in NEITHER set", async () => {
    const { plan, registered } = await buildWithPlan({
      registrations: [
        {
          name: "acme_widget_catalog_list",
          config: {
            delegatedChat: "read",
            ...extensionStamp("@acme/widgets", "3.1.4", "acme_widget_catalog_list"),
          },
        },
      ],
    });
    expect(registered).not.toContain("acme_widget_catalog_list");
    expect(plannedServableNames(plan)).not.toContain("acme_widget_catalog_list");
    expect(plannedServableNames(plan)).toEqual(registered);
    // The plan still RECORDS it, with its resolved identity and the reason.
    const entry = plan.entries.find((e) => e.name === "acme_widget_catalog_list");
    expect(entry?.ownerPackage).toBe("@acme/widgets");
    expect(entry?.resolvedVersion).toBe("3.1.4");
    expect(entry?.declaredClass).toBe("read");
    const outcome = plan.outcomes.find((o) => o.planned.name === "acme_widget_catalog_list");
    expect(outcome?.registered).toBe(false);
    // Nothing has been reviewed for this connector primitive, so the only
    // classification in existence is its own registration's.
    expect(outcome?.reason).toBe("self_classified_only");
  });

  it("COLLISION case: a duplicate name registers ONCE and the plan says so", async () => {
    // Two HOST registrations of the same core name: both pass admission, so the
    // second reaches the SDK and the SDK rejects the duplicate.
    const { plan, registered } = await buildWithPlan({
      registrations: [{ name: CORE_ADMITTED }, { name: CORE_ADMITTED, expectThrow: true }],
    });
    expect(registered.filter((n) => n === CORE_ADMITTED)).toHaveLength(1);
    expect(plannedServableNames(plan)).toEqual(registered);
    const planned = plan.entries.filter((e) => e.name === CORE_ADMITTED);
    expect(planned).toHaveLength(2);
    const outcomes = plan.outcomes.filter((o) => o.planned.name === CORE_ADMITTED);
    expect(outcomes.map((o) => o.registered)).toEqual([true, false]);
    expect(outcomes[1]!.reason).toBe("register_tool_threw");
  });

  it("COLLISION-LOSING case: an extension SHADOWING a core name is refused at admission", async () => {
    // It never reaches the SDK at all — the core admission belongs to the HOST,
    // and the owner is part of the lookup key, so a same-name registration by
    // another package cannot inherit it. This is the refusal the issue names
    // "collision-losing", and it is why a same-name collision cannot transfer
    // an approval.
    const { plan, registered } = await buildWithPlan({
      registrations: [
        {
          name: CORE_ADMITTED,
          config: {
            delegatedChat: HOST_PRIMITIVE_DECLARATIONS[CORE_ADMITTED],
            ...extensionStamp("@acme/shadow", "1.0.0", CORE_ADMITTED),
          },
        },
      ],
    });
    expect(registered).not.toContain(CORE_ADMITTED);
    expect(plannedServableNames(plan)).toEqual(registered);
    const outcome = plan.outcomes.find((o) => o.planned.name === CORE_ADMITTED);
    expect(outcome).toEqual(
      expect.objectContaining({ registered: false, reason: "collision_lost" }),
    );
    expect(outcome!.planned.ownerPackage).toBe("@acme/shadow");
  });

  it("MALFORMED-SCHEMA case: a registration the SDK rejects is servable in NEITHER", async () => {
    const { plan, registered } = await buildWithPlan({
      registrations: [
        {
          name: CORE_ADMITTED,
          // A raw JSON Schema — server@2.0.0 THROWS at registration.
          config: { inputSchema: { type: "object" } },
          expectThrow: true,
        },
        { name: CORE_ADMITTED_2 },
      ],
    });
    expect(registered).not.toContain(CORE_ADMITTED);
    expect(plannedServableNames(plan)).toEqual(registered);
    const outcome = plan.outcomes.find((o) => o.planned.name === CORE_ADMITTED);
    expect(outcome).toEqual(
      expect.objectContaining({ registered: false, reason: "register_tool_threw" }),
    );
  });

  it("VERSION-PINNED case: the plan carries the RETAINED version, not the default's", async () => {
    const { plan } = await buildWithPlan({
      mode: "unrestricted",
      registrations: [
        {
          name: "acme_report_get",
          config: extensionStamp("@acme/reports", "9.9.9", "acme_report_get", "extension-versioned"),
        },
      ],
    });
    const entry = plan.entries.find((e) => e.name === "acme_report_get")!;
    expect(entry.resolvedVersion).toBe("9.9.9");
    expect(entry.dispatchTarget).toEqual({
      kind: "extension-versioned",
      packageName: "@acme/reports",
      version: "9.9.9",
      name: "acme_report_get",
    });
  });
});

describe("the plan's structure", () => {
  it("preserves REGISTRATION ORDER and appends the reserved built-in last", async () => {
    const { plan } = await buildWithPlan({
      mode: "unrestricted",
      registrations: [{ name: "alpha_one" }, { name: "beta_two" }, { name: "gamma_three" }],
    });
    expect(plan.entries.map((e) => e.name)).toEqual([
      "alpha_one",
      "beta_two",
      "gamma_three",
      "system_screen_lookup",
    ]);
    expect(plan.entries.map((e) => e.order)).toEqual([0, 1, 2, 3]);
  });

  it("marks the reserved host built-in as reserved and nothing else", async () => {
    const { plan } = await buildWithPlan({
      mode: "unrestricted",
      registrations: [{ name: "alpha_one" }],
    });
    expect(plan.entries.filter((e) => e.reserved).map((e) => e.name)).toEqual([
      "system_screen_lookup",
    ]);
  });

  it("plans an unstamped (core/bundled) registration under the host RELEASE identity", async () => {
    const { plan } = await buildWithPlan({
      mode: "unrestricted",
      registrations: [{ name: "alpha_one" }],
    });
    const entry = plan.entries.find((e) => e.name === "alpha_one")!;
    expect(entry.ownerPackage).toBe(HOST_PRIMITIVE_OWNER_PACKAGE);
    expect(entry.resolvedVersion).toBe(HOST_PRIMITIVE_RELEASE_VERSION);
    expect(entry.identityFailure).toBeNull();
  });

  it("normalizes the name for policy but PROJECTS the name the wire serves", async () => {
    // The two projections exist because they answer different questions, and
    // conflating them is how a catalog comes to advertise a name `tools/call`
    // cannot resolve.
    const { plan, registered } = await buildWithPlan({
      mode: "unrestricted",
      registrations: [{ name: "Alpha_One" }],
    });
    const entry = plan.entries.find((e) => e.registeredName === "Alpha_One")!;
    expect(entry.name).toBe("alpha_one");
    expect(registered).toContain("Alpha_One");
    // The servable projection matches the SDK exactly, casing included.
    expect(plannedServableNames(plan)).toEqual(registered);
    expect(plannedServableNormalizedNames(plan)).toContain("alpha_one");
  });

  it("parity survives two CASE-DISTINCT registrations of the same normalized name", async () => {
    // Both register (the SDK keys on the exact string), so a projection that
    // deduped on the normalized name would under-report the servable set by one
    // and the parity check would be reading a lie.
    const { plan, registered } = await buildWithPlan({
      mode: "unrestricted",
      registrations: [{ name: "Alpha_One" }, { name: "alpha_one" }],
    });
    expect(registered).toEqual(expect.arrayContaining(["Alpha_One", "alpha_one"]));
    expect(plannedServableNames(plan)).toEqual(registered);
  });

  it("resolves the capability key through the injected resolver", async () => {
    let plan: CapabilityPlan | undefined;
    await createMcpRuntimeServer({
      name: "test",
      version: "0.0.0",
      toolPolicyMode: "unrestricted",
      resolveCapabilityKey: (name) => (name.startsWith("gmail_") ? "gmail-connector" : null),
      onCapabilityPlan: (p) => {
        plan = p;
      },
      registerCapabilities: (toolServer) => {
        (
          toolServer.registerTool as unknown as (
            n: string,
            c: unknown,
            h: (...a: unknown[]) => unknown,
          ) => unknown
        )("gmail_aliases_list", { title: "x", description: "x", inputSchema: SCHEMA }, () => ({
          content: [],
        }));
      },
    });
    expect(plan!.entries.find((e) => e.name === "gmail_aliases_list")?.capabilityKey).toBe(
      "gmail-connector",
    );
    expect(plan!.entries.find((e) => e.name === "system_screen_lookup")?.capabilityKey).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE PROVENANCE READER. Fail-closed in the same direction as the declaration
// reader: PRESENT-and-unreadable is never re-read as ABSENT, because absent
// means "core/bundled" and would inherit the HOST's identity — and, once slice
// 2 lands, the host's admission records.
// ---------------------------------------------------------------------------
describe("readPrimitiveProvenance", () => {
  it("reads a well-formed stamp", () => {
    const read = readPrimitiveProvenance({
      ...primitiveProvenanceStamp({ ownerPackage: "@acme/x", resolvedVersion: "1.2.3" }),
    });
    expect(read).toEqual({
      kind: "resolved",
      provenance: { ownerPackage: "@acme/x", resolvedVersion: "1.2.3", capabilityKey: null },
    });
  });

  it("reads an ABSENT stamp as absent (a core/bundled registration)", () => {
    expect(readPrimitiveProvenance({ title: "x" })).toEqual({ kind: "absent" });
    expect(readPrimitiveProvenance(undefined)).toEqual({ kind: "absent" });
    expect(readPrimitiveProvenance(null)).toEqual({ kind: "absent" });
    expect(readPrimitiveProvenance("nope")).toEqual({ kind: "absent" });
  });

  it("a THROWING accessor fails the identity — it does NOT read as absent", () => {
    const hostile = Object.defineProperty({}, "cinatraPrimitive", {
      get() {
        throw new Error("hostile");
      },
      enumerable: true,
    });
    expect(readPrimitiveProvenance(hostile)).toEqual({
      kind: "failed",
      failure: "provenance_unreadable",
    });
  });

  it("a throwing accessor INSIDE the stamp fails the identity too", () => {
    const stamp = Object.defineProperty({ resolvedVersion: "1.0.0" }, "ownerPackage", {
      get() {
        throw new Error("hostile");
      },
      enumerable: true,
    });
    expect(readPrimitiveProvenance({ cinatraPrimitive: stamp })).toEqual({
      kind: "failed",
      failure: "provenance_unreadable",
    });
  });

  it("a PRESENT but empty stamp FAILS — it does not read as a core registration", () => {
    // `{ cinatraPrimitive: null }` is a BROKEN stamp, not an absent one.
    // Reading it as absent would hand it the host identity and, with it, the
    // host's migrated admission records.
    expect(readPrimitiveProvenance({ cinatraPrimitive: null })).toEqual({
      kind: "failed",
      failure: "provenance_malformed",
    });
    expect(readPrimitiveProvenance({ cinatraPrimitive: undefined })).toEqual({
      kind: "failed",
      failure: "provenance_malformed",
    });
  });

  it("a structurally invalid stamp FAILS rather than degrading to the host identity", () => {
    for (const bad of [
      { cinatraPrimitive: 7 },
      { cinatraPrimitive: { ownerPackage: "@acme/x" } },
      { cinatraPrimitive: { ownerPackage: "", resolvedVersion: "1.0.0" } },
      { cinatraPrimitive: { ownerPackage: "@acme/x", resolvedVersion: 1 } },
      { cinatraPrimitive: { ownerPackage: "@acme/x", resolvedVersion: "1", capabilityKey: 5 } },
      {
        cinatraPrimitive: {
          ownerPackage: "@acme/x",
          resolvedVersion: "1",
          dispatchTarget: { kind: "wat", packageName: "@acme/x", version: "1", name: "n" },
        },
      },
    ]) {
      expect(readPrimitiveProvenance(bad).kind, JSON.stringify(bad)).toBe("failed");
    }
  });

  it("a failed identity is planned with NULL owner/version, never the host's", async () => {
    const hostile = Object.defineProperties(
      { title: "x", description: "x", inputSchema: SCHEMA } as Record<string, unknown>,
      {
        cinatraPrimitive: {
          get() {
            throw new Error("hostile");
          },
          enumerable: true,
        },
      },
    );
    let plan: CapabilityPlan | undefined;
    await createMcpRuntimeServer({
      name: "test",
      version: "0.0.0",
      toolPolicyMode: "unrestricted",
      onCapabilityPlan: (p) => {
        plan = p;
      },
      registerCapabilities: (toolServer) => {
        (
          toolServer.registerTool as unknown as (
            n: string,
            c: unknown,
            h: (...a: unknown[]) => unknown,
          ) => unknown
        )("acme_thing_get", hostile, () => ({ content: [] }));
      },
    });
    const entry = plan!.entries.find((e) => e.name === "acme_thing_get")!;
    expect(entry.ownerPackage).toBeNull();
    expect(entry.resolvedVersion).toBeNull();
    expect(entry.dispatchTarget).toBeNull();
    expect(entry.identityFailure).toBe("provenance_unreadable");
  });
});

// ---------------------------------------------------------------------------
// THE CLOSED PERIMETERS DECIDE ABOUT THE NAME THE WIRE SERVES.
//
// The widget allowlist is deliberately case-SENSITIVE: a
// `WordPress_Content_Editor_Run` is a DIFFERENT primitive from the editor and
// must be denied, never case-folded into it. Deciding about a normalized name
// would silently repeal that.
// ---------------------------------------------------------------------------
describe("closed perimeters and non-canonical casing", () => {
  async function registersUnderWidget(name: string): Promise<boolean> {
    let outcome = false;
    await createMcpRuntimeServer({
      name: "test",
      version: "0.0.0",
      toolPolicyMode: "delegated-widget",
      widgetDelegationKind: "wordpress",
      registerCapabilities: (toolServer) => {
        const handle = (
          toolServer.registerTool as unknown as (
            n: string,
            c: unknown,
            h: (...a: unknown[]) => unknown,
          ) => unknown
        )(name, { title: name, description: name, inputSchema: SCHEMA }, () => ({ content: [] }));
        outcome = handle != null;
      },
    });
    return outcome;
  }

  it("registers the widget kind's canonical primitive", async () => {
    expect(await registersUnderWidget("wordpress_content_editor_run")).toBe(true);
  });

  it("REFUSES the same primitive under a non-canonical casing", async () => {
    expect(await registersUnderWidget("WordPress_Content_Editor_Run")).toBe(false);
  });

  it("REFUSES a non-canonical casing on the delegated-chat perimeter too", async () => {
    const { plan } = await buildWithPlan({
      registrations: [{ name: CORE_ADMITTED.toUpperCase() }],
    });
    const outcome = plan.outcomes.find(
      (o) => o.planned.registeredName === CORE_ADMITTED.toUpperCase(),
    );
    expect(outcome).toEqual(
      expect.objectContaining({ registered: false, reason: "non_canonical_primitive_name" }),
    );
  });

  it("the UNRESTRICTED perimeter is unchanged — a mixed-case name still registers", async () => {
    const { registered } = await buildWithPlan({
      mode: "unrestricted",
      registrations: [{ name: "Acme_Thing_Get" }],
    });
    expect(registered).toContain("Acme_Thing_Get");
  });
});

// ---------------------------------------------------------------------------
// THE HOST OWNER IS NOT CLAIMABLE (cinatra#2817 review round).
//
// The host owner string is load-bearing: `planPrimitiveRegistration` inherits
// HOST_PRIMITIVE_DECLARATIONS whenever the owner is the host package, and the
// migrated core records are keyed on that owner. The stamp's owner comes from
// the INSTALLED package's own name, so before this refusal nothing structural
// stopped a package that named itself `@cinatra-ai/host` from reaching for the
// host identity. Two other rules made it unreachable in practice (it would
// also have to resolve to HOST_PRIMITIVE_RELEASE_VERSION, and core names are
// collision-skipped). This asserts the refusal itself, so the property does not
// depend on those two rules holding.
// ---------------------------------------------------------------------------
describe("a STAMPED registration may not claim the host owner", () => {
  const hostDeclaredName = Object.keys(HOST_PRIMITIVE_DECLARATIONS)[0];
  // The realistic shape: the impersonator DECLARES for itself, so the
  // declaration checks pass and the IDENTITY check is the one that decides.
  const claimingHostOwner = (ownerPackage: string) => ({
    ...primitiveProvenanceStamp({
      ownerPackage,
      resolvedVersion: HOST_PRIMITIVE_RELEASE_VERSION,
    }),
    delegatedChat: "read",
  });
  const plan = (ownerPackage: string) =>
    planPrimitiveRegistration({
      name: hostDeclaredName,
      config: claimingHostOwner(ownerPackage),
      order: 0,
      host: { packageName: HOST_PRIMITIVE_OWNER_PACKAGE, version: HOST_PRIMITIVE_RELEASE_VERSION },
    });

  it("refuses the identity outright rather than resolving it", () => {
    const planned = plan(HOST_PRIMITIVE_OWNER_PACKAGE);

    expect(planned.identityFailure).toBe("host_owner_claimed");
    expect(planned.ownerPackage).toBeNull();
    expect(planned.resolvedVersion).toBeNull();
    expect(planned.dispatchTarget).toBeNull();
  });

  it("the evaluator denies it under the real core admissions", () => {
    const decision = evaluateDelegatedChatAdmission(
      plan(HOST_PRIMITIVE_OWNER_PACKAGE),
      coreDelegatedChatAdmissionSnapshot(),
    );
    expect(decision).toEqual({ allowed: false, reason: "identity_unresolved" });
  });

  it("CONTROL: the same registration under its OWN owner resolves normally", () => {
    const planned = plan("@acme/widgets");

    expect(planned.identityFailure).toBeNull();
    expect(planned.ownerPackage).toBe("@acme/widgets");
    expect(planned.resolvedVersion).toBe(HOST_PRIMITIVE_RELEASE_VERSION);
    // Its OWN declaration is in force; it never inherits the host's.
    expect(planned.declaredClass).toBe("read");
    // And it is still not admitted: no reviewed record exists for that tuple.
    expect(
      evaluateDelegatedChatAdmission(planned, coreDelegatedChatAdmissionSnapshot()).allowed,
    ).toBe(false);
  });

  it("CONTROL: a STAMP-LESS (core) registration still inherits the host declaration", () => {
    const planned = planPrimitiveRegistration({
      name: hostDeclaredName,
      config: { title: "core" },
      order: 0,
      host: { packageName: HOST_PRIMITIVE_OWNER_PACKAGE, version: HOST_PRIMITIVE_RELEASE_VERSION },
    });

    expect(planned.identityFailure).toBeNull();
    expect(planned.ownerPackage).toBe(HOST_PRIMITIVE_OWNER_PACKAGE);
    expect(planned.declaredClass).toBe(HOST_PRIMITIVE_DECLARATIONS[hostDeclaredName]);
  });
});
