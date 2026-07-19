// Type-driven effective-identity resolver (epic #1785, "retire the generic
// default-artifact base; types come from installed extensions only").
//
// A row's identity is now a pure function of its object TYPE: the namespace-
// defining extension of the type id, but ONLY while that type is installed
// (registered). No claim arbitration, no binding/classic precedence, no
// activation barrier, no default-artifact floor. The generic artifact catch-all
// has no defining extension and resolves to no-primary.

import { describe, expect, it, beforeEach } from "vitest";
import { z } from "zod";

import { objectTypeRegistry } from "../registry";
import {
  ASSERTION_BASES,
  GENERIC_ARTIFACT_OBJECT_TYPE,
  resolveEffectiveIdentity,
} from "../effective-identity";

const EMAIL_TYPE = "@cinatra-ai/email:body";
const EMAIL_EXT = "@cinatra-ai/email";
const PACK_TYPE = "@acme/pack-artifact:thing";
const PACK_EXT = "@acme/pack-artifact";

function register(type: string, pkg?: string) {
  objectTypeRegistry.register(
    {
      type,
      category: "report",
      schema: z.record(z.string(), z.unknown()),
      lifecycle: { sources: ["agent"], mutableBy: ["agent"] },
      renderers: { listRow: null, card: null, detail: null },
    },
    pkg,
  );
}

beforeEach(() => {
  objectTypeRegistry._clearForTests();
});

describe("resolveEffectiveIdentity — type → namespace-definer → installed", () => {
  it("an unregistered / uninstalled definer resolves to no-primary (fail closed)", () => {
    expect(resolveEffectiveIdentity(EMAIL_TYPE)).toEqual({ kind: "no-primary" });
    expect(resolveEffectiveIdentity(PACK_TYPE)).toEqual({ kind: "no-primary" });
  });

  it("a registered host-namespaced type (no registration provenance) resolves to its id NAMESPACE extension", () => {
    // Host work-product types register WITHOUT a packageName — the durable
    // definer is the id namespace, not the (absent) registration provenance.
    register(EMAIL_TYPE);
    expect(resolveEffectiveIdentity(EMAIL_TYPE)).toEqual({ kind: "extension", extension: EMAIL_EXT });
  });

  it("a registered extension-provenanced type resolves to its namespace extension", () => {
    register(PACK_TYPE, PACK_EXT);
    expect(resolveEffectiveIdentity(PACK_TYPE)).toEqual({ kind: "extension", extension: PACK_EXT });
  });

  it("an uninstalled definer (removed on teardown) falls back to no-primary", () => {
    register(PACK_TYPE, PACK_EXT);
    expect(resolveEffectiveIdentity(PACK_TYPE)).toEqual({ kind: "extension", extension: PACK_EXT });
    objectTypeRegistry.removeByPackage(PACK_EXT);
    expect(resolveEffectiveIdentity(PACK_TYPE)).toEqual({ kind: "no-primary" });
  });

  it("the generic artifact catch-all is always no-primary (no defining extension), even when registered", () => {
    expect(resolveEffectiveIdentity(GENERIC_ARTIFACT_OBJECT_TYPE)).toEqual({ kind: "no-primary" });
    register(GENERIC_ARTIFACT_OBJECT_TYPE); // host built-in registration
    expect(resolveEffectiveIdentity(GENERIC_ARTIFACT_OBJECT_TYPE)).toEqual({ kind: "no-primary" });
  });

  it("a registered but NON-namespaced type id (no derivable definer) resolves to no-primary", () => {
    register("nonamespace");
    expect(resolveEffectiveIdentity("nonamespace")).toEqual({ kind: "no-primary" });
  });
});

describe("vocabulary + constants", () => {
  it("ASSERTION_BASES is exactly the DDL CHECK vocabulary (kept semantic_assertion plumbing)", () => {
    expect(ASSERTION_BASES).toEqual(["binding", "classic"]);
  });
  it("the generic artifact base type literal matches the canonical constant's value", () => {
    expect(GENERIC_ARTIFACT_OBJECT_TYPE).toBe("@cinatra-ai/artifact:object");
  });
});
