import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SIGNATURE_SCHEME_V2,
  SIGNATURE_TRANSPORT_PREFIX_V2,
  CLOSURE_HASH_NONE,
  buildSignaturePayload,
  buildSignaturePayloadV2,
  parseSignatureTransport,
  signExtension,
  signExtensionV2,
  verifyAgainstKeyV2,
  verifyExtensionSignatureV2,
  resolveSignatureVerdict,
  generateExtensionSigningKeyPair,
} from "@/lib/extension-signature";

// Signature protocol v2 (cinatra#181): payload bytes, transport versioning,
// and the FULL downgrade-refusal matrix. The committed fixtures under
// `fixtures/materialization-plan/` are the cross-side byte contract — the
// goldens here pin the host verifier against the publish-time signer.

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "materialization-plan",
);
const fixture = (name: string): string => readFileSync(path.join(FIXTURE_DIR, name), "utf8");

const FIXTURE_FIELDS = JSON.parse(fixture("fixture.json")) as {
  packageName: string;
  version: string;
  integrity: string;
};
const FIXTURE_CLOSURE_HASH = fixture("closure-hash.txt");
const FIXTURE_KEYPAIR = JSON.parse(fixture("signing-keypair.json")) as {
  publicKeyDerB64: string;
  privateKeyPkcs8DerB64: string;
};

const kp = generateExtensionSigningKeyPair();
const otherKp = generateExtensionSigningKeyPair();
const FIELDS = { packageName: "@cinatra-ai/v2-fixture", version: "1.2.3", integrity: "sha512-AAAA==" };
const HASH = "ab".repeat(64); // a well-formed 128-hex closureHash

describe("v2 payload bytes + transport parse", () => {
  it("payload is the documented 5-line canonical form (no trailing newline)", () => {
    expect(buildSignaturePayloadV2({ ...FIELDS, closureHash: HASH })).toBe(
      `${SIGNATURE_SCHEME_V2}\n@cinatra-ai/v2-fixture\n1.2.3\nsha512-AAAA==\n${HASH}`,
    );
    expect(buildSignaturePayloadV2({ ...FIELDS, closureHash: null })).toBe(
      `${SIGNATURE_SCHEME_V2}\n@cinatra-ai/v2-fixture\n1.2.3\nsha512-AAAA==\n${CLOSURE_HASH_NONE}`,
    );
  });

  it("GOLDEN: committed payload + signature fixtures verify (the signer-side contract)", () => {
    expect(buildSignaturePayload(FIXTURE_FIELDS)).toBe(fixture("payload-v1.bytes"));
    expect(buildSignaturePayloadV2({ ...FIXTURE_FIELDS, closureHash: FIXTURE_CLOSURE_HASH })).toBe(
      fixture("payload-v2.bytes"),
    );
    const sigV2 = fixture("signature.v2.txt");
    expect(sigV2.startsWith(SIGNATURE_TRANSPORT_PREFIX_V2)).toBe(true);
    expect(
      resolveSignatureVerdict(
        { ...FIXTURE_FIELDS, signature: sigV2, closureHash: FIXTURE_CLOSURE_HASH },
        { trustedKeys: [{ keyId: "fixture", publicKeyDerB64: FIXTURE_KEYPAIR.publicKeyDerB64 }], required: false },
      ),
    ).toBe(true);
    // the committed v1 signature verifies for the closure-LESS view of the
    // same package…
    expect(
      resolveSignatureVerdict(
        { ...FIXTURE_FIELDS, signature: fixture("signature.v1.txt") },
        { trustedKeys: [{ keyId: "fixture", publicKeyDerB64: FIXTURE_KEYPAIR.publicKeyDerB64 }], required: false },
      ),
    ).toBe(true);
    // …and is a HARD refusal once the plan is present (downgrade).
    expect(
      resolveSignatureVerdict(
        { ...FIXTURE_FIELDS, signature: fixture("signature.v1.txt"), closureHash: FIXTURE_CLOSURE_HASH },
        { trustedKeys: [{ keyId: "fixture", publicKeyDerB64: FIXTURE_KEYPAIR.publicKeyDerB64 }], required: false },
      ),
    ).toBe(false);
  });

  it("transport parse: bare base64 = v1; v2: prefix = v2; any other prefix = unknown", () => {
    expect(parseSignatureTransport("c2lnbmF0dXJl")).toEqual({ scheme: "v1", signatureB64: "c2lnbmF0dXJl" });
    expect(parseSignatureTransport("v2:c2ln")).toEqual({ scheme: "v2", signatureB64: "c2ln" });
    expect(parseSignatureTransport("  v2:c2ln  ")).toEqual({ scheme: "v2", signatureB64: "c2ln" });
    expect(parseSignatureTransport("v3:c2ln")).toEqual({ scheme: "unknown", prefix: "v3" });
    expect(parseSignatureTransport("ed25519:c2ln")).toEqual({ scheme: "unknown", prefix: "ed25519" });
  });

  it("sign/verify round-trip + tamper refusal on every bound field incl. closureHash", () => {
    const transport = signExtensionV2({ ...FIELDS, closureHash: HASH }, kp.privateKeyPkcs8DerB64);
    const parsed = parseSignatureTransport(transport);
    expect(parsed.scheme).toBe("v2");
    const sigB64 = (parsed as { signatureB64: string }).signatureB64;
    expect(verifyAgainstKeyV2({ ...FIELDS, closureHash: HASH }, sigB64, kp.publicKeyDerB64)).toBe(true);
    expect(verifyAgainstKeyV2({ ...FIELDS, closureHash: "cd".repeat(64) }, sigB64, kp.publicKeyDerB64)).toBe(false);
    expect(verifyAgainstKeyV2({ ...FIELDS, version: "9.9.9", closureHash: HASH }, sigB64, kp.publicKeyDerB64)).toBe(false);
    expect(verifyAgainstKeyV2({ ...FIELDS, integrity: "sha512-BBBB==", closureHash: HASH }, sigB64, kp.publicKeyDerB64)).toBe(false);
    expect(verifyAgainstKeyV2({ ...FIELDS, packageName: "@evil/x", closureHash: HASH }, sigB64, kp.publicKeyDerB64)).toBe(false);
    expect(verifyAgainstKeyV2({ ...FIELDS, closureHash: HASH }, sigB64, otherKp.publicKeyDerB64)).toBe(false);
    expect(verifyExtensionSignatureV2({ ...FIELDS, closureHash: HASH }, sigB64, [
      { keyId: otherKp.keyId, publicKeyDerB64: otherKp.publicKeyDerB64 },
      { keyId: kp.keyId, publicKeyDerB64: kp.publicKeyDerB64 },
    ])).toBe(true);
  });
});

