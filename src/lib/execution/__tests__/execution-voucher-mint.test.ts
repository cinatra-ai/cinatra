// Per-command authorization voucher — MINT-side acceptance battery
// (exec-plane, epic #1705).
//
// The mint site is where the authorization DECISION is made: it re-opens the
// sealed carrier, probes liveness with the broker's own posture, re-derives the
// run's OBO ceiling chain from its LOCKED template anchor and compares it by
// CONTAINMENT against the persisted dispatch chain, resolves the effective
// egress policy, and only then signs. Every denial here means NO voucher exists
// at all, so these are the tests that prove the ceiling is actually enforced
// rather than merely documented.
//
// REAL Ed25519 and the REAL verifier: the closing test mints through this module
// and verifies through `packages/execution-plane/src/authz/voucher.ts`, so the
// two halves are proven to agree on the canonical bytes. No stubbed crypto.

import { generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  mintExecutionSession,
  sealExecutionSession,
  type ExecutionSession,
  type ExecutionSurface,
} from "@cinatra-ai/llm/execution-plane";
import { ExecutionVoucherVerifier, commandDigest } from "@cinatra-ai/execution-plane";
import type { OboCeilingChain } from "@cinatra-ai/mcp-server/obo-ceiling";

import {
  createCommandVoucherMinter,
  createEd25519VoucherSigner,
  DEFAULT_VOUCHER_TTL_MS,
  VoucherSigningKeyError,
  type VoucherMintAuditEvent,
  type VoucherMintPorts,
  type VoucherMintRunRow,
  type VoucherMintTemplateRow,
} from "@/lib/execution/execution-voucher-mint";

const SECRET = "voucher-mint-secret";
const AUD = "urn:cinatra:execution-broker:test";
const COMMAND = "python3 tool.py";
const NOW = 1_700_000_000_000;

const keypair = generateKeyPairSync("ed25519");
const signer = createEd25519VoucherSigner(keypair.privateKey);

/** The healthy baseline: a user-anchored template in org-1, run bound to run-1. */
const TEMPLATE: VoucherMintTemplateRow = { ownerLevel: "user", ownerId: "u1" };
const DERIVED: OboCeilingChain = [
  { tier: "user", id: "u1" },
  { tier: "organization", id: "org-1" },
];
const RUN: VoucherMintRunRow = {
  id: "run-1",
  orgId: "org-1",
  templateId: "tpl-1",
  projectId: null,
  oboCeiling: DERIVED,
  runBy: "user-1",
};

function carrier(
  over: Partial<{ orgId: string; userId: string; surface: ExecutionSurface; runId: string }> = {},
): string {
  const session: ExecutionSession = mintExecutionSession({
    orgId: over.orgId ?? "org-1",
    userId: over.userId ?? "user-1",
    surface: over.surface ?? "agent_run",
    ...("runId" in over ? (over.runId ? { runId: over.runId } : {}) : { runId: "run-1" }),
  });
  return sealExecutionSession(session, { secret: SECRET, nowMs: NOW });
}

type Harness = {
  mint: ReturnType<typeof createCommandVoucherMinter>;
  audits: VoucherMintAuditEvent[];
};

function harness(over: Partial<VoucherMintPorts> = {}): Harness {
  const audits: VoucherMintAuditEvent[] = [];
  const mint = createCommandVoucherMinter({
    aud: AUD,
    signer,
    livenessProbe: async () => "alive",
    readRun: async () => RUN,
    readTemplate: async () => TEMPLATE,
    resolveEgressPolicy: () => ({ mode: "none" }),
    audit: (event) => {
      audits.push(event);
    },
    carrierSecret: SECRET,
    nowMs: () => NOW,
    ...over,
  });
  return { mint, audits };
}

const request = (over: Partial<Parameters<Harness["mint"]>[0]> = {}) => ({
  sessionCarrier: carrier(),
  jobId: "job-1",
  command: COMMAND,
  commandId: "cmd-1",
  ...over,
});

