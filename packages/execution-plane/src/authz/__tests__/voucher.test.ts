// Per-command authorization voucher — VERIFY-side acceptance battery
// (exec-plane, epic #1705).
//
// REAL Ed25519 throughout: real keypairs, real detached signatures over the
// module's own canonical serialization. Nothing here stubs the crypto — a test
// that passes against a faked signature proves nothing about an authorization
// boundary. The forgery case signs with a genuinely unrelated key rather than
// corrupting bytes, so it fails for the reason a real attacker would.

import { generateKeyPairSync, sign } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assembleVoucher,
  canonicalVoucherPayload,
  commandDigest,
  encodeVoucherBody,
  ExecutionVoucherVerifier,
  VOUCHER_CLOCK_SKEW_MS,
  VOUCHER_SIGNING_DOMAIN,
  voucherSigningInput,
  VoucherKeyMaterialError,
  type ExecutionVoucherClaims,
} from "../voucher";

const AUD = "urn:cinatra:execution-broker:test";
const OTHER_AUD = "urn:cinatra:execution-broker:other";

const trusted = generateKeyPairSync("ed25519");
const foreign = generateKeyPairSync("ed25519");

const NOW = 1_700_000_000_000;
const TTL = 30_000;
const COMMAND = "python3 tool.py";

function claims(over: Partial<ExecutionVoucherClaims> = {}): ExecutionVoucherClaims {
  return {
    aud: AUD,
    jobId: "job-1",
    orgId: "org-1",
    userId: "user-1",
    surface: "agent_run",
    runId: "run-1",
    commandSha256: commandDigest(COMMAND),
    commandId: "cmd-1",
    egressPolicy: { mode: "none" },
    nonce: "nonce-1",
    iat: NOW,
    exp: NOW + TTL,
    ...over,
  };
}

function signed(c: ExecutionVoucherClaims, key = trusted.privateKey): string {
  const body = encodeVoucherBody(c);
  return assembleVoucher(
    body,
    sign(null, Buffer.from(voucherSigningInput(body), "utf8"), key).toString("base64url"),
  );
}

function verifier(
  over: Partial<{ aud: string; skewMs: number; nonceCapacity: number }> = {},
): ExecutionVoucherVerifier {
  return new ExecutionVoucherVerifier({
    publicKey: trusted.publicKey,
    aud: over.aud ?? AUD,
    ...(over.skewMs !== undefined ? { skewMs: over.skewMs } : {}),
    ...(over.nonceCapacity !== undefined ? { nonceCapacity: over.nonceCapacity } : {}),
  });
}

const ctx = (over: Partial<Parameters<ExecutionVoucherVerifier["verify"]>[1]> = {}) => ({
  jobId: "job-1",
  command: COMMAND,
  session: { orgId: "org-1", userId: "user-1", surface: "agent_run", runId: "run-1" },
  nowMs: NOW + 1_000,
  ...over,
});

