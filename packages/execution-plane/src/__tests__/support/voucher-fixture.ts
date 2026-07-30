/**
 * Shared per-command voucher fixture for the broker/executor suites.
 *
 * REAL Ed25519 throughout — a fresh keypair per process, real detached
 * signatures over the package's own canonical serialization. Nothing here stubs
 * the crypto: a test that "passes" against a fake signature proves nothing about
 * an authorization boundary. The SIGN half lives here (and in the app layer)
 * because `authz/voucher.ts` deliberately cannot sign.
 *
 * Not a `*.test.ts` file, so vitest does not collect it as a suite.
 */

import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";

import { openSealedSession } from "@cinatra-ai/llm/execution-plane";

import {
  assembleVoucher,
  commandDigest,
  encodeVoucherBody,
  ExecutionVoucherVerifier,
  voucherSigningInput,
  type ExecutionVoucherClaims,
} from "../../authz/voucher";
import type { ExecutionBroker } from "../../broker";
import type { CommandVoucherMinter } from "../../executor";
import type { EgressPolicy } from "../../types";

export const TEST_BROKER_AUD = "urn:cinatra:execution-broker:test";
export const TEST_VOUCHER_TTL_MS = 30_000;

const pair = generateKeyPairSync("ed25519");
export const TEST_VOUCHER_PRIVATE_KEY: KeyObject = pair.privateKey;
export const TEST_VOUCHER_PUBLIC_KEY: KeyObject = pair.publicKey;

/** An unrelated keypair — used to forge a well-formed but untrusted voucher. */
const foreign = generateKeyPairSync("ed25519");
export const FOREIGN_VOUCHER_PRIVATE_KEY: KeyObject = foreign.privateKey;

export type VoucherOverrides = Partial<ExecutionVoucherClaims> & {
  /** Sign with a key the broker does not trust. */
  signWith?: KeyObject;
};

/** Sign an explicit claim set with the (by default trusted) test key. */
export function signVoucher(
  claims: ExecutionVoucherClaims,
  key: KeyObject = TEST_VOUCHER_PRIVATE_KEY,
): string {
  const body = encodeVoucherBody(claims);
  const signature = sign(null, Buffer.from(voucherSigningInput(body), "utf8"), key);
  return assembleVoucher(body, signature.toString("base64url"));
}

export function claimsFor(
  jobId: string,
  command: string,
  over: VoucherOverrides = {},
): ExecutionVoucherClaims {
  const iat = over.iat ?? Date.now();
  const claims: ExecutionVoucherClaims = {
    aud: over.aud ?? TEST_BROKER_AUD,
    jobId,
    orgId: over.orgId ?? "org-1",
    userId: over.userId ?? "user-1",
    surface: over.surface ?? "agent_run",
    commandSha256: over.commandSha256 ?? commandDigest(command),
    commandId: over.commandId ?? randomUUID(),
    egressPolicy: over.egressPolicy ?? { mode: "none" },
    nonce: over.nonce ?? randomUUID(),
    iat,
    exp: over.exp ?? iat + TEST_VOUCHER_TTL_MS,
  };
  // `runId: undefined` in an override means "no run binding" — distinguishable
  // from an absent key, which means "keep the default".
  const runId = "runId" in over ? over.runId : "run-1";
  if (runId) claims.runId = runId;
  return claims;
}

/** The convenience form the broker suites use: one signed voucher per command. */
export function voucherFor(
  jobId: string,
  command: string,
  over: VoucherOverrides = {},
): string {
  return signVoucher(claimsFor(jobId, command, over), over.signWith ?? TEST_VOUCHER_PRIVATE_KEY);
}

// ---------------------------------------------------------------------------
// Job-session registry
//
// A voucher is bound to the OPEN JOB's session, so a suite that opens jobs for
// several runs needs the right identity per job. Rather than restate it at every
// call site (where it would silently rot), `openVouched` records the session it
// just opened and `execVouched` looks it up.
// ---------------------------------------------------------------------------

type VoucherSession = { orgId: string; userId: string; surface: string; runId?: string };

const jobSessions = new Map<string, VoucherSession>();