let priorSecret: string | undefined;
beforeEach(() => {
  priorSecret = process.env.EXECUTION_BROKER_SECRET;
  process.env.EXECUTION_BROKER_SECRET = SECRET;
});
afterEach(() => {
  if (priorSecret === undefined) delete process.env.EXECUTION_BROKER_SECRET;
  else process.env.EXECUTION_BROKER_SECRET = priorSecret;
});

describe("the happy path", () => {
  it("mints a voucher and audits the authorization as ALLOWED", async () => {
    const { mint, audits } = harness();
    const result = await mint(request());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims).toMatchObject({
      aud: AUD,
      jobId: "job-1",
      orgId: "org-1",
      userId: "user-1",
      surface: "agent_run",
      runId: "run-1",
      commandId: "cmd-1",
      commandSha256: commandDigest(COMMAND),
      iat: NOW,
      exp: NOW + DEFAULT_VOUCHER_TTL_MS,
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ decision: "minted", commandId: "cmd-1", jobId: "job-1" });
    expect(audits[0].livenessDegraded).toBeUndefined();
  });

  it("carries a REMINT's challenge nonce instead of inventing a fresh one", async () => {
    const { mint } = harness();
    const fresh = await mint(request());
    const remint = await mint(request({ nonce: "broker-challenge" }));
    if (!fresh.ok || !remint.ok) throw new Error("expected both mints to succeed");
    expect(remint.claims.nonce).toBe("broker-challenge");
    expect(fresh.claims.nonce).not.toBe("broker-challenge");
  });

  it("signs the egress policy the mint site RESOLVED (the broker then clamps it)", async () => {
    const { mint } = harness({
      resolveEgressPolicy: () => ({ mode: "allowlist", allowlist: ["pypi.org"] }),
    });
    const result = await mint(request());
    if (!result.ok) throw new Error("expected a voucher");
    expect(result.claims.egressPolicy).toEqual({ mode: "allowlist", allowlist: ["pypi.org"] });
  });
});

