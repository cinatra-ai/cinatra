/**
 * cinatra#2047 defect D-1 — the manifest → `agent_templates.lifecycle_config`
 * COMPILE contract (pure half).
 *
 * The acceptance run found `repairCapable` undeclarable: no manifest schema
 * admitted it, nothing compiled it, and `resolveRepairCapable` is fail-soft to
 * false, so every `changes_requested` routed to `human_escalation`. These cases
 * pin the compile contract that closes it:
 *   - the manifest schema ADMITS a well-formed `cinatra.lifecycle` block and
 *     REFUSES a malformed one (a silently-dropped typo is the D-1 failure mode);
 *   - the reader is fail-soft on an unvalidated blob (never throws);
 *   - the core overlay wins per key over a manifest declaration, additively;
 *   - the serialized text is stable + round-trips through the readers the repair
 *     route and the policy lattice already use.
 */
import { describe, expect, it } from "vitest";

import {
  mergeLifecycle,
  normalizeLifecycle,
  parseLifecycleConfigText,
  readManifestLifecycle,
  serializeLifecycleConfig,
} from "@/lib/lifecycle/lifecycle-policy";
// cinatra#4264 A1: read through the namespace so that, on a base without the
// reader, this file still loads and the cases below fail on their assertions.
import * as lifecyclePolicy from "@/lib/lifecycle/lifecycle-policy";
import { agentLifecycleDeclarationSchema } from "../verdaccio/package-contract";
import {
  BLOG_POST_LIFECYCLE,
  CORE_REPAIRABLE_PRODUCED_ROLES,
  coreRepairsObjectType,
} from "../lifecycle-repair-producer-registry";

describe("cinatra#2047 D-1 — manifest lifecycle declaration schema", () => {
  it("admits a well-formed block", () => {
    const parsed = agentLifecycleDeclarationSchema.safeParse({
      producedTypes: ["artifact-blog-post-body"],
      repairCapable: true,
      requestedSkips: ["recommendation"],
    });
    expect(parsed.success).toBe(true);
  });

  it("REFUSES an unknown key (a typo must fail the manifest, never be dropped)", () => {
    // The exact D-1 failure shape: a near-miss key silently yielding "no repair
    // capability" is indistinguishable from a producer that cannot repair.
    expect(agentLifecycleDeclarationSchema.safeParse({ repairCapeable: true }).success).toBe(false);
  });

  it("REFUSES a non-checkpoint skip and a non-boolean repairCapable", () => {
    expect(agentLifecycleDeclarationSchema.safeParse({ requestedSkips: ["publish"] }).success).toBe(false);
    expect(agentLifecycleDeclarationSchema.safeParse({ repairCapable: "true" }).success).toBe(false);
  });
});

describe("cinatra#2047 D-1 — readManifestLifecycle (fail-soft reader)", () => {
  it("reads the declaration off a package manifest", () => {
    expect(
      readManifestLifecycle({
        name: "@cinatra-ai/x-agent",
        cinatra: { lifecycle: { repairCapable: true, producedTypes: ["t"] } },
      }),
    ).toEqual({ producedTypes: ["t"], repairCapable: true });
  });

  it("is null for an absent block, a legacy manifest, and junk — never throws", () => {
    expect(readManifestLifecycle({ cinatra: {} })).toBeNull();
    expect(readManifestLifecycle({})).toBeNull();
    expect(readManifestLifecycle(null)).toBeNull();
    expect(readManifestLifecycle("nope")).toBeNull();
    expect(readManifestLifecycle({ cinatra: { lifecycle: 7 } })).toBeNull();
  });

  it("drops non-conforming members rather than propagating them", () => {
    expect(
      normalizeLifecycle({
        requestedSkips: ["review", "nope", 3],
        producedTypes: ["a", "", 5, "a"],
        repairCapable: "yes",
      }),
    ).toEqual({ requestedSkips: ["review"], producedTypes: ["a"] });
  });
});

