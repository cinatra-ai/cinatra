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
import { agentLifecycleDeclarationSchema } from "../verdaccio/package-contract";
import { BLOG_POST_LIFECYCLE, coreLifecycleForPackage } from "../lifecycle-repair-producer-registry";

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

  it("the blog pipeline is the core-declared first repairing producer", () => {
    expect(coreLifecycleForPackage("@cinatra-ai/blog-draft-writer-agent")).toEqual(BLOG_POST_LIFECYCLE);
    expect(BLOG_POST_LIFECYCLE.repairCapable).toBe(true);
    expect(coreLifecycleForPackage("@cinatra-ai/some-other-agent")).toBeNull();
    expect(coreLifecycleForPackage(null)).toBeNull();
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