describe("voucher verification — the acceptance battery", () => {
  it("accepts a well-formed voucher and returns its claims", () => {
    const v = verifier();
    const result = v.verify(signed(claims()), ctx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.commandId).toBe("cmd-1");
      expect(result.claims.egressPolicy).toEqual({ mode: "none" });
    }
  });

  it("MISSING — no voucher at all is a refusal, never an allow", () => {
    const v = verifier();
    for (const absent of [undefined, null, ""]) {
      expect(v.verify(absent, ctx())).toMatchObject({ ok: false, rejection: "missing" });
    }
  });

  it("FORGED KEY — a structurally perfect voucher signed by another key is refused", () => {
    const v = verifier();
    // Identical claims, real signature, wrong signer: only the key differs.
    expect(v.verify(signed(claims(), foreign.privateKey), ctx())).toMatchObject({
      ok: false,
      rejection: "bad_signature",
    });
  });

  it("FORGED BODY — tampering with a signed body invalidates the signature", () => {
    const v = verifier();
    const good = signed(claims());
    const [, , sig] = good.split(".");
    const tampered = encodeVoucherBody(claims({ orgId: "org-victim" }));
    expect(v.verify(assembleVoucher(tampered, sig), ctx())).toMatchObject({
      ok: false,
      rejection: "bad_signature",
    });
  });

  it("signature is DOMAIN-SEPARATED — a signature over the bare body does not verify", () => {
    const v = verifier();
    const body = encodeVoucherBody(claims());
    const bare = sign(null, Buffer.from(body, "utf8"), trusted.privateKey).toString("base64url");
    expect(v.verify(assembleVoucher(body, bare), ctx())).toMatchObject({
      ok: false,
      rejection: "bad_signature",
    });
    expect(voucherSigningInput(body)).toBe(`${VOUCHER_SIGNING_DOMAIN}.${body}`);
  });

  it("MALFORMED — a non-triple, an empty segment and a bad signature encoding all refuse", () => {
    const v = verifier();
    expect(v.verify("not-a-voucher", ctx())).toMatchObject({ ok: false, rejection: "malformed" });
    expect(v.verify("v2.a.b", ctx())).toMatchObject({ ok: false, rejection: "malformed" });
    expect(v.verify("v1..sig", ctx())).toMatchObject({ ok: false, rejection: "malformed" });
    // A garbage signature segment must be a refusal, never a throw.
    expect(v.verify("v1.eyJhIjoxfQ.!!!not-base64!!!", ctx())).toMatchObject({ ok: false });
  });

  it("REPLAYED NONCE — the second presentation of the same voucher is refused", () => {
    const v = verifier();
    const voucher = signed(claims());
    expect(v.verify(voucher, ctx()).ok).toBe(true);
    expect(v.verify(voucher, ctx())).toMatchObject({ ok: false, rejection: "replayed" });
    // A DIFFERENT command id reusing the SAME nonce is refused too — the nonce is
    // the replay token, independent of what it authorizes.
    expect(
      v.verify(signed(claims({ commandId: "cmd-2" })), ctx()),
    ).toMatchObject({ ok: false, rejection: "replayed" });
  });

  it("WRONG AUD — a voucher minted for another broker in the fleet is worthless here", () => {
    const v = verifier();
    expect(v.verify(signed(claims({ aud: OTHER_AUD })), ctx())).toMatchObject({
      ok: false,
      rejection: "wrong_audience",
    });
    // And the same voucher IS good at the broker it names.
    expect(verifier({ aud: OTHER_AUD }).verify(signed(claims({ aud: OTHER_AUD })), ctx()).ok).toBe(
      true,
    );
  });

  it("COMMAND-HASH MISMATCH — a voucher cannot be lifted onto a different command", () => {
    const v = verifier();
    expect(v.verify(signed(claims()), ctx({ command: "rm -rf /" }))).toMatchObject({
      ok: false,
      rejection: "command_mismatch",
    });
    // Nor by signing a digest of some other command.
    expect(
      v.verify(signed(claims({ commandSha256: commandDigest("rm -rf /") })), ctx()),
    ).toMatchObject({ ok: false, rejection: "command_mismatch" });
  });

  it("JOB + SESSION BINDING — a voucher cannot be lifted onto another job or tenant", () => {
    expect(verifier().verify(signed(claims({ jobId: "job-other" })), ctx())).toMatchObject({
      ok: false,
      rejection: "job_mismatch",
    });
    for (const over of [
      { orgId: "org-2" },
      { userId: "user-2" },
      { surface: "chat" },
      { runId: "run-2" },
    ]) {
      expect(verifier().verify(signed(claims(over)), ctx())).toMatchObject({
        ok: false,
        rejection: "session_mismatch",
      });
    }
  });

  it("SESSION BINDING — an unbound voucher does not match a run-bound job (and back)", () => {
    const unbound = claims();
    delete unbound.runId;
    expect(verifier().verify(signed(unbound), ctx())).toMatchObject({
      ok: false,
      rejection: "session_mismatch",
    });
    expect(
      verifier().verify(
        signed(unbound),
        ctx({ session: { orgId: "org-1", userId: "user-1", surface: "agent_run" } }),
      ).ok,
    ).toBe(true);
  });

  it("PRE-EXPIRED — an already-expired voucher never authorizes anything", () => {
    const v = verifier();
    expect(
      v.verify(signed(claims({ iat: NOW - 60_000, exp: NOW - 30_000 })), ctx()),
    ).toMatchObject({ ok: false, rejection: "expired" });
  });

  it("the ±5s skew tolerance is explicit and applies in BOTH directions", () => {
    expect(VOUCHER_CLOCK_SKEW_MS).toBe(5_000);
    const v = verifier();
    // Just-expired but inside the tolerance ⇒ still good.
    const justExpired = claims({ iat: NOW - TTL, exp: NOW - 4_000 });
    expect(v.verify(signed(justExpired), ctx({ nowMs: NOW })).ok).toBe(true);
    // Past the tolerance ⇒ expired.
    expect(
      verifier().verify(signed(claims({ iat: NOW - TTL, exp: NOW - 6_000 })), ctx({ nowMs: NOW })),
    ).toMatchObject({ ok: false, rejection: "expired" });
    // Minted slightly in the future ⇒ tolerated; far in the future ⇒ refused.
    expect(
      verifier().verify(signed(claims({ iat: NOW + 4_000, exp: NOW + 40_000 })), ctx({ nowMs: NOW }))
        .ok,
    ).toBe(true);
    expect(
      verifier().verify(
        signed(claims({ iat: NOW + 60_000, exp: NOW + 90_000 })),
        ctx({ nowMs: NOW }),
      ),
    ).toMatchObject({ ok: false, rejection: "not_yet_valid" });
  });

  it("an outstanding revalidation challenge PINS the nonce for that commandId", () => {
    const v = verifier();
    // Any other nonce is refused even though the voucher is otherwise perfect.
    expect(
      v.verify(signed(claims({ nonce: "self-chosen" })), {
        ...ctx(),
        requiredNonceForCommandId: (id) => (id === "cmd-1" ? "broker-challenge" : undefined),
      }),
    ).toMatchObject({ ok: false, rejection: "replayed" });
    // The challenge nonce is accepted.
    expect(
      v.verify(signed(claims({ nonce: "broker-challenge" })), {
        ...ctx(),
        requiredNonceForCommandId: (id) => (id === "cmd-1" ? "broker-challenge" : undefined),
      }).ok,
    ).toBe(true);
  });

  it("the nonce cache is bounded by exp and FAILS CLOSED at capacity (never evicts a live nonce)", () => {
    const v = verifier({ nonceCapacity: 2 });
    expect(v.verify(signed(claims({ nonce: "n1" })), ctx()).ok).toBe(true);
    expect(v.verify(signed(claims({ nonce: "n2", commandId: "c2" })), ctx()).ok).toBe(true);
    expect(v.trackedNonces).toBe(2);
    // Saturated: refuse rather than evict — an evicted live nonce is a re-opened
    // replay window.
    expect(
      v.verify(signed(claims({ nonce: "n3", commandId: "c3" })), ctx()),
    ).toMatchObject({ ok: false, rejection: "nonce_capacity" });
    // Once the tracked entries age out past their own exp, capacity frees up.
    const later = ctx({ nowMs: NOW + TTL + VOUCHER_CLOCK_SKEW_MS + 1 });
    expect(
      v.verify(signed(claims({ nonce: "n4", commandId: "c4", iat: later.nowMs, exp: later.nowMs + TTL })), later)
        .ok,
    ).toBe(true);
    expect(v.trackedNonces).toBe(1);
  });

  it("checkFreshness is expiry-ONLY and does not re-consume the nonce", () => {
    const v = verifier();
    const c = claims();
    expect(v.verify(signed(c), ctx()).ok).toBe(true);
    // The post-queue gate re-checks the same claims — it must not replay-detect
    // this broker's own command.
    expect(v.checkFreshness(c, NOW + 1_000)).toEqual({ ok: true });
    expect(v.checkFreshness(c, NOW + TTL + VOUCHER_CLOCK_SKEW_MS + 1)).toMatchObject({
      ok: false,
      rejection: "expired",
    });
  });

  it("rejects claim shapes that are not the v1 contract", () => {
    const v = verifier();
    const bad: unknown[] = [
      { ...claims(), v: "v2" },
      { ...claims(), aud: "" },
      { ...claims(), commandId: 7 },
      { ...claims(), iat: "soon" },
      { ...claims(), exp: NOW - 1 }, // exp <= iat
      { ...claims(), egressPolicy: { mode: "wide_open" } },
      { ...claims(), egressPolicy: { mode: "allowlist", allowlist: [""] } },
      { ...claims(), egressPolicy: "none" },
      { ...claims(), runId: "" },
    ];
    for (const shape of bad) {
      const body = Buffer.from(JSON.stringify(shape), "utf8").toString("base64url");
      const token = assembleVoucher(
        body,
        sign(null, Buffer.from(voucherSigningInput(body), "utf8"), trusted.privateKey).toString(
          "base64url",
        ),
      );
      // Signed by the trusted key — so only the SHAPE check can refuse it.
      expect(v.verify(token, ctx())).toMatchObject({ ok: false, rejection: "malformed" });
    }
  });
});