describe("cinatra#2047 D-1 — core overlay precedence", () => {
  it("the core overlay wins per key; other manifest keys carry forward", () => {
    const merged = mergeLifecycle(
      { repairCapable: false, requestedSkips: ["recommendation"], producedTypes: ["from-manifest"] },
      { repairCapable: true, producedTypes: ["from-core"] },
    );
    expect(merged).toEqual({
      repairCapable: true,
      producedTypes: ["from-core"],
      requestedSkips: ["recommendation"],
    });
  });

  it("either side may be absent", () => {
    expect(mergeLifecycle(null, { repairCapable: true })).toEqual({ repairCapable: true });
    expect(mergeLifecycle({ repairCapable: true }, null)).toEqual({ repairCapable: true });
    expect(mergeLifecycle(null, null)).toBeNull();
  });

  it("the blog post body is the core-implemented first repair, declared by ROLE not by package", () => {
    expect(BLOG_POST_LIFECYCLE.repairCapable).toBe(true);
    expect(CORE_REPAIRABLE_PRODUCED_ROLES).toContain("artifact-blog-post-body");
    // Every entry is a host-neutral role name, never a package name — the
    // core→extension instance-coupling ban has a zero floor.
    for (const role of CORE_REPAIRABLE_PRODUCED_ROLES) {
      expect(role.startsWith("@")).toBe(false);
      expect(role.includes("/")).toBe(false);
    }
  });
});

describe("cinatra#2047 D-1 — persisted JSON-as-text form", () => {
  it("is stable (key order does not depend on input order) and round-trips", () => {
    const a = serializeLifecycleConfig({ repairCapable: true, producedTypes: ["t"], requestedSkips: ["review"] });
    const b = serializeLifecycleConfig({ requestedSkips: ["review"], producedTypes: ["t"], repairCapable: true });
    expect(a).toBe(b);
    expect(parseLifecycleConfigText(a)).toEqual({
      producedTypes: ["t"],
      repairCapable: true,
      requestedSkips: ["review"],
    });
  });

  it("an empty declaration serializes to null (the column stays NULL)", () => {
    expect(serializeLifecycleConfig(null)).toBeNull();
    expect(serializeLifecycleConfig({})).toBeNull();
  });

  it("malformed persisted text reads as absent (fail-soft, never throws)", () => {
    expect(parseLifecycleConfigText("{not json")).toBeNull();
    expect(parseLifecycleConfigText(null)).toBeNull();
    expect(parseLifecycleConfigText("")).toBeNull();
  });

  it("the persisted text is exactly what the repair route's reader keys on", () => {
    // `resolveRepairCapable` does `JSON.parse(text).repairCapable === true`.
    const text = serializeLifecycleConfig(BLOG_POST_LIFECYCLE)!;
    expect((JSON.parse(text) as { repairCapable?: unknown }).repairCapable).toBe(true);
  });
});

describe("cinatra#2047 D-1 — core repair capability keys on the produced ROLE", () => {
  /** A stub role registry: the role's claimant package, resolved at call time
   * exactly as the generated bindings do. */
  const resolve = (claimant: string | undefined) => () => claimant;

  it("an artifact whose type is claimed by a core-repairable role IS core-repairable", () => {
    expect(coreRepairsObjectType("@vendor/some-artifact:post", resolve("@vendor/some-artifact"))).toBe(true);
  });

  it("an artifact from a DIFFERENT claimant is not", () => {
    expect(coreRepairsObjectType("@vendor/other-artifact:post", resolve("@vendor/some-artifact"))).toBe(false);
  });

  it("an unresolvable role (reduced universe) is fail-soft, not repair-capable", () => {
    expect(coreRepairsObjectType("@vendor/some-artifact:post", resolve(undefined))).toBe(false);
    expect(
      coreRepairsObjectType("@vendor/some-artifact:post", () => {
        throw new Error("bindings stale");
      }),
    ).toBe(false);
  });

  it("a non-namespaced / absent object type is not repair-capable", () => {
    expect(coreRepairsObjectType("document", resolve("@vendor/some-artifact"))).toBe(false);
    expect(coreRepairsObjectType(null, resolve("@vendor/some-artifact"))).toBe(false);
    expect(coreRepairsObjectType(":post", resolve("@vendor/some-artifact"))).toBe(false);
  });
});