describe("the OBO ceiling gate — re-derive + CONTAINMENT compare", () => {
  it("DENIES a containment MISMATCH (no voucher, and the denial is audited)", async () => {
    // The persisted dispatch chain is anchored on a DIFFERENT user than the
    // template's locked anchor re-derives to: the run's grant no longer covers
    // what the agent actually is.
    const { mint, audits } = harness({
      readRun: async () => ({
        ...RUN,
        oboCeiling: [
          { tier: "user", id: "u-someone-else" },
          { tier: "organization", id: "org-1" },
        ],
      }),
    });
    const result = await mint(request());
    expect(result).toMatchObject({ ok: false, reason: "obo_ceiling_mismatch" });
    expect(audits).toEqual([
      expect.objectContaining({ decision: "denied", denial: "obo_ceiling_mismatch", runId: "run-1" }),
    ]);
  });

  it("DENIES a project-axis element the persisted chain never granted", async () => {
    // The run was launched into a project AFTER dispatch persisted its chain.
    const { mint } = harness({
      readRun: async () => ({ ...RUN, projectId: "proj-9", oboCeiling: DERIVED }),
    });
    expect(await mint(request())).toMatchObject({ ok: false, reason: "obo_ceiling_mismatch" });
  });

  it("compares by CONTAINMENT, not equality — a persisted SUPERSET passes", async () => {
    // A composed child chain legitimately carries parent elements this mint path
    // cannot re-derive; a superset must not be read as a mismatch.
    const { mint } = harness({
      readRun: async () => ({
        ...RUN,
        oboCeiling: [...DERIVED, { tier: "team", id: "team-parent" }],
      }),
    });
    expect((await mint(request())).ok).toBe(true);
  });

  it("DENIES a MISSING persisted chain on surface=agent_run", async () => {
    const { mint, audits } = harness({ readRun: async () => ({ ...RUN, oboCeiling: null }) });
    expect(await mint(request())).toMatchObject({ ok: false, reason: "obo_ceiling_missing" });
    expect(audits[0]).toMatchObject({ decision: "denied", denial: "obo_ceiling_missing" });
  });

  it("DENIES an EMPTY persisted chain (corruption, never a vacuous allow)", async () => {
    const { mint } = harness({ readRun: async () => ({ ...RUN, oboCeiling: [] }) });
    expect(await mint(request())).toMatchObject({ ok: false, reason: "obo_ceiling_missing" });
  });

  it("DENIES a CORRUPT locked anchor rather than widening it to the org floor", async () => {
    const { mint, audits } = harness({
      readTemplate: async () => ({ ownerLevel: "user", ownerId: null }),
    });
    expect(await mint(request())).toMatchObject({ ok: false, reason: "obo_anchor_corrupt" });
    expect(audits[0]).toMatchObject({ denial: "obo_anchor_corrupt" });
  });

  it("DENIES an ABSENT template ROW — a broken reference is not the pre-backfill state", async () => {
    // Codex round 3, finding 1: tolerating a missing row would weaken the
    // re-derivation to the bare org floor, which the persisted chain trivially
    // contains — i.e. the comparison would stop detecting anything.
    const { mint, audits } = harness({ readTemplate: async () => null });
    expect(await mint(request())).toMatchObject({ ok: false, reason: "obo_anchor_corrupt" });
    expect(audits[0]).toMatchObject({ denial: "obo_anchor_corrupt" });
  });

  it("still honours the pre-backfill state: a PRESENT row with a null ownerLevel derives the org floor", async () => {
    // The shared derivation contract is not forked — only the absent-row case is
    // closed. A row that exists with no locked tier is the documented state.
    const { mint } = harness({
      readTemplate: async () => ({ ownerLevel: null, ownerId: null }),
      readRun: async () => ({ ...RUN, oboCeiling: [{ tier: "organization", id: "org-1" }] }),
    });
    expect((await mint(request())).ok).toBe(true);
  });

  it("DENIES a run row with NO organization rather than guessing the carrier's", async () => {
    // The org element is the mandatory floor of every derived chain, so guessing
    // it is exactly the wrong thing to guess (Codex round 3, finding 1).
    const { mint, audits } = harness({ readRun: async () => ({ ...RUN, orgId: null }) });
    expect(await mint(request())).toMatchObject({ ok: false, reason: "obo_anchor_corrupt" });
    expect(audits[0]).toMatchObject({ denial: "obo_anchor_corrupt" });
  });

  it("DENIES surface=agent_run with NO run binding — nothing to bound it by", async () => {
    const { mint, audits } = harness();
    const unbound = carrier({ surface: "agent_run", runId: undefined });
    expect(await mint(request({ sessionCarrier: unbound }))).toMatchObject({
      ok: false,
      reason: "run_binding_missing",
    });
    expect(audits[0]).toMatchObject({ denial: "run_binding_missing" });
  });

  it("applies the ceiling gate to ANY run-bound session, not only surface=agent_run", async () => {
    // A chat-surface session that nonetheless carries a run binding is bounded the
    // same way — the binding, not the surface label, is what makes a ceiling apply.
    const { mint } = harness({ readRun: async () => ({ ...RUN, oboCeiling: null }) });
    expect(
      await mint(request({ sessionCarrier: carrier({ surface: "chat", runId: "run-1" }) })),
    ).toMatchObject({ ok: false, reason: "obo_ceiling_missing" });
  });

  it("a session with NO run binding needs no ceiling (chat / deterministic tasks)", async () => {
    let readRunCalls = 0;
    const { mint } = harness({
      readRun: async () => {
        readRunCalls += 1;
        return RUN;
      },
    });
    const result = await mint(
      request({ sessionCarrier: carrier({ surface: "deterministic_task", runId: undefined }) }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.runId).toBeUndefined();
    expect(readRunCalls).toBe(0);
  });

  it("an unreadable ceiling is a DENIAL — an authorization that cannot be evaluated fails closed", async () => {
    const { mint, audits } = harness({
      readRun: async () => {
        throw new Error("pg down");
      },
    });
    expect(await mint(request())).toMatchObject({ ok: false, reason: "obo_ceiling_unresolved" });
    expect(audits[0]).toMatchObject({ denial: "obo_ceiling_unresolved" });

    const tplFail = harness({
      readTemplate: async () => {
        throw new Error("pg down");
      },
    });
    expect(await tplFail.mint(request())).toMatchObject({
      ok: false,
      reason: "obo_ceiling_unresolved",
    });
  });
});

describe("liveness: TWO distinct outcomes, kept distinct", () => {
  it("an ABSENT run row DENIES (the probe answers `gone`)", async () => {
    const { mint, audits } = harness({ livenessProbe: async () => "gone" });
    expect(await mint(request())).toMatchObject({ ok: false, reason: "run_removed" });
    expect(audits[0]).toMatchObject({ decision: "denied", denial: "run_removed" });
  });

  it("an absent run ROW at the ceiling read also denies run_removed", async () => {
    const { mint } = harness({ readRun: async () => null });
    expect(await mint(request())).toMatchObject({ ok: false, reason: "run_removed" });
  });

  it("a cross-ORG run row denies — the binding is stale or forged", async () => {
    const { mint } = harness({ readRun: async () => ({ ...RUN, orgId: "org-other" }) });
    expect(await mint(request())).toMatchObject({ ok: false, reason: "run_removed" });
  });

  it("a liveness READ ERROR keeps the recorded `alive` posture and still mints", async () => {
    const { mint, audits } = harness({
      livenessProbe: async () => {
        throw new Error("pg blip");
      },
    });
    const result = await mint(request());
    expect(result.ok).toBe(true);
    // …but the degraded observation is RECORDED, not collapsed into a healthy read.
    expect(audits[0]).toMatchObject({ decision: "minted", livenessDegraded: true });
  });

  it("a degraded liveness read does NOT soften the ceiling gate", async () => {
    const { mint, audits } = harness({
      livenessProbe: async () => {
        throw new Error("pg blip");
      },
      readRun: async () => ({ ...RUN, oboCeiling: null }),
    });
    expect(await mint(request())).toMatchObject({ ok: false, reason: "obo_ceiling_missing" });
    expect(audits[0]).toMatchObject({ denial: "obo_ceiling_missing", livenessDegraded: true });
  });

  it("`archived` is not `gone` — an archived run keeps executing (no mid-run re-gating)", async () => {
    const { mint } = harness({ livenessProbe: async () => "archived" });
    expect((await mint(request())).ok).toBe(true);
  });
});

describe("carrier + egress + signing failures", () => {
  it("a REJECTED carrier mints nothing and invents no org to audit it under", async () => {
    const { mint, audits } = harness();
    expect(await mint(request({ sessionCarrier: "v1.not-a-carrier" }))).toMatchObject({
      ok: false,
      reason: "carrier_rejected",
    });
    expect(audits).toHaveLength(0);
  });

  it("a TAMPERED carrier is rejected (identity comes from the carrier, never the caller)", async () => {
    const good = carrier();
    const [v, , sig] = good.split(".");
    const swapped = Buffer.from(
      JSON.stringify({ orgId: "org-victim", userId: "user-1", surface: "agent_run", runId: "run-1", iat: NOW, exp: NOW + 900_000 }),
      "utf8",
    ).toString("base64url");
    const { mint } = harness();
    expect(await mint(request({ sessionCarrier: `${v}.${swapped}.${sig}` }))).toMatchObject({
      ok: false,
      reason: "carrier_rejected",
    });
  });

  it("an UNRESOLVABLE egress policy denies rather than signing an unbounded one", async () => {
    const { mint, audits } = harness({
      resolveEgressPolicy: () => {
        throw new Error("settings store down");
      },
    });
    expect(await mint(request())).toMatchObject({ ok: false, reason: "egress_unavailable" });
    expect(audits[0]).toMatchObject({ denial: "egress_unavailable" });
  });

  it("a failing AUDIT SINK never turns a decision into an exception", async () => {
    const { mint } = harness({
      audit: () => {
        throw new Error("audit transport down");
      },
    });
    await expect(mint(request())).resolves.toMatchObject({ ok: true });
    const denying = createCommandVoucherMinter({
      aud: AUD,
      signer,
      livenessProbe: async () => "gone",
      readRun: async () => RUN,
      readTemplate: async () => TEMPLATE,
      resolveEgressPolicy: () => ({ mode: "none" }),
      audit: () => {
        throw new Error("audit transport down");
      },
      carrierSecret: SECRET,
      nowMs: () => NOW,
    });
    await expect(denying(request())).resolves.toMatchObject({ ok: false, reason: "run_removed" });
  });

  it("the signer refuses non-Ed25519 and public key material", () => {
    expect(() => createEd25519VoucherSigner(keypair.publicKey)).toThrow(VoucherSigningKeyError);
    expect(() => createEd25519VoucherSigner("not a pem")).toThrow(VoucherSigningKeyError);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() => createEd25519VoucherSigner(rsa.privateKey)).toThrow(/Ed25519/);
  });
});