describe("degenerate bounds cannot silently disable a guard (Codex round 1)", () => {
  it("REFUSES TO ARM on a non-integral or negative skew — NaN would disable three checks", () => {
    // `exp + NaN <= now`, `iat - NaN > now` and the nonce cache's `known > now`
    // are ALL false, so a NaN skew would verify an expired voucher and let its
    // nonce be consumed twice. Refuse at construction instead.
    for (const skewMs of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      expect(
        () => new ExecutionVoucherVerifier({ publicKey: trusted.publicKey, aud: AUD, skewMs }),
      ).toThrow(VoucherKeyMaterialError);
    }
    // A zero skew is legitimate (no tolerance at all) and must still arm.
    expect(
      new ExecutionVoucherVerifier({ publicKey: trusted.publicKey, aud: AUD, skewMs: 0 }).skewMs,
    ).toBe(0);
  });

  it("REFUSES TO ARM on a non-integral or non-positive nonce capacity", () => {
    for (const nonceCapacity of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5, 2.5]) {
      expect(
        () =>
          new ExecutionVoucherVerifier({ publicKey: trusted.publicKey, aud: AUD, nonceCapacity }),
      ).toThrow(VoucherKeyMaterialError);
    }
  });

  it("REFUSES a verification with no usable clock rather than evaluating against NaN", () => {
    const v = verifier();
    for (const nowMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(v.verify(signed(claims()), ctx({ nowMs }))).toMatchObject({
        ok: false,
        rejection: "clock_unavailable",
      });
    }
    // Nothing was consumed by those refusals, so the voucher is still good.
    expect(v.verify(signed(claims()), ctx()).ok).toBe(true);
  });

  it("fails CLOSED when the outstanding-challenge lookup throws", () => {
    const v = verifier();
    expect(
      v.verify(signed(claims()), {
        ...ctx(),
        requiredNonceForCommandId: () => {
          throw new Error("bookkeeping unavailable");
        },
      }),
    ).toMatchObject({ ok: false, rejection: "challenge_unavailable" });
  });

  it("never signs a floored-to-zero byte ceiling (0 means UNCAPPED downstream)", () => {
    const payload = canonicalVoucherPayload(
      claims({ egressPolicy: { mode: "allowlist", allowlist: ["pypi.org"], maxBytesPerJob: 0.5 } }),
    );
    expect(payload).toContain('"maxBytesPerJob":1');
    expect(payload).not.toContain('"maxBytesPerJob":0');
  });
});