describe("cinatra#4424 — the declared repair findings input", () => {
  it("the schema admits a producer that names the input its repair run gets the findings in", () => {
    expect(
      agentLifecycleDeclarationSchema.safeParse({
        repairCapable: true,
        repairFindingsInput: { input: "instructions" },
      }).success,
    ).toBe(true);
  });

  it("the schema REFUSES a bare string, an unknown member, a non-identifier and a reserved input", () => {
    for (const repairFindingsInput of [
      "instructions",
      { input: "instructions", step: "draft" },
      { input: "" },
      { input: "two words" },
      { input: "1st" },
      { input: "lifecycleRepairRequest" },
      { input: "__proto__" },
      { input: "toString" },
      { input: "hasOwnProperty" },
      { input: "x".repeat(129) },
      { input: 5 },
      { input: null },
      { input: ["instructions"] },
      {},
    ]) {
      expect(agentLifecycleDeclarationSchema.safeParse({ repairFindingsInput }).success).toBe(false);
    }
  });

  it("the reader keeps an admissible input name, ignores any other member, and drops a declaration without one", () => {
    expect(
      readManifestLifecycle({
        cinatra: { lifecycle: { repairCapable: true, repairFindingsInput: { input: "instructions" } } },
      }),
    ).toEqual({ repairCapable: true, repairFindingsInput: { input: "instructions" } });
    for (const repairFindingsInput of ["instructions", { input: "lifecycleRepairRequest" }, { input: 7 }, [], null]) {
      expect(normalizeLifecycle({ repairCapable: true, repairFindingsInput })).toEqual({ repairCapable: true });
    }
    expect(normalizeLifecycle({ repairFindingsInput: { input: "instructions", extra: 1 } })).toEqual({
      repairFindingsInput: { input: "instructions" },
    });
  });

  it("the persisted text is stable and round-trips; a producer that declares none persists the same text as before", () => {
    const declared = { repairFindingsInput: { input: "instructions" }, repairCapable: true, producedTypes: ["t"] };
    const text = serializeLifecycleConfig(declared);
    expect(text).toBe(
      '{"producedTypes":["t"],"repairCapable":true,"repairFindingsInput":{"input":"instructions"}}',
    );
    expect(parseLifecycleConfigText(text)).toEqual({
      producedTypes: ["t"],
      repairCapable: true,
      repairFindingsInput: { input: "instructions" },
    });
    expect(serializeLifecycleConfig({ repairCapable: true })).toBe('{"repairCapable":true}');
  });
});

