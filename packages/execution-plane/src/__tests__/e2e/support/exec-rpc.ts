/**
 * Raw wire drivers for the service-boundary E2E battery (exec-plane L5, epic
 * cinatra#1705).
 *
 * `ExecRpcClient` is the SHIPPED client, and the battery uses it for every
 * positive path — that is the point: the app's real code, over a real socket, to
 * a real broker. But a shipped client cannot express the negative arms. It
 * always presents a well-formed credential, always sends its own protocol
 * version and always attaches its token, so "no client certificate", "protocol
 * version 2" and "valid certificate, wrong token" are unreachable through it.
 *
 * `rawExecRpc` is therefore a deliberately DUMB caller: whatever bytes and
 * whatever credential you give it, over real TLS. It stubs nothing — the
 * handshake, the CA verification and the server's decision are all the real
 * ones; it simply declines to be helpful.
 *
 * `workerRpcFromInternalNetwork` reaches the worker, which by design publishes
 * no port and lives on an `internal: true` network with no route to the host. A
 * throwaway `node:24-alpine` container attached to that same network carries the
 * request in. That container is infrastructure for the probe, not a sandbox, and
 * it is removed the moment the call returns.
 */

import * as https from "node:https";
import { randomUUID, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  assembleVoucher,
  commandDigest,
  encodeVoucherBody,
  voucherSigningInput,
  type ExecutionVoucherClaims,
} from "../../../authz/voucher";
import {
  EXEC_PROTOCOL_HEADER,
  EXEC_PROTOCOL_VERSION,
  EXEC_RPC_PATH,
  EXEC_SERVICE_TOKEN_HEADER,
} from "../../../service/protocol";
import { INTERNAL_NETWORK, WORKER_SERVICE, run, type ExecStack } from "./exec-stack";

// ---------------------------------------------------------------------------
// Raw mTLS RPC
// ---------------------------------------------------------------------------

export type RawRpcOptions = {
  host: string;
  port: number;
  /** CA the CLIENT verifies the server against. */
  ca: string;
  /** Client credential. Omit BOTH to present no client certificate at all. */
  cert?: string;
  key?: string;
  /** Service token header; omit to send none. */
  token?: string;
  /** Wire version in the BODY. Defaults to this build's. */
  protocolVersion?: number;
  /** Redundant transport echo. Defaults to the body's value; `null` omits it. */
  protocolHeader?: string | null;
  op?: string;
  payload?: unknown;
  /** Send this exact body instead of a well-formed envelope. */
  rawBody?: string;
  method?: string;
  routePath?: string;
  timeoutMs?: number;
};

export type RawRpcResult =
  | { kind: "answered"; status: number; body: unknown; text: string }
  /** No answer at all — a refused handshake is exactly this shape. */
  | { kind: "transport"; error: string };

export function rawExecRpc(options: RawRpcOptions): Promise<RawRpcResult> {
  const version = options.protocolVersion ?? EXEC_PROTOCOL_VERSION;
  const body =
    options.rawBody ??
    JSON.stringify({
      protocolVersion: version,
      op: options.op ?? "health",
      payload: options.payload ?? {},
    });
  const headerValue =
    options.protocolHeader === null
      ? undefined
      : (options.protocolHeader ?? String(version));
  return new Promise((resolve) => {
    const request = https.request(
      {
        host: options.host,
        port: options.port,
        method: options.method ?? "POST",
        path: options.routePath ?? EXEC_RPC_PATH,
        ca: options.ca,
        ...(options.cert && options.key ? { cert: options.cert, key: options.key } : {}),
        rejectUnauthorized: true,
        minVersion: "TLSv1.3",
        // The hostname is never the identity here (services are reached by
        // container name or loopback); the SERVER's role is checked by the
        // battery itself where that is the assertion under test.
        checkServerIdentity: () => undefined,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...(options.token ? { [EXEC_SERVICE_TOKEN_HEADER]: options.token } : {}),
          ...(headerValue === undefined ? {} : { [EXEC_PROTOCOL_HEADER]: headerValue }),
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () => {
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = null;
          }
          resolve({ kind: "answered", status: response.statusCode ?? 0, body: parsed, text });
        });
        response.on("error", (err: Error) =>
          resolve({ kind: "transport", error: err.message }),
        );
      },
    );
    request.setTimeout(options.timeoutMs ?? 30_000, () => {
      request.destroy(new Error("raw RPC timed out"));
    });
    request.on("error", (err: Error) => resolve({ kind: "transport", error: err.message }));
    request.end(body);
  });
}

/** The `{ code }` of a structured refusal, or null when it was not one. */
export function refusalCode(result: RawRpcResult): string | null {
  if (result.kind !== "answered") return null;
  const body = result.body as { ok?: boolean; error?: { code?: unknown } } | null;
  if (!body || body.ok !== false || typeof body.error?.code !== "string") return null;
  return body.error.code;
}

// ---------------------------------------------------------------------------
// Vouchers
// ---------------------------------------------------------------------------

export type VoucherInput = {
  jobId: string;
  command: string;
  orgId: string;
  userId: string;
  surface: string;
  runId?: string;
  aud?: string;
  commandId?: string;
  nonce?: string;
  iat?: number;
  exp?: number;
  egressPolicy?: ExecutionVoucherClaims["egressPolicy"];
  /** Digest override — the command-hash-mismatch arm. */
  commandSha256?: string;
  /** Sign with a key the broker does not trust — the forgery arm. */
  signWith?: KeyObject;
};