describe("resolveSignatureVerdict — the FULL downgrade-refusal matrix", () => {
  const trustedKeys = [{ keyId: kp.keyId, publicKeyDerB64: kp.publicKeyDerB64 }];
  const v1Sig = signExtension(FIELDS, kp.privateKeyPkcs8DerB64);
  const v2Sig = signExtensionV2({ ...FIELDS, closureHash: HASH }, kp.privateKeyPkcs8DerB64);
  const v2NoneSig = signExtensionV2({ ...FIELDS, closureHash: null }, kp.privateKeyPkcs8DerB64);

  describe("PLAN PRESENT (closureHash != null): the verdict is NEVER undefined", () => {
    const withPlan = { ...FIELDS, closureHash: HASH };
    it("only a v2 signature binding the RECOMPUTED hash verifies", () => {
      expect(resolveSignatureVerdict({ ...withPlan, signature: v2Sig }, { trustedKeys, required: false })).toBe(true);
      expect(resolveSignatureVerdict({ ...withPlan, signature: v2Sig }, { trustedKeys, required: true })).toBe(true);
    });
    it.each([
      ["absent signature", null],
      ["empty signature", "   "],
      ["v1 signature (downgrade)", v1Sig],
      ["v2 binding `none`", v2NoneSig],
      ["v2 binding a DIFFERENT hash", signExtensionV2({ ...FIELDS, closureHash: "cd".repeat(64) }, kp.privateKeyPkcs8DerB64)],
      ["v2 signed by an untrusted key", signExtensionV2({ ...FIELDS, closureHash: HASH }, otherKp.privateKeyPkcs8DerB64)],
      ["unknown transport prefix", `v9:${v2Sig.slice(3)}`],
      ["garbage", "not-base64-at-all"],
    ])("HARD false: %s (required irrelevant)", (_label, signature) => {
      expect(resolveSignatureVerdict({ ...withPlan, signature }, { trustedKeys, required: false })).toBe(false);
      expect(resolveSignatureVerdict({ ...withPlan, signature }, { trustedKeys, required: true })).toBe(false);
    });
    it("HARD false with NO trusted keys configured — the trusted-bootstrap path is closed for closure packages", () => {
      expect(resolveSignatureVerdict({ ...withPlan, signature: v2Sig }, { trustedKeys: [], required: false })).toBe(false);
      expect(resolveSignatureVerdict({ ...withPlan, signature: null }, { trustedKeys: [], required: false })).toBe(false);
    });
  });

  describe("PLAN ABSENT (closureHash null/omitted): v1 semantics byte-for-byte", () => {
    it("the existing v1 policy table is unchanged (omitted closureHash)", () => {
      expect(resolveSignatureVerdict({ ...FIELDS, signature: v1Sig }, { trustedKeys, required: false })).toBe(true);
      expect(resolveSignatureVerdict({ ...FIELDS, signature: signExtension(FIELDS, otherKp.privateKeyPkcs8DerB64) }, { trustedKeys, required: false })).toBe(false);
      expect(resolveSignatureVerdict({ ...FIELDS, signature: v1Sig }, { trustedKeys: [], required: false })).toBeUndefined();
      expect(resolveSignatureVerdict({ ...FIELDS, signature: v1Sig }, { trustedKeys: [], required: true })).toBe(false);
      expect(resolveSignatureVerdict({ ...FIELDS, signature: null }, { trustedKeys, required: false })).toBeUndefined();
      expect(resolveSignatureVerdict({ ...FIELDS, signature: null }, { trustedKeys, required: true })).toBe(false);
    });
    it("explicit closureHash: null behaves identically to omitted", () => {
      expect(resolveSignatureVerdict({ ...FIELDS, signature: v1Sig, closureHash: null }, { trustedKeys, required: false })).toBe(true);
      expect(resolveSignatureVerdict({ ...FIELDS, signature: null, closureHash: null }, { trustedKeys, required: false })).toBeUndefined();
    });
    it("a v2 signature binding `none` is ALSO accepted for a closure-less package", () => {
      expect(resolveSignatureVerdict({ ...FIELDS, signature: v2NoneSig }, { trustedKeys, required: false })).toBe(true);
      // …but a v2 binding a real hash does NOT verify a closure-less package.
      expect(resolveSignatureVerdict({ ...FIELDS, signature: v2Sig }, { trustedKeys, required: false })).toBe(false);
    });
    it("an UNKNOWN transport prefix is a hard refusal (never strip-and-retry), even unrequired/keyless", () => {
      expect(resolveSignatureVerdict({ ...FIELDS, signature: "v9:c2ln" }, { trustedKeys, required: false })).toBe(false);
      expect(resolveSignatureVerdict({ ...FIELDS, signature: "v9:c2ln" }, { trustedKeys: [], required: false })).toBe(false);
    });
    it("a v2-`none` signature with NO trusted keys keeps the v1 'cannot validate' semantics", () => {
      expect(resolveSignatureVerdict({ ...FIELDS, signature: v2NoneSig }, { trustedKeys: [], required: false })).toBeUndefined();
      expect(resolveSignatureVerdict({ ...FIELDS, signature: v2NoneSig }, { trustedKeys: [], required: true })).toBe(false);
    });
  });
});