/**
 * Per-broker default egress policy for minted vouchers.
 *
 * Since the voucher now CARRIES the policy the mint site resolved, a suite that
 * used to configure a tier through `egressPolicyResolver` must put that tier in
 * the voucher instead — that is the behavioural change under test. Registering it
 * once per broker keeps every existing call site intact and, more importantly,
 * keeps the tier in ONE place per suite instead of restated per command.
 */
const brokerPolicies = new WeakMap<object, EgressPolicy>();

export function rememberBrokerPolicy(broker: object, policy: EgressPolicy): void {
  brokerPolicies.set(broker, policy);
}

/** Open a job AND remember the session it was opened under. */
export async function openVouched(
  broker: ExecutionBroker,
  carrier: string,
  opts?: Parameters<ExecutionBroker["openJob"]>[1],
): Promise<Awaited<ReturnType<ExecutionBroker["openJob"]>>> {
  const result = await broker.openJob(carrier, opts);
  if (result.ok) {
    const opened = openSealedSession(carrier);
    if (opened.ok) {
      jobSessions.set(result.jobId, {
        orgId: opened.session.orgId,
        userId: opened.session.userId,
        surface: opened.session.surface,
        ...(opened.session.runId ? { runId: opened.session.runId } : {}),
      });
    }
  }
  return result;
}

/** Mint a voucher for this job's recorded session and submit the command. */
export function execVouched(
  broker: ExecutionBroker,
  jobId: string,
  command: string,
  over: VoucherOverrides = {},
): Promise<Awaited<ReturnType<ExecutionBroker["exec"]>>> {
  const session = jobSessions.get(jobId);
  const policy = brokerPolicies.get(broker);
  return broker.exec(
    jobId,
    command,
    voucherFor(jobId, command, {
      ...(policy ? { egressPolicy: policy } : {}),
      ...(session
        ? {
            orgId: session.orgId,
            userId: session.userId,
            surface: session.surface,
            runId: session.runId,
          }
        : {}),
      ...over,
    }),
  );
}

export function makeVerifier(
  over: Partial<{ aud: string; skewMs: number; nonceCapacity: number }> = {},
): ExecutionVoucherVerifier {
  return new ExecutionVoucherVerifier({
    publicKey: TEST_VOUCHER_PUBLIC_KEY,
    aud: over.aud ?? TEST_BROKER_AUD,
    ...(over.skewMs !== undefined ? { skewMs: over.skewMs } : {}),
    ...(over.nonceCapacity !== undefined ? { nonceCapacity: over.nonceCapacity } : {}),
  });
}

/**
 * A REAL minter for the executor suites: it opens the sealed carrier exactly as
 * the app-layer mint site does, so the voucher's identity is the carrier's
 * identity and the session-binding check is genuinely exercised.
 */
export function testMinter(
  opts: {
    carrierSecret?: string;
    egressPolicy?: EgressPolicy;
    ttlMs?: number;
    nowMs?: () => number;
    /** Fail the mint (exercises the executor's structured-refusal path). */
    deny?: { reason: string; message: string };
    onMint?: (input: { commandId: string; nonce?: string; command: string }) => void;
  } = {},
): CommandVoucherMinter {
  return async (input) => {
    opts.onMint?.({ commandId: input.commandId, command: input.command, ...(input.nonce ? { nonce: input.nonce } : {}) });
    if (opts.deny) return { ok: false, ...opts.deny };
    const opened = openSealedSession(input.sessionCarrier, {
      ...(opts.carrierSecret ? { secret: opts.carrierSecret } : {}),
    });
    if (!opened.ok) {
      return { ok: false, reason: "carrier_rejected", message: opened.reason };
    }
    const iat = opts.nowMs?.() ?? Date.now();
    return {
      ok: true,
      voucher: signVoucher({
        aud: TEST_BROKER_AUD,
        jobId: input.jobId,
        orgId: opened.session.orgId,
        userId: opened.session.userId,
        surface: opened.session.surface,
        ...(opened.session.runId ? { runId: opened.session.runId } : {}),
        commandSha256: commandDigest(input.command),
        commandId: input.commandId,
        egressPolicy: opts.egressPolicy ?? { mode: "none" },
        nonce: input.nonce ?? randomUUID(),
        iat,
        exp: iat + (opts.ttlMs ?? TEST_VOUCHER_TTL_MS),
      }),
    };
  };
}