describe("no owner / platform-admin short-circuit exists here", () => {
  it("a run whose OWN invoker is the run owner is still denied on a ceiling mismatch", async () => {
    // The strongest available statement of "the ceiling is enforced BEFORE any
    // owner/platform-admin bypass": there is no bypass to enforce before. The
    // module takes no actor, no role and no bypass flag, so ownership cannot
    // change the verdict — and this asserts the behaviour, not just the shape.
    const { mint } = harness({
      readRun: async () => ({
        ...RUN,
        runBy: "user-1", // the invoking user IS the run owner
        oboCeiling: [
          { tier: "user", id: "u-someone-else" },
          { tier: "organization", id: "org-1" },
        ],
      }),
    });
    expect(await mint(request())).toMatchObject({ ok: false, reason: "obo_ceiling_mismatch" });
  });

  it("resolves no session, role or admin flag at all (structural)", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "execution-voucher-mint.ts"),
      "utf8",
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const forbidden of [
      "getAuthSession",
      "isPlatformAdmin",
      "resolveOrgRoleForUser",
      "auth-session",
      "platform_admin",
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });
});

describe("mint ⇄ verify agree on the canonical bytes (both halves, real crypto)", () => {
  it("a minted voucher verifies under the broker's VERIFY-ONLY verifier", async () => {
    const { mint } = harness({
      resolveEgressPolicy: () => ({
        mode: "allowlist",
        allowlist: ["PyPI.org", "files.pypi.org"],
        maxBytesPerJob: 1_000,
      }),
    });
    const result = await mint(request());
    if (!result.ok) throw new Error("expected a voucher");

    const verifier = new ExecutionVoucherVerifier({
      publicKey: signer.publicKey,
      aud: AUD,
    });
    const verified = verifier.verify(result.voucher, {
      jobId: "job-1",
      command: COMMAND,
      session: { orgId: "org-1", userId: "user-1", surface: "agent_run", runId: "run-1" },
      nowMs: NOW + 1_000,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    // The policy survived canonicalization (normalized + sorted) intact.
    expect(verified.claims.egressPolicy).toEqual({
      mode: "allowlist",
      allowlist: ["files.pypi.org", "pypi.org"],
      maxBytesPerJob: 1_000,
    });
    // A second presentation is a replay at the broker, even though the mint site
    // would happily issue another voucher.
    expect(
      verifier.verify(result.voucher, {
        jobId: "job-1",
        command: COMMAND,
        session: { orgId: "org-1", userId: "user-1", surface: "agent_run", runId: "run-1" },
        nowMs: NOW + 1_000,
      }),
    ).toMatchObject({ ok: false, rejection: "replayed" });
  });

  it("a voucher minted for a DIFFERENT broker identity is worthless at this one", async () => {
    const { mint } = harness();
    const result = await mint(request());
    if (!result.ok) throw new Error("expected a voucher");
    const elsewhere = new ExecutionVoucherVerifier({
      publicKey: signer.publicKey,
      aud: "urn:cinatra:execution-broker:elsewhere",
    });
    expect(
      elsewhere.verify(result.voucher, {
        jobId: "job-1",
        command: COMMAND,
        session: { orgId: "org-1", userId: "user-1", surface: "agent_run", runId: "run-1" },
        nowMs: NOW + 1_000,
      }),
    ).toMatchObject({ ok: false, rejection: "wrong_audience" });
  });
});
