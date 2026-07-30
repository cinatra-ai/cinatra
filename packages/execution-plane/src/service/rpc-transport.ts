/**
 * Execution-plane RPC transport (exec-plane S1 remainder, epic cinatra#1705).
 *
 * The one HTTP/mTLS plumbing layer both services share, so the broker and the
 * worker cannot drift on how a request is authorized. Everything
 * protocol-specific lives in `protocol.ts`, everything identity-specific in
 * `mtls.ts`; this module only sequences them:
 *
 *   1. mTLS peer identity       → 403         (FIRST factor — URI SAN + EKU)
 *   2. service token            → 401         (SECOND factor, timing-safe)
 *   3. method + path            → 405 / 404   (one route, nothing incidental)
 *   4. protocol-version header  → 400         (redundant echo cross-check)
 *   5. bounded body + JSON      → 413 / 400
 *   6. dispatch                 → the service's own handler
 *
 * The order is deliberate: BOTH authorization factors are settled before this
 * service will do anything else at all — before it splits a URL, before it
 * decides whether a route exists, and above all before it reads a byte of body.
 * An unauthorized peer therefore cannot make the service allocate, and cannot
 * probe which routes exist (it gets the same 403 everywhere, never a 404/405 that
 * would map the surface). Both factors are checked on EVERY request — there is no
 * session, no cookie and no "already authenticated this socket" shortcut.
 *
 * Dependency-free: `node:https`, `node:http`, `node:tls`.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import * as https from "node:https";
import type { TLSSocket } from "node:tls";

import { verifyServiceToken } from "../broker";
import {
  EXEC_DEFAULT_MAX_BODY_BYTES,
  EXEC_ERROR_STATUS,
  EXEC_PROTOCOL_HEADER,
  EXEC_PROTOCOL_VERSION,
  EXEC_RPC_PATH,
  EXEC_SERVICE_TOKEN_HEADER,
  checkProtocolHeader,
  execErrorResponse,
  execRequestEnvelope,
  type ExecErrorBody,
  type ExecErrorCode,
  type ExecResponseEnvelope,
} from "./protocol";
import {
  authorizeServiceClient,
  execClientTlsOptions,
  type ExecClientRole,
  type ExecClientTlsConfig,
  type ExecPeerCertificate,
} from "./mtls";

// ---------------------------------------------------------------------------
// Server side
// ---------------------------------------------------------------------------

/**
 * Describe ANY throwable as a string, including `throw null` and hostile
 * throwables (a Proxy with a throwing `getPrototypeOf` trap, a throwing `message`
 * getter). Shared by both services because `(err as Error).message` on a
 * non-Error throw throws AGAIN — and in the services' catch blocks that second
 * throw would skip the ledger write and leave a command id claimed forever.
 * Mirrors `executor.ts`'s `describeThrown` for the same reason.
 */
export function describeThrown(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "unknown error";
  }
}

/** What an authorized request knows about its caller. */
export type ExecRpcContext = {
  /** The byte-exact URI SAN the peer authenticated as. */
  peerUri: string;
};

export type ExecRpcReply = {
  status: number;
  body: ExecResponseEnvelope<unknown>;
};

/** A service's own dispatcher: parsed JSON body in, reply out. Never throws. */
export type ExecRpcDispatch = (raw: unknown, ctx: ExecRpcContext) => Promise<ExecRpcReply>;

export type ExecRpcListenerConfig = {
  instance: string;
  /** The ONE client role this endpoint accepts. */
  peerRole: ExecClientRole;
  /** Expected service token (the independent second factor). */
  serviceToken: string;
  dispatch: ExecRpcDispatch;
  maxBodyBytes?: number;
  /** Structured refusal log hook; receives NO secret values. */
  onRefusal?: (entry: { code: ExecErrorCode; message: string; peerUri?: string }) => void;
};

function reply(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    [EXEC_PROTOCOL_HEADER]: String(EXEC_PROTOCOL_VERSION),
  });
  res.end(payload);
}

function refuse(
  res: ServerResponse,
  code: ExecErrorCode,
  message: string,
  config: ExecRpcListenerConfig,
  peerUri?: string,
): void {
  config.onRefusal?.({ code, message, ...(peerUri ? { peerUri } : {}) });
  reply(res, EXEC_ERROR_STATUS[code], execErrorResponse(code, message));
}

