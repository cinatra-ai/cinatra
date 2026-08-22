import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createMcpRuntimeServer } from "../runtime-server";
import {
  admissionRecordFor,
  createDelegatedChatAdmissionSnapshot,
  unavailableDelegatedChatAdmissionSnapshot,
  type DelegatedChatAdmissionRecord,
  type DelegatedChatAdmissionSnapshot,
} from "../delegated-chat-admission";
import { primitiveProvenanceStamp } from "../capability-plan";
import {
  HOST_PRIMITIVE_OWNER_PACKAGE,
  HOST_PRIMITIVE_RELEASE_VERSION,
} from "../host-primitive-identity";
import { coreDelegatedChatAdmissionRecords } from "../host-primitive-declarations";
import { coreDelegatedChatAdmittedNames } from "../core-delegated-chat-surface";
import { mcpRequestContextStorage } from "../request-context";

// ---------------------------------------------------------------------------
// THE PERIMETER SWAP, THROUGH THE REAL RUNTIME SERVER (cinatra#2817 slice 3).
//
// Two claims, and neither is arguable from a unit test of the evaluator alone:
//
//   1. THE EXTENSIBILITY OUTCOME. A hot-installed connector primitive with a
//      reviewed, version-bound `read` declaration is ADVERTISED and CALLABLE
//      through the real delegated-chat runtime — registration filter, catalog
//      derivation and call-time guard — with no core-name edit anywhere.
//
//   2. NOTHING ELSE MOVED. All eight refusal cases the issue names are refused
//      by the same real runtime, and the unconditional backstops still win over
//      any declaration, admission or override.
//
// The observable is the SDK's own registered-tool map plus the call-time guard's
// own response, so these are reads of what the wire does, not of what the plan
// says about itself.
// ---------------------------------------------------------------------------

const SCHEMA = z.object({});
const CONNECTOR = "@acme/widgets";
const CONNECTOR_VERSION = "3.1.4";
const CONNECTOR_PRIMITIVE = "acme_widget_catalog_list";

function reviewed(
  overrides: Partial<{
    ownerPackage: string;
    resolvedVersion: string;
    primitiveName: string;
    declaredClass: "read" | "discovery" | "dispatch";
  }> = {},
): DelegatedChatAdmissionRecord {
  return admissionRecordFor({
    ownerPackage: CONNECTOR,
    resolvedVersion: CONNECTOR_VERSION,
    primitiveName: CONNECTOR_PRIMITIVE,
    declaredClass: "read",
    ...overrides,
  });
}

function snapshotOf(records: readonly unknown[]): DelegatedChatAdmissionSnapshot {
  return createDelegatedChatAdmissionSnapshot({
    rawRecords: [...coreDelegatedChatAdmissionRecords(), ...records],
    activationGeneration: 1,
    admissionGeneration: 1,
  });
}

type Registration = {
  name: string;
  declaredClass?: unknown;
  ownerPackage?: string;
  resolvedVersion?: string;
  /** Omit the provenance stamp entirely — a core/bundled registration. */
  core?: boolean;
  /** Replace the config with a hostile one whose stamp throws on read. */
  hostileStamp?: boolean;
};