describe("the broker cannot mint — structurally", () => {
  it("refuses PRIVATE key material, in PEM and KeyObject form", () => {
    const pem = trusted.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => new ExecutionVoucherVerifier({ publicKey: pem, aud: AUD })).toThrow(
      VoucherKeyMaterialError,
    );
    expect(
      () => new ExecutionVoucherVerifier({ publicKey: trusted.privateKey, aud: AUD }),
    ).toThrow(VoucherKeyMaterialError);
  });

  it("accepts an SPKI PEM and a public KeyObject, and refuses a non-Ed25519 key", () => {
    const spki = trusted.publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(new ExecutionVoucherVerifier({ publicKey: spki, aud: AUD }).aud).toBe(AUD);
    expect(new ExecutionVoucherVerifier({ publicKey: trusted.publicKey, aud: AUD }).aud).toBe(AUD);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() => new ExecutionVoucherVerifier({ publicKey: rsa.publicKey, aud: AUD })).toThrow(
      /Ed25519/,
    );
  });

  it("refuses to arm with no broker identity — an unnamed broker cannot check `aud`", () => {
    expect(() => new ExecutionVoucherVerifier({ publicKey: trusted.publicKey, aud: "" })).toThrow(
      VoucherKeyMaterialError,
    );
  });

  it("imports NO signing primitive from node:crypto (the load-bearing property)", () => {
    // A future edit is exactly how this property gets lost, so assert the import
    // surface itself rather than trusting the review that added it.
    const source = fs.readFileSync(path.join(__dirname, "..", "voucher.ts"), "utf8");
    const importLine = source
      .split("\n")
      .find((line) => line.startsWith("import") && line.includes("node:crypto") && !line.includes("type"));
    expect(importLine).toBeDefined();
    expect(importLine).toContain("createPublicKey");
    expect(importLine).toContain("verify");
    for (const forbidden of ["createPrivateKey", "generateKeyPair", "sign,", " sign ", "createSign"]) {
      expect(importLine).not.toContain(forbidden);
    }
    // And nowhere else in the module's CODE either. Comments are stripped first:
    // the module header deliberately NAMES the primitives it refuses to import,
    // and that prose must not be what makes this test pass or fail.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bcreatePrivateKey\b/);
    expect(code).not.toMatch(/\bgenerateKeyPair(Sync)?\b/);
    expect(code).not.toMatch(/\bcreateSign\b/);
  });
});