/** Read at most `maxBytes`; anything larger is refused without buffering more. */
function readBoundedBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; code: ExecErrorCode; message: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (
      value: { ok: true; text: string } | { ok: false; code: ExecErrorCode; message: string },
    ): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        finish({
          ok: false,
          code: "payload_too_large",
          message: `The request body exceeded the ${maxBytes}-byte ceiling; refused.`,
        });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish({ ok: true, text: Buffer.concat(chunks).toString("utf8") }));
    req.on("error", (err: Error) =>
      finish({
        ok: false,
        code: "malformed_request",
        message: `The request body could not be read: ${err.message}`,
      }),
    );
  });
}

/**
 * Build the request listener for an execution-plane service. The returned
 * function is what `https.createServer(tlsOptions, listener)` takes — and it is
 * the ONLY place either service authorizes a caller.
 */
export function createExecRpcListener(
  config: ExecRpcListenerConfig,
): (req: IncomingMessage, res: ServerResponse) => void {
  const maxBodyBytes = config.maxBodyBytes ?? EXEC_DEFAULT_MAX_BODY_BYTES;
  return (req: IncomingMessage, res: ServerResponse): void => {
    void (async (): Promise<void> => {
      try {
        // FACTOR 1 — mTLS identity. A non-TLS socket is refused here, so the
        // service can never be served over plaintext by misconfiguration.
        const socket = req.socket as TLSSocket & {
          authorized?: boolean;
          getPeerCertificate?: (detailed?: boolean) => ExecPeerCertificate;
        };
        if (typeof socket.getPeerCertificate !== "function") {
          refuse(
            res,
            "unauthorized_peer",
            "The connection is not mutually-authenticated TLS; refused (fail-closed).",
            config,
          );
          return;
        }
        if (socket.authorized !== true) {
          refuse(
            res,
            "unauthorized_peer",
            "The peer certificate did not verify against the configured CA; refused.",
            config,
          );
          return;
        }
        const peer = authorizeServiceClient(socket.getPeerCertificate(), {
          instance: config.instance,
          peerRole: config.peerRole,
        });
        if (!peer.ok) {
          refuse(res, "unauthorized_peer", peer.message, config);
          return;
        }

        // FACTOR 2 — the independently-scoped service token. Both must pass;
        // neither substitutes for the other.
        const provided = req.headers[EXEC_SERVICE_TOKEN_HEADER];
        const token = Array.isArray(provided) ? provided[0] : provided;
        if (!verifyServiceToken(token, config.serviceToken)) {
          refuse(
            res,
            "unauthorized_token",
            `A valid ${EXEC_SERVICE_TOKEN_HEADER} is required in addition to the client ` +
              `certificate; the two factors are independent and both are enforced.`,
            config,
            peer.uri,
          );
          return;
        }

        // Only now — with both factors settled — does the service look at what
        // was actually asked for. An unauthorized peer never gets this far, so it
        // learns nothing about which methods or routes exist.
        if (req.method !== "POST") {
          reply(res, 405, execErrorResponse("malformed_request", "Only POST is served."));
          return;
        }
        const path = (req.url ?? "").split("?")[0];
        if (path !== EXEC_RPC_PATH) {
          reply(
            res,
            404,
            execErrorResponse("malformed_request", `No such route; the RPC route is ${EXEC_RPC_PATH}.`),
          );
          return;
        }

        const headerValue = req.headers[EXEC_PROTOCOL_HEADER];
        const header = Array.isArray(headerValue) ? headerValue[0] : headerValue;
        const headerCheck = checkProtocolHeader(header);
        if (!headerCheck.ok) {
          refuse(res, headerCheck.code, headerCheck.message, config, peer.uri);
          return;
        }

        const body = await readBoundedBody(req, maxBodyBytes);
        if (!body.ok) {
          refuse(res, body.code, body.message, config, peer.uri);
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.text) as unknown;
        } catch {
          refuse(res, "malformed_request", "The request body is not valid JSON.", config, peer.uri);
          return;
        }

        const outcome = await config.dispatch(parsed, { peerUri: peer.uri });
        reply(res, outcome.status, outcome.body);
      } catch (err) {
        // A listener must never leave a socket hanging, and must never leak an
        // internal stack to a peer.
        try {
          config.onRefusal?.({
            code: "internal_error",
            message: `Unhandled service error: ${describeThrown(err)}`,
          });
          reply(
            res,
            500,
            execErrorResponse("internal_error", "The service failed to handle the request."),
          );
        } catch {
          res.destroy();
        }
      }
    })();
  };
}

// ---------------------------------------------------------------------------
// Client side
// ---------------------------------------------------------------------------