async function build(input: {
  snapshot: DelegatedChatAdmissionSnapshot;
  registrations: readonly Registration[];
  /** Register UNFILTERED, so the call-time guard can be observed on its own. */
  unrestricted?: boolean;
}) {
  const called: string[] = [];
  const server = await createMcpRuntimeServer({
    name: "test",
    version: "0.0.0",
    toolPolicyMode: input.unrestricted ? "unrestricted" : "delegated-chat",
    delegatedChatAdmissionSnapshot: input.snapshot,
    registerCapabilities: (toolServer) => {
      for (const reg of input.registrations) {
        const base: Record<string, unknown> = {
          title: reg.name,
          description: reg.name,
          inputSchema: SCHEMA,
          ...(reg.declaredClass === undefined ? {} : { delegatedChat: reg.declaredClass }),
        };
        const config = reg.hostileStamp
          ? Object.defineProperty(base, "cinatraPrimitive", {
              get() {
                throw new Error("hostile");
              },
              enumerable: true,
            })
          : reg.core
            ? base
            : {
                ...base,
                ...primitiveProvenanceStamp({
                  ownerPackage: reg.ownerPackage ?? CONNECTOR,
                  resolvedVersion: reg.resolvedVersion ?? CONNECTOR_VERSION,
                  dispatchTarget: {
                    kind: "extension-default",
                    packageName: reg.ownerPackage ?? CONNECTOR,
                    version: reg.resolvedVersion ?? CONNECTOR_VERSION,
                    name: reg.name,
                  },
                }),
              };
        (
          toolServer.registerTool as unknown as (
            n: string,
            c: unknown,
            h: (...a: unknown[]) => unknown,
          ) => unknown
        )(reg.name, config, async () => {
          called.push(reg.name);
          return { content: [{ type: "text", text: "served" }] };
        });
      }
    },
  });
  const registry = (
    server as unknown as {
      _registeredTools: Record<string, { handler: (...a: unknown[]) => unknown }>;
    }
  )._registeredTools;
  return {
    advertised: Object.keys(registry).sort(),
    called,
    /**
     * Invoke the registered handler inside a delegated-chat request frame and
     * report what the CALL-TIME DELEGATED-CHAT GUARD decided.
     *
     * The guard is the first thing in the wrapper, and its refusal is the one
     * fixed sentence below. Everything after it — the deny-by-default authz
     * boundary, then the user handler — is a different gate with its own
     * suites, and under THIS package's vitest config the boundary's lazy
     * `@/lib/authz/mcp-boundary` import does not resolve at all (the same
     * reason `meta-claims-cannot-override-authz` keeps its frame probes off the
     * policed path). So reaching the boundary IS the observable for "the chat
     * perimeter admitted this call"; reading it as a failure would test the
     * wrong gate.
     */
    async call(name: string): Promise<"CHAT_DENIED" | "CHAT_ADMITTED"> {
      const entry = registry[name];
      if (!entry) throw new Error(`"${name}" is not registered`);
      const result = (await mcpRequestContextStorage.run({ delegatedRestricted: true }, () =>
        entry.handler({}, {}),
      )) as { content?: Array<{ text?: string }>; isError?: boolean };
      const text = result.content?.[0]?.text ?? "";
      return text.includes("is not available to this delegated MCP request")
        ? "CHAT_DENIED"
        : "CHAT_ADMITTED";
    },
  };
}

describe("the extensibility outcome", () => {
  it("a REVIEWED hot-installed connector primitive is advertised AND callable", async () => {
    // The whole point of the issue, end to end through the real runtime: no
    // core file names `acme_widget_catalog_list` anywhere, and it is reachable
    // because its exact package version and declaration were admitted.
    const built = await build({
      snapshot: snapshotOf([reviewed()]),
      registrations: [{ name: CONNECTOR_PRIMITIVE, declaredClass: "read" }],
    });
    expect(built.advertised).toContain(CONNECTOR_PRIMITIVE);
    await expect(built.call(CONNECTOR_PRIMITIVE)).resolves.toBe("CHAT_ADMITTED");
  });

  it("the core surface is UNCHANGED by the swap", async () => {
    // Byte-for-byte: every core primitive this build declares for still
    // registers, and the reserved built-in still arrives.
    const coreNames = [...coreDelegatedChatAdmittedNames()];
    const built = await build({
      snapshot: snapshotOf([]),
      registrations: coreNames
        .filter((n) => n !== "system_screen_lookup")
        .map((name) => ({ name, core: true })),
    });
    expect(built.advertised).toEqual([...coreNames].sort());
  });
});