/**
 * Mint one voucher with the package's OWN canonical serializer.
 *
 * The signing half genuinely lives outside the broker (`authz/voucher.ts` holds
 * verify-only material and cannot mint), so this is what an app-side mint site
 * does — real Ed25519 over the real canonical bytes. A fixture that hand-rolled
 * the encoding would prove nothing about the signature the broker checks.
 */
export function mintVoucher(stack: ExecStack, input: VoucherInput): string {
  const iat = input.iat ?? Date.now();
  const claims: ExecutionVoucherClaims = {
    aud: input.aud ?? stack.aud,
    jobId: input.jobId,
    orgId: input.orgId,
    userId: input.userId,
    surface: input.surface,
    ...(input.runId ? { runId: input.runId } : {}),
    commandSha256: input.commandSha256 ?? commandDigest(input.command),
    commandId: input.commandId ?? randomUUID(),
    egressPolicy: input.egressPolicy ?? { mode: "none" },
    nonce: input.nonce ?? randomUUID(),
    iat,
    exp: input.exp ?? iat + 30_000,
  };
  const body = encodeVoucherBody(claims);
  const signature = sign(
    null,
    Buffer.from(voucherSigningInput(body), "utf8"),
    input.signWith ?? stack.voucherPrivateKey,
  );
  return assembleVoucher(body, signature.toString("base64url"));
}

// ---------------------------------------------------------------------------
// Reaching the worker, which has no published port by design
// ---------------------------------------------------------------------------

const PROBE_SCRIPT = String.raw`
const https = require("node:https");
const fs = require("node:fs");
const spec = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const body = Buffer.from(spec.body, "utf8");
const headers = { "content-type": "application/json", "content-length": body.length };
if (spec.token) headers["x-cinatra-exec-service-token"] = spec.token;
if (spec.protocolHeader !== null) headers["x-cinatra-exec-protocol"] = spec.protocolHeader;
const req = https.request(
  {
    host: spec.host,
    port: spec.port,
    method: "POST",
    path: spec.path,
    ca: spec.ca,
    ...(spec.cert && spec.key ? { cert: spec.cert, key: spec.key } : {}),
    rejectUnauthorized: true,
    minVersion: "TLSv1.3",
    checkServerIdentity: () => undefined,
    headers,
  },
  (res) => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", (c) => (text += c));
    res.on("end", () => {
      process.stdout.write(JSON.stringify({ kind: "answered", status: res.statusCode, text }));
    });
  },
);
req.setTimeout(30000, () => req.destroy(new Error("probe timed out")));
req.on("error", (e) =>
  process.stdout.write(JSON.stringify({ kind: "transport", error: String(e && e.message) })),
);
req.end(body);
`;

export type WorkerProbeOptions = {
  cert?: string;
  key?: string;
  ca?: string;
  token?: string;
  protocolVersion?: number;
  protocolHeader?: string | null;
  op?: string;
  payload?: unknown;
  rawBody?: string;
};

/**
 * Perform one mTLS RPC against the worker from INSIDE the internal sandbox
 * network. The worker publishes no port and its network has no route out — that
 * is the topology under test, not an obstacle to route around, so the probe
 * joins the network rather than the network being opened up.
 */
export async function workerRpcFromInternalNetwork(
  stack: ExecStack,
  options: WorkerProbeOptions,
): Promise<RawRpcResult> {
  const version = options.protocolVersion ?? EXEC_PROTOCOL_VERSION;
  const dir = mkdtempSync(path.join(os.tmpdir(), "cinatra-exec-l5-probe-"));
  try {
    writeFileSync(path.join(dir, "probe.cjs"), PROBE_SCRIPT);
    writeFileSync(
      path.join(dir, "spec.json"),
      JSON.stringify({
        host: WORKER_SERVICE,
        port: 4200,
        path: EXEC_RPC_PATH,
        ca: options.ca ?? stack.ca.certPem,
        cert: options.cert ?? null,
        key: options.key ?? null,
        token: options.token ?? null,
        protocolHeader:
          options.protocolHeader === null
            ? null
            : (options.protocolHeader ?? String(version)),
        body:
          options.rawBody ??
          JSON.stringify({
            protocolVersion: version,
            op: options.op ?? "removeWorkspace",
            payload: options.payload ?? {},
          }),
      }),
    );
    const outcome = await run(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        INTERNAL_NETWORK,
        "-v",
        `${dir}:/probe:ro`,
        "node:24-alpine",
        "node",
        "/probe/probe.cjs",
        "/probe/spec.json",
      ],
      { timeoutMs: 120_000 },
    );
    if (outcome.exitCode !== 0 && outcome.stdout.trim().length === 0) {
      return {
        kind: "transport",
        error: `worker probe container failed: ${outcome.stderr.trim()}`,
      };
    }
    const parsed = JSON.parse(outcome.stdout.trim()) as
      | { kind: "answered"; status: number; text: string }
      | { kind: "transport"; error: string };
    if (parsed.kind === "transport") return parsed;
    let body: unknown = null;
    try {
      body = JSON.parse(parsed.text);
    } catch {
      body = null;
    }
    return { kind: "answered", status: parsed.status, body, text: parsed.text };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