describe("canonical serialization", () => {
  it("is field-ORDER independent — the same claims always sign the same bytes", () => {
    const a = canonicalVoucherPayload(claims());
    const reordered: ExecutionVoucherClaims = {
      exp: NOW + TTL,
      iat: NOW,
      nonce: "nonce-1",
      egressPolicy: { mode: "none" },
      commandId: "cmd-1",
      commandSha256: commandDigest(COMMAND),
      runId: "run-1",
      surface: "agent_run",
      userId: "user-1",
      orgId: "org-1",
      jobId: "job-1",
      aud: AUD,
    };
    expect(canonicalVoucherPayload(reordered)).toBe(a);
  });

  it("normalizes + sorts the allowlist so identical host SETS sign identically", () => {
    const one = canonicalVoucherPayload(
      claims({ egressPolicy: { mode: "allowlist", allowlist: ["PyPI.org", "files.pypi.org"] } }),
    );
    const two = canonicalVoucherPayload(
      claims({ egressPolicy: { mode: "allowlist", allowlist: [" files.pypi.org ", "pypi.org", "pypi.org"] } }),
    );
    expect(one).toBe(two);
    expect(one).toContain('"allowlist":["files.pypi.org","pypi.org"]');
  });

  it("carries the version and omits an absent runId (never a null)", () => {
    const unbound = claims();
    delete unbound.runId;
    const payload = canonicalVoucherPayload(unbound);
    expect(payload).toContain('"v":"v1"');
    expect(payload).not.toContain("runId");
  });
});
