// Unit tests for the cinatra-side WP/Drupal assistant runtime validator.
//
// The canonical contract (schemas + golden fixtures + conformance tests) lives
// in the cinatra-ai/wordpress-assistant-connector repo under
// contracts/wp-drupal-assistant/; these tests pin the behaviour of core's
// validator and its enforced copy of the v1 auth-init schema
// (src/lib/wp-drupal-auth-init.schema.json). The contract repo's CI
// deep-compares that enforced copy against the canonical schema.
import { describe, expect, it } from "vitest";

import {
  CURRENT_CONTRACT_VERSION,
  SUPPORTED_CONTRACT_VERSIONS,
  isSupportedContractVersion,
  validateAuthInitRequest,
  validateContractVersion,
} from "@/lib/wp-drupal-contract";

import authInitSchema from "../wp-drupal-auth-init.schema.json";
import authInitSchemaV2 from "../wp-drupal-auth-init.v2.schema.json";

/** Minimal valid v1 auth-init bodies (one per platform context shape). */
const validWordpressBody = {
  contractVersion: "v1",
  messages: [{ role: "user", content: "Shorten the intro paragraph." }],
  context: {
    href: "https://example.com/wp-admin/post.php?post=12&action=edit",
    postId: "12",
    postType: "post",
    postStatus: "draft",
  },
};

const validDrupalBody = {
  contractVersion: "v1",
  messages: [{ role: "user", content: "Fix the typos in this node." }],
  context: {
    href: "https://example.com/node/7/edit",
    nodeId: "7",
    nodeBundle: "article",
    nodeStatus: "0",
  },
};

describe("wp-drupal contract — enforced schema copies stay in lock-step", () => {
  it("the v1 enforced copy pins const v1; the v2 enforced copy pins const v2", () => {
    expect(
      (authInitSchema as { properties: { contractVersion: { const: string } } })
        .properties.contractVersion.const,
    ).toBe("v1");
    expect(
      (authInitSchemaV2 as { properties: { contractVersion: { const: string } } })
        .properties.contractVersion.const,
    ).toBe("v2");
  });

  it("CURRENT_CONTRACT_VERSION is v2 and every supported version has an enforced schema const", () => {
    expect(CURRENT_CONTRACT_VERSION).toBe("v2");
    expect(SUPPORTED_CONTRACT_VERSIONS).toContain(CURRENT_CONTRACT_VERSION);
    expect(SUPPORTED_CONTRACT_VERSIONS).toEqual(["v1", "v2"]);
  });
});

describe("wp-drupal contract — runtime validator", () => {
  it("isSupportedContractVersion accepts v1 + v2, rejects others", () => {
    expect(isSupportedContractVersion("v1")).toBe(true);
    expect(isSupportedContractVersion("v2")).toBe(true);
    expect(isSupportedContractVersion("v3")).toBe(false);
    expect(isSupportedContractVersion(1)).toBe(false);
    expect(isSupportedContractVersion(undefined)).toBe(false);
  });

  it("validateContractVersion: supported version is ok and not legacy", () => {
    const r = validateContractVersion("v1");
    expect(r.ok).toBe(true);
    expect(r.ok && r.legacy).toBe(false);
  });

  it("validateContractVersion: absent version is ok and legacy", () => {
    const r = validateContractVersion(undefined);
    expect(r.ok).toBe(true);
    expect(r.ok && r.legacy).toBe(true);
  });

  it("validateContractVersion: explicit null is treated as absent (legacy), per the documented contract", () => {
    // Pins the deliberate `undefined || null -> legacy` behaviour in
    // validateContractVersion so a tightening of it is a visible test change.
    const r = validateContractVersion(null);
    expect(r.ok).toBe(true);
    expect(r.ok && r.legacy).toBe(true);
  });

  it("validateContractVersion: v2 is ok and not legacy", () => {
    const r = validateContractVersion("v2");
    expect(r.ok).toBe(true);
    expect(r.ok && r.legacy).toBe(false);
  });

  it("validateContractVersion: unknown version is a structured admin-visible error", () => {
    const r = validateContractVersion("v9");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("unsupported_contract_version");
      expect(r.error.supportedVersions).toEqual([...SUPPORTED_CONTRACT_VERSIONS]);
      expect(r.error.received).toBe("v9");
      expect(r.error.message).toContain("v1");
    }
  });

  it("validateAuthInitRequest: valid v1 bodies (WordPress + Drupal context shapes) pass", () => {
    expect(validateAuthInitRequest(validWordpressBody).ok).toBe(true);
    expect(validateAuthInitRequest(validDrupalBody).ok).toBe(true);
  });

  it("validateAuthInitRequest: valid v2 body passes (validated against the v2 schema)", () => {
    const r = validateAuthInitRequest({ ...validWordpressBody, contractVersion: "v2" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.legacy).toBe(false);
  });

  it("validateAuthInitRequest: a v2-declared body validated against the wrong const fails shape", () => {
    // contractVersion is the supported "v2", but suppose the rest is malformed
    // (empty messages) → invalid_request_shape against the v2 schema, not a
    // version error.
    const r = validateAuthInitRequest({ contractVersion: "v2", messages: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("invalid_request_shape");
  });

  it("validateAuthInitRequest: unknown version → unsupported_contract_version", () => {
    const r = validateAuthInitRequest({ ...validWordpressBody, contractVersion: "v9" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("unsupported_contract_version");
  });

  it("validateAuthInitRequest: versioned-but-malformed body → invalid_request_shape", () => {
    const r = validateAuthInitRequest({ contractVersion: "v1", messages: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("invalid_request_shape");
  });

  it("validateAuthInitRequest: unversioned legacy body is not hard-broken", () => {
    const r = validateAuthInitRequest({ messages: [{ role: "user", content: "hi" }] });
    expect(r.ok).toBe(true);
    expect(r.ok && r.legacy).toBe(true);
  });

  it("validateAuthInitRequest: non-object bodies are rejected, never a 500 path", () => {
    for (const bad of [null, [], "x", 7]) {
      const r = validateAuthInitRequest(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_request_shape");
    }
  });
});