describe("cinatra#4264 A1: the regenerate declaration", () => {
  const image = { artifactNode: "file_image", step: "image_flow", noteInput: "prompt" };
  const draft = { artifactNode: "write_draft", step: "draft_flow", noteInput: "note" };

  it("the schema admits a two-entry list and a 129-character node id", () => {
    expect(agentLifecycleDeclarationSchema.safeParse({ regenerate: [image, draft] }).success).toBe(true);
    const long = { ...image, artifactNode: "n".repeat(129) };
    expect(agentLifecycleDeclarationSchema.safeParse({ regenerate: [long] }).success).toBe(true);
  });

  it("the schema REFUSES a bare object, an empty or 17-entry list, a duplicate artifactNode, unknown members, empty ids and bad note inputs", () => {
    const many = Array.from({ length: 17 }, (_, i) => ({ ...image, artifactNode: `f${i}` }));
    for (const regenerate of [
      image,
      [],
      many,
      [image, { ...draft, artifactNode: "file_image" }],
      [{ ...image, extra: 1 }],
      [{ ...image, artifactNode: "" }],
      [{ ...image, step: "" }],
      ...["lifecycleRepairRequest", "__proto__", "constructor", "two words", ""].map((noteInput) => [
        { ...image, noteInput },
      ]),
    ]) {
      expect(agentLifecycleDeclarationSchema.safeParse({ regenerate }).success).toBe(false);
    }
  });

  it("normalizeLifecycle keeps a valid list and drops the whole key on one bad entry", () => {
    expect(normalizeLifecycle({ regenerate: [image, draft] })).toEqual({ regenerate: [image, draft] });
    for (const regenerate of [
      [image, { ...draft, noteInput: "__proto__" }],
      [image, { ...draft, artifactNode: "file_image" }],
      [image, { ...draft, extra: 1 }],
      [],
      image,
    ]) {
      expect(normalizeLifecycle({ repairCapable: true, regenerate })).toEqual({ repairCapable: true });
    }
  });

  it("A1b stores the list: after repairFindingsInput, sorted by artifactNode, members in a fixed order", () => {
    const text = serializeLifecycleConfig({
      requestedSkips: ["review"],
      regenerate: [draft, image],
      repairFindingsInput: { input: "instructions" },
    });
    expect(text).toBe(
      '{"repairFindingsInput":{"input":"instructions"},' +
        '"regenerate":[{"artifactNode":"file_image","step":"image_flow","noteInput":"prompt"},' +
        '{"artifactNode":"write_draft","step":"draft_flow","noteInput":"note"}],' +
        '"requestedSkips":["review"]}',
    );
    // Code-unit order, not locale order: "Z" (0x5a) sorts before "a" (0x61).
    const upper = { ...image, artifactNode: "Z_file" };
    expect(serializeLifecycleConfig({ regenerate: [image, upper] })).toBe(
      '{"regenerate":[{"artifactNode":"Z_file","step":"image_flow","noteInput":"prompt"},' +
        '{"artifactNode":"file_image","step":"image_flow","noteInput":"prompt"}]}',
    );
    // Member order is fixed whatever order the entry was written in.
    const shuffled = { noteInput: "prompt", step: "image_flow", artifactNode: "file_image" } as typeof image;
    expect(serializeLifecycleConfig({ regenerate: [shuffled] })).toBe(
      '{"regenerate":[{"artifactNode":"file_image","step":"image_flow","noteInput":"prompt"}]}',
    );
    // Round trip: the stored text reads back to the same declaration.
    expect(normalizeLifecycle(JSON.parse(text as string))).toEqual(
      normalizeLifecycle({ requestedSkips: ["review"], regenerate: [image, draft], repairFindingsInput: { input: "instructions" } }),
    );
    expect(serializeLifecycleConfig(normalizeLifecycle(JSON.parse(text as string)))).toBe(text);
  });

  it("readStoredRegenerate returns the raw stored list a writer retains, else undefined", () => {
    const { readStoredRegenerate } = lifecyclePolicy as unknown as {
      readStoredRegenerate?: (text: string | null | undefined) => unknown;
    };
    expect(typeof readStoredRegenerate).toBe("function");
    if (!readStoredRegenerate) return;
    expect(readStoredRegenerate(JSON.stringify({ repairCapable: true, regenerate: [image] }))).toEqual([image]);
    // Raw, not normalized: a stored list the normalizer would drop is still
    // handed to the writer's check, which then refuses it.
    expect(readStoredRegenerate(JSON.stringify({ regenerate: [{ ...image, extra: 1 }] }))).toEqual([
      { ...image, extra: 1 },
    ]);
    for (const text of [null, undefined, JSON.stringify({ repairCapable: true })]) {
      expect(readStoredRegenerate(text)).toBeUndefined();
    }
  });

  it("readStoredRegenerate THROWS on stored text it cannot read (review 1: never 'no list')", () => {
    // A truncated or foreign column text may have carried a list; reading it as
    // "no list" would let a writer keep it unchecked. Every writer refuses on
    // this throw, as on a failed row read.
    const { readStoredRegenerate } = lifecyclePolicy as unknown as {
      readStoredRegenerate: (text: string | null | undefined) => unknown;
    };
    // Review 2: the EMPTY text too. The column is JSON text or NULL; "" is not
    // a declaration of "no list", it is text that cannot be read.
    for (const text of ["", '{"regenerate":[{"artifactNode":"file_ima', "{ not json", "[]", "null", "7"]) {
      expect(() => readStoredRegenerate(text)).toThrow(/stored lifecycle declaration cannot be read/);
    }
  });

  it("a lifecycle without the key serializes to the pinned text of today", () => {
    expect(
      serializeLifecycleConfig({ producedTypes: ["t"], repairCapable: true, requestedSkips: ["review"] }),
    ).toBe('{"producedTypes":["t"],"repairCapable":true,"requestedSkips":["review"]}');
  });

  it("readRegenerateEntry returns the entry of one filing node, else null", () => {
    const { readRegenerateEntry } = lifecyclePolicy;
    expect(typeof readRegenerateEntry).toBe("function");
    const lifecycle = normalizeLifecycle({ regenerate: [image, draft] });
    expect(readRegenerateEntry(lifecycle, "file_image")).toEqual({ step: "image_flow", noteInput: "prompt" });
    expect(readRegenerateEntry(lifecycle, "image_flow")).toBeNull();
    expect(readRegenerateEntry(null, "file_image")).toBeNull();
  });
});