describe("review r0 hardening pins", () => {
  const trustedKeys = [{ keyId: kp.keyId, publicKeyDerB64: kp.publicKeyDerB64 }];
  const v2Sig = signExtensionV2({ ...FIELDS, closureHash: HASH }, kp.privateKeyPkcs8DerB64);

  it("F2: non-canonical/tampered v2 base64 NEVER verifies (strict 64-byte canonical rendering)", () => {
    const b64 = v2Sig.slice("v2:".length);
    // trailing junk after padding decodes to the same bytes under permissive
    // Buffer.from — must be refused at the strict transport check.
    expect(resolveSignatureVerdict({ ...FIELDS, closureHash: HASH, signature: `v2:${b64}junk` }, { trustedKeys, required: false })).toBe(false);
    // (surrounding whitespace is normalized by the SAME .trim() v1 applies —
    // only the base64 CONTENT is strict)
    expect(resolveSignatureVerdict({ ...FIELDS, closureHash: HASH, signature: `v2:${b64}AA==` }, { trustedKeys, required: false })).toBe(false);
    expect(resolveSignatureVerdict({ ...FIELDS, closureHash: HASH, signature: `v2:${b64.slice(0, 80)}==` }, { trustedKeys, required: false })).toBe(false);
    expect(resolveSignatureVerdict({ ...FIELDS, closureHash: HASH, signature: "v2:" }, { trustedKeys, required: false })).toBe(false);
    // the canonical rendering still verifies
    expect(resolveSignatureVerdict({ ...FIELDS, closureHash: HASH, signature: v2Sig }, { trustedKeys, required: false })).toBe(true);
  });

  it("F3: a malformed closureHash input is a HARD refusal, never a fall-through to the closure-less branch", () => {
    const v2NoneSig = signExtensionV2({ ...FIELDS, closureHash: null }, kp.privateKeyPkcs8DerB64);
    // the literal "none" as a closureHash STRING must not let a v2-`none`
    // signature verify on the plan-present branch
    expect(resolveSignatureVerdict({ ...FIELDS, closureHash: "none", signature: v2NoneSig }, { trustedKeys, required: false })).toBe(false);
    expect(resolveSignatureVerdict({ ...FIELDS, closureHash: HASH.toUpperCase(), signature: v2Sig }, { trustedKeys, required: false })).toBe(false);
    expect(resolveSignatureVerdict({ ...FIELDS, closureHash: HASH.slice(0, 64), signature: v2Sig }, { trustedKeys, required: false })).toBe(false);
    expect(resolveSignatureVerdict({ ...FIELDS, closureHash: "", signature: v2Sig }, { trustedKeys, required: false })).toBe(false);
  });
});