// ---------------------------------------------------------------------------
// THE EIGHT REFUSAL CASES the issue's Proof block names, each through the real
// runtime: not advertised, and not callable.
// ---------------------------------------------------------------------------
describe("the eight refusals", () => {
  async function refuses(input: {
    snapshot: DelegatedChatAdmissionSnapshot;
    registration: Registration;
  }) {
    const built = await build({
      snapshot: input.snapshot,
      registrations: [input.registration],
    });
    expect(built.advertised).not.toContain(input.registration.name);
    // The reserved built-in is the ONLY thing a refusal leaves behind.
    expect(built.advertised.filter((n) => n !== "system_screen_lookup")).toEqual([]);
    expect(built.called).toEqual([]);
    return built;
  }

  it("1. SELF-CLASSIFIED-ONLY — declares `read`, nothing reviewed", async () => {
    await refuses({
      snapshot: snapshotOf([]),
      registration: { name: CONNECTOR_PRIMITIVE, declaredClass: "read" },
    });
  });

  it("2. UNDECLARED — reviewed, but the registration declares nothing", async () => {
    await refuses({
      snapshot: snapshotOf([reviewed()]),
      registration: { name: CONNECTOR_PRIMITIVE },
    });
  });

  it("3. MALFORMED — reviewed, but the declaration is unreadable", async () => {
    await refuses({
      snapshot: snapshotOf([reviewed()]),
      registration: { name: CONNECTOR_PRIMITIVE, declaredClass: "superuser" },
    });
  });

  it("4. UNADMITTED — reviewed for `read`, registration declares `dispatch`", async () => {
    // Same owner, same version, same name: only the declaration moved, which
    // moves the digest. An admission does not follow a re-classification.
    await refuses({
      snapshot: snapshotOf([reviewed()]),
      registration: { name: CONNECTOR_PRIMITIVE, declaredClass: "dispatch" },
    });
  });

  it("5. STALE-VERSION — reviewed at 3.1.4, serving 4.0.0", async () => {
    await refuses({
      snapshot: snapshotOf([reviewed()]),
      registration: {
        name: CONNECTOR_PRIMITIVE,
        declaredClass: "read",
        resolvedVersion: "4.0.0",
      },
    });
  });

  it("6. REVOKED — the marketplace withdrew the admission", async () => {
    await refuses({
      snapshot: snapshotOf([{ ...reviewed(), revoked: true }]),
      registration: { name: CONNECTOR_PRIMITIVE, declaredClass: "read" },
    });
  });

  it("7. COLLISION-LOSING — the admission belongs to another owner", async () => {
    await refuses({
      snapshot: snapshotOf([reviewed({ ownerPackage: "@other/widgets" })]),
      registration: { name: CONNECTOR_PRIMITIVE, declaredClass: "read" },
    });
  });

  it("8. ADMISSION-STORE-UNAVAILABLE — nothing is admitted, including the core", async () => {
    const built = await build({
      snapshot: unavailableDelegatedChatAdmissionSnapshot({
        reason: "simulated",
        activationGeneration: 1,
        admissionGeneration: 1,
      }),
      registrations: [
        { name: CONNECTOR_PRIMITIVE, declaredClass: "read" },
        { name: "agent_list", core: true },
      ],
    });
    // NOT even the reserved built-in: an unavailable store admits nothing.
    expect(built.advertised).toEqual([]);
  });

  it("BONUS: an UNRESOLVABLE identity is refused, never degraded to the host's", async () => {
    // A hostile provenance stamp must not read as "unstamped" and inherit the
    // HOST identity — which would hand it the host's migrated core admissions.
    const built = await build({
      snapshot: snapshotOf([]),
      registrations: [{ name: "agent_list", declaredClass: "discovery", hostileStamp: true }],
    });
    // Only the reserved built-in the runtime registers itself.
    expect(built.advertised).toEqual(["system_screen_lookup"]);
  });

  it("a build handed NO snapshot admits nothing — absent means closed", async () => {
    let advertised: string[] = [];
    const server = await createMcpRuntimeServer({
      name: "test",
      version: "0.0.0",
      toolPolicyMode: "delegated-chat",
      registerCapabilities: (toolServer) => {
        (
          toolServer.registerTool as unknown as (
            n: string,
            c: unknown,
            h: (...a: unknown[]) => unknown,
          ) => unknown
        )("agent_list", { title: "x", description: "x", inputSchema: SCHEMA }, () => ({
          content: [],
        }));
      },
    });
    advertised = Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    );
    expect(advertised).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE UNCONDITIONAL BACKSTOPS. Preserved exactly: a declaration, an admission
// and the proposal override together cannot open a denied family, and only the
// override gets past the verb backstop.
// ---------------------------------------------------------------------------
describe("the unconditional backstops still win", () => {
  it("a DENIED FAMILY loses with a reviewed admission AND a declaration", async () => {
    const name = "permissions_grant_list";
    const built = await build({
      snapshot: snapshotOf([reviewed({ primitiveName: name })]),
      registrations: [{ name, declaredClass: "read" }],
    });
    expect(built.advertised).toEqual(["system_screen_lookup"]);
  });

  it("a DENIED VERB loses with a reviewed admission AND a declaration", async () => {
    const name = "acme_widget_delete";
    const built = await build({
      snapshot: snapshotOf([reviewed({ primitiveName: name })]),
      registrations: [{ name, declaredClass: "dispatch" }],
    });
    expect(built.advertised).toEqual(["system_screen_lookup"]);
  });

  it("the PROPOSAL OVERRIDE passes the verb backstop and still needs an admission", async () => {
    // `dashboards_create` carries the `create` verb token and is on the audited
    // override list. It is admitted here as a CORE primitive with a migrated
    // record — so the override buys it past the verb check, and the record is
    // what actually admits it.
    const built = await build({
      snapshot: snapshotOf([]),
      registrations: [{ name: "dashboards_create", core: true }],
    });
    expect(built.advertised).toContain("dashboards_create");

    // Take the record away: the override alone is not enough.
    const withoutCore = createDelegatedChatAdmissionSnapshot({
      rawRecords: coreDelegatedChatAdmissionRecords().filter(
        (r) => r.primitiveName !== "dashboards_create",
      ),
      activationGeneration: 1,
      admissionGeneration: 1,
    });
    const stripped = await build({
      snapshot: withoutCore,
      registrations: [{ name: "dashboards_create", core: true }],
    });
    expect(stripped.advertised).not.toContain("dashboards_create");
  });

  it("an EXTENSION cannot claim an override name — the owner is in the key", async () => {
    // `dashboards_create` is on the override list, so the verb backstop lets it
    // through; the admission belongs to the HOST, so a connector registering
    // the same name is refused all the same.
    const built = await build({
      snapshot: snapshotOf([]),
      registrations: [{ name: "dashboards_create", declaredClass: "dispatch" }],
    });
    expect(built.advertised).toEqual(["system_screen_lookup"]);
  });
});

describe("registration, catalog and call time agree for one snapshot", () => {
  it("a name that registered is callable; nothing else is even present", async () => {
    const snapshot = snapshotOf([reviewed()]);
    const built = await build({
      snapshot,
      registrations: [
        { name: CONNECTOR_PRIMITIVE, declaredClass: "read" },
        { name: "acme_widget_get", declaredClass: "read" },
        { name: "agent_list", core: true },
      ],
    });
    // Advertised == the admitted set: the reviewed connector primitive, the
    // core primitive, and the reserved built-in. `acme_widget_get` was declared
    // but never reviewed.
    expect(built.advertised).toEqual(
      [CONNECTOR_PRIMITIVE, "agent_list", "system_screen_lookup"].sort(),
    );
    await expect(built.call(CONNECTOR_PRIMITIVE)).resolves.toBe("CHAT_ADMITTED");
    await expect(built.call("acme_widget_get")).rejects.toThrow(/not registered/);
  });

  it("the CALL-TIME guard is REAL — it refuses a tool that slipped registration", async () => {
    // Registered UNFILTERED, then called inside a delegated-chat frame. This is
    // the belt-and-braces leg, and it is also what makes the CHAT_ADMITTED
    // observable above non-vacuous: the same probe returns CHAT_DENIED here.
    const built = await build({
      unrestricted: true,
      snapshot: snapshotOf([]),
      registrations: [
        { name: CONNECTOR_PRIMITIVE, declaredClass: "read" },
        { name: "objects_delete", core: true },
      ],
    });
    expect(built.advertised).toContain(CONNECTOR_PRIMITIVE);
    expect(built.advertised).toContain("objects_delete");
    await expect(built.call(CONNECTOR_PRIMITIVE)).resolves.toBe("CHAT_DENIED");
    await expect(built.call("objects_delete")).resolves.toBe("CHAT_DENIED");
    expect(built.called).toEqual([]);
  });

  it("registration and call time cannot disagree within ONE request", async () => {
    // Belt and braces, exercised directly: build under a snapshot that admits
    // the primitive, then call its wrapper under a snapshot-less decision by
    // re-running the guard's own path — here approximated by registering under
    // an admitting snapshot and calling with a delegated frame after the
    // admission was withdrawn from the SAME snapshot object is impossible (it
    // is immutable), which is exactly the property under test: within ONE
    // request, registration and call time cannot disagree.
    const snapshot = snapshotOf([reviewed()]);
    const built = await build({
      snapshot,
      registrations: [{ name: CONNECTOR_PRIMITIVE, declaredClass: "read" }],
    });
    await expect(built.call(CONNECTOR_PRIMITIVE)).resolves.toBe("CHAT_ADMITTED");
    // The snapshot is frozen, so nothing can mutate it mid-request.
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});

describe("the core migration preserved the surface", () => {
  it("every migrated core record names a host declaration at the release version", () => {
    for (const record of coreDelegatedChatAdmissionRecords()) {
      expect(record.ownerPackage).toBe(HOST_PRIMITIVE_OWNER_PACKAGE);
      expect(record.resolvedVersion).toBe(HOST_PRIMITIVE_RELEASE_VERSION);
    }
  });
});

// ---------------------------------------------------------------------------
// THE SNAPSHOT IS IMMUTABLE ALL THE WAY DOWN (codex whole-diff round #1).
//
// The snapshot rides the request context so the in-process self-invoker can
// inherit it — which put its records within reach of code running inside a
// delegated handler. A frozen ARRAY of mutable records is not an immutable
// snapshot: flipping one `revoked` back to `false` would re-admit a withdrawn
// primitive for the rest of the request, and every surface reading that same
// snapshot would agree with the forgery.
// ---------------------------------------------------------------------------
describe("the request snapshot cannot be rewritten from inside the request", () => {
  it("freezes every record reachable through lookup, records and recordsForPrimitive", () => {
    const snapshot = snapshotOf([{ ...reviewed(), revoked: true }]);
    // The snapshot also holds every migrated CORE record, so pick the one under
    // test rather than whichever happens to sort first.
    const viaRecords = snapshot.records.find((r) => r.primitiveName === CONNECTOR_PRIMITIVE)!;
    expect(Object.isFrozen(snapshot.records)).toBe(true);
    expect(Object.isFrozen(viaRecords)).toBe(true);

    const viaPrimitive = snapshot.recordsForPrimitive(CONNECTOR_PRIMITIVE);
    expect(Object.isFrozen(viaPrimitive)).toBe(true);
    expect(viaPrimitive.every((r) => Object.isFrozen(r))).toBe(true);

    // The attack, attempted: silently in sloppy mode, throwing in strict — the
    // observable that matters is that the value did not change.
    expect(() => {
      (viaRecords as { revoked: boolean }).revoked = false;
    }).toThrow();
    expect(viaRecords.revoked).toBe(true);
  });

  it("a forged un-revocation does not make the primitive callable", async () => {
    const snapshot = snapshotOf([{ ...reviewed(), revoked: true }]);
    for (const record of snapshot.records) {
      try {
        (record as { revoked: boolean }).revoked = false;
      } catch {
        /* frozen — which is the point */
      }
    }
    expect(snapshot.records.find((r) => r.primitiveName === CONNECTOR_PRIMITIVE)!.revoked).toBe(true);
    const built = await build({
      snapshot,
      registrations: [{ name: CONNECTOR_PRIMITIVE, declaredClass: "read" }],
    });
    expect(built.advertised).not.toContain(CONNECTOR_PRIMITIVE);
  });
});

// ---------------------------------------------------------------------------
// ONE PERIMETER MEANS EVERY RULE (codex whole-diff round #3).
// ---------------------------------------------------------------------------
describe("the call-time guard applies the canonical-name rule too", () => {
  it("refuses a mixed-case name at call time, not only at registration", async () => {
    // Registered UNFILTERED under a mixed-case name, then called in a delegated
    // frame. The evaluator case-folds, so without the canonical check the
    // admission below would match and the call would be served — under a name
    // the delegated registration filter refuses outright.
    const built = await build({
      unrestricted: true,
      snapshot: snapshotOf([reviewed()]),
      registrations: [{ name: "Acme_Widget_Catalog_List", declaredClass: "read" }],
    });
    expect(built.advertised).toContain("Acme_Widget_Catalog_List");
    await expect(built.call("Acme_Widget_Catalog_List")).resolves.toBe("CHAT_DENIED");
  });
});
