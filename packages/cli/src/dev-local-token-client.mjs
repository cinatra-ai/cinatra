/**
 * The CLIENT half of the development admin bypass contract.
 *
 * An instance running with `CINATRA_MCP_DEV_ADMIN_BYPASS=true` mints a random
 * credential once per boot and writes it `0600` into its data directory
 * (`CINATRA_DATA_DIR`, else `.cinatra/` beside the instance). A tool running as
 * the operator ON THAT MACHINE can read that file; nothing else can. Reading it
 * and presenting it in `x-cinatra-dev-local-token`, over a connection the
 * instance sees arriving from a loopback socket, is the whole of how a local
 * tool is admitted to `/api/cli/*` and `/api/mcp` without an OAuth dance.
 *
 * Nothing here is a trust decision — the instance decides, from the connecting
 * socket's peer address and its own minted credential (see
 * packages/mcp-server/src/dev-admin-bypass.ts). This module only holds up the
 * client's end of it, and holds it up carefully:
 *
 *   - THE CREDENTIAL NEVER LEAVES THIS MACHINE. It is attached only when the
 *     target URL is a loopback origin. Point a local tool at a remote instance
 *     and the credential is simply not sent, so a mistyped or hostile target
 *     cannot collect it.
 *   - NO FORWARDED HEADER IS EVER SENT. The instance refuses the bypass when
 *     any of them is present, so one on the request would only break the call;
 *     a caller-supplied one is stripped rather than passed through.
 *   - A MISSING FILE IS NOT AN ERROR. The request goes out without the
 *     credential and the instance answers as it would to any unauthenticated
 *     caller. Absent means absent, never a fallback.
 *
 * Plain ESM with no dependency on the instance's TypeScript sources, because a
 * CLI runs on bare node. The constants below are pinned to the instance's own
 * exported constants by
 * `src/__tests__/dev-local-token-client.test.mjs`, so the two halves cannot
 * drift apart in separate edits.
 *
 * The published `cinatra` CLI ships from its own package and adopts this
 * contract there; this module is the in-repo implementation of it and the
 * client used by the round-trip suite.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

/** The header the credential is presented in. */
export const DEV_LOCAL_TOKEN_HEADER = "x-cinatra-dev-local-token";

/** The credential's file name inside the instance data directory. */
export const DEV_LOCAL_TOKEN_FILENAME = "dev-admin-bypass.token";

/**
 * Forwarded headers the instance refuses the bypass on. A local client sends
 * none of them and strips any the caller supplied.
 */
export const FORWARDED_HEADER_NAMES = Object.freeze([
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "forwarded",
]);

/** The instance data directory: `CINATRA_DATA_DIR`, else `.cinatra/` beside the instance. */
export function resolveInstanceDataDir(env = process.env) {
  const configured = env.CINATRA_DATA_DIR?.trim();
  if (configured) return path.resolve(configured);
  return path.join(process.cwd(), ".cinatra");
}

/** Absolute path of the credential file. */
export function devLocalTokenPath(env = process.env) {
  return path.join(resolveInstanceDataDir(env), DEV_LOCAL_TOKEN_FILENAME);
}

/**
 * The credential this machine's running instance minted, or null when there is
 * none to read — no instance booted with the bypass on, or this process is not
 * the operating-system user that may read the file.
 */
export function readDevLocalToken(env = process.env) {
  try {
    const raw = readFileSync(devLocalTokenPath(env), "utf8").trim();
    return raw === "" ? null : raw;
  } catch {
    return null;
  }
}

/**
 * True when a target URL names this machine. The client's own leak guard, not
 * a trust signal: it decides whether the credential may be attached, never
 * whether a caller is admitted.
 */
export function isLoopbackTargetUrl(target) {
  let hostname;
  try {
    hostname = new URL(target).hostname;
  } catch {
    return false;
  }
  let host = hostname.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "localhost") return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (host.startsWith("::ffff:")) host = host.slice("::ffff:".length);
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * The credential header for a target, or an empty object when the credential
 * must not be sent (a non-loopback target) or cannot be read.
 */
export function devLocalRequestHeaders(target, env = process.env) {
  if (!isLoopbackTargetUrl(target)) return {};
  const token = readDevLocalToken(env);
  return token ? { [DEV_LOCAL_TOKEN_HEADER]: token } : {};
}

/**
 * `fetch` against the instance on this machine, carrying this boot's
 * credential. Everything else about the request is the caller's.
 */
export async function fetchLocalInstance(
  target,
  init = {},
  { env = process.env, fetchImpl = fetch } = {},
) {
  const headers = new Headers(init.headers ?? {});
  for (const name of FORWARDED_HEADER_NAMES) headers.delete(name);
  for (const [name, value] of Object.entries(devLocalRequestHeaders(target, env))) {
    headers.set(name, value);
  }
  return fetchImpl(target, { ...init, headers });
}