export type ExecRpcCallResult<Result> =
  | { ok: true; result: Result }
  /**
   * `kind: "service"` — the peer answered with a structured refusal (our own
   * vocabulary). `kind: "transport"` — the call never produced an answer
   * (connect/TLS/timeout/parse). The distinction is load-bearing: a service
   * refusal is a DECISION and must not be retried blindly, while a transport
   * failure is exactly the case `command-ledger.ts` exists for.
   */
  | { ok: false; kind: "service" | "transport"; error: ExecErrorBody };

export type ExecRpcClientConfig = {
  /** Base origin of the peer service, e.g. `https://cinatra-exec-broker:4100`. */
  baseUrl: string;
  serviceToken: string;
  tls: ExecClientTlsConfig;
  /** Per-call wall-clock ceiling. */
  requestTimeoutMs?: number;
  /** Response body ceiling — a peer cannot make this client allocate forever. */
  maxResponseBytes?: number;
};

export const EXEC_DEFAULT_REQUEST_TIMEOUT_MS = 180_000;

/**
 * The mTLS RPC client. One keep-alive agent per instance (TLS handshakes are
 * expensive and these are hot paths); `close()` frees it.
 */
export class ExecRpcClient {
  private readonly agent: https.Agent;
  private readonly origin: URL;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly config: ExecRpcClientConfig) {
    this.origin = new URL(config.baseUrl);
    if (this.origin.protocol !== "https:") {
      throw new Error(
        `Refusing an execution-plane service URL that is not https: "${config.baseUrl}" ` +
          `(the service boundary is mutually-authenticated TLS; fail-closed).`,
      );
    }
    this.timeoutMs = config.requestTimeoutMs ?? EXEC_DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxResponseBytes = config.maxResponseBytes ?? EXEC_DEFAULT_MAX_BODY_BYTES;
    this.agent = new https.Agent({
      keepAlive: true,
      ...execClientTlsOptions(config.tls),
    });
  }

  /** The identity this client presents (diagnostics; never a secret). */
  get peerRole(): string {
    return this.config.tls.peerRole;
  }

  close(): void {
    this.agent.destroy();
  }

  async call<Result>(op: string, payload: unknown): Promise<ExecRpcCallResult<Result>> {
    const body = Buffer.from(JSON.stringify(execRequestEnvelope(op, payload)), "utf8");
    let raw: { status: number; text: string };
    try {
      raw = await this.send(body);
    } catch (err) {
      return {
        ok: false,
        kind: "transport",
        error: {
          code: "internal_error",
          message: `The execution-plane service call "${op}" did not complete: ${describeThrown(err)}`,
        },
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.text) as unknown;
    } catch {
      return {
        ok: false,
        kind: "transport",
        error: {
          code: "internal_error",
          message: `The execution-plane service answered "${op}" with a non-JSON body (status ${raw.status}).`,
        },
      };
    }
    const envelope = parsed as ExecResponseEnvelope<Result>;
    if (envelope && typeof envelope === "object" && envelope.ok === true) {
      return { ok: true, result: envelope.result };
    }
    if (
      envelope &&
      typeof envelope === "object" &&
      envelope.ok === false &&
      envelope.error &&
      typeof envelope.error.code === "string"
    ) {
      return { ok: false, kind: "service", error: envelope.error };
    }
    return {
      ok: false,
      kind: "transport",
      error: {
        code: "internal_error",
        message: `The execution-plane service answered "${op}" with an unrecognized envelope (status ${raw.status}).`,
      },
    };
  }

  private send(body: Buffer): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const request = https.request(
        {
          agent: this.agent,
          protocol: this.origin.protocol,
          hostname: this.origin.hostname,
          ...(this.origin.port ? { port: Number(this.origin.port) } : {}),
          method: "POST",
          path: EXEC_RPC_PATH,
          headers: {
            "content-type": "application/json",
            "content-length": body.length,
            [EXEC_SERVICE_TOKEN_HEADER]: this.config.serviceToken,
            [EXEC_PROTOCOL_HEADER]: String(EXEC_PROTOCOL_VERSION),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let total = 0;
          response.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > this.maxResponseBytes) {
              response.destroy();
              reject(
                new Error(
                  `the response exceeded the ${this.maxResponseBytes}-byte ceiling`,
                ),
              );
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              text: Buffer.concat(chunks).toString("utf8"),
            }),
          );
          response.on("error", reject);
        },
      );
      request.setTimeout(this.timeoutMs, () => {
        request.destroy(new Error(`the call exceeded the ${this.timeoutMs} ms ceiling`));
      });
      request.on("error", reject);
      request.end(body);
    });
  }
}
