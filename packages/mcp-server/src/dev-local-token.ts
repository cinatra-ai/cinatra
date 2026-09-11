/**
 * The per-boot local credential for the development admin bypass.
 *
 * A random token is minted ONCE per process at boot and written `0600` into the
 * instance data directory. A caller proves it is running as the operator on
 * this machine by reading that file and presenting the token in
 * `x-cinatra-dev-local-token`; a caller that cannot read the file cannot
 * present it, whatever headers it writes.
 *
 * UNSET MEANS OFF. Minting happens only under a non-production build with
 * `CINATRA_MCP_DEV_ADMIN_BYPASS=true`. When nothing was minted,
 * `expectedDevLocalToken()` returns null and the trust decision refuses — there
 * is no fallback credential and no header-derived substitute.
 *
 * THE DATA DIRECTORY is `CINATRA_DATA_DIR` when set, else `.cinatra/` beside
 * the running instance. The directory is created `0700` and the token file
 * `0600`, so the credential is readable by this operating-system user alone.
 *
 * THE CLIENT SIDE of this contract — locating the file, reading it, and
 * presenting the header only to a loopback target — is
 * `packages/cli/src/dev-local-token-client.mjs`.
 *
 * The token is held in a `globalThis` slot keyed by a registered symbol so a
 * bundler that emits more than one copy of this module still sees ONE minted
 * value per process.
 */

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

/** File name of the credential inside the instance data directory. */
export const DEV_LOCAL_TOKEN_FILENAME = "dev-admin-bypass.token";

/** Bytes of entropy in a minted credential (rendered as hex, so 64 chars). */
export const DEV_LOCAL_TOKEN_BYTES = 32;

type TokenSlot = { token: string | null };

const SLOT_KEY = Symbol.for("cinatra.mcp-server.dev-local-token");

function tokenSlot(): TokenSlot {
  const registry = globalThis as unknown as Record<symbol, TokenSlot | undefined>;
  let slot = registry[SLOT_KEY];
  if (!slot) {
    slot = { token: null };
    registry[SLOT_KEY] = slot;
  }
  return slot;
}

/** The instance data directory: `CINATRA_DATA_DIR`, else `.cinatra/` beside the instance. */
export function resolveInstanceDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CINATRA_DATA_DIR?.trim();
  if (configured) return path.resolve(configured);
  return path.join(process.cwd(), ".cinatra");
}

/** Absolute path of the credential file. */
export function devLocalTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveInstanceDataDir(env), DEV_LOCAL_TOKEN_FILENAME);
}

/**
 * Mint the per-boot credential and write it `0600`. Idempotent per process:
 * a second call returns the value already minted. Returns null (and writes
 * nothing) in a production build or when the opt-in flag is not `"true"` — the
 * bypass is off, so there is no credential to hold.
 *
 * A previous boot's file is REPLACED, never appended to or reused: the
 * credential is per boot, so a stale file must never authorize a live process.
 */
export function mintDevLocalToken(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.NODE_ENV === "production") return null;
  if (env.CINATRA_MCP_DEV_ADMIN_BYPASS !== "true") return null;
  const slot = tokenSlot();
  if (slot.token) return slot.token;

  const token = randomBytes(DEV_LOCAL_TOKEN_BYTES).toString("hex");
  const directory = resolveInstanceDataDir(env);
  const file = path.join(directory, DEV_LOCAL_TOKEN_FILENAME);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  rmSync(file, { force: true });
  writeFileSync(file, `${token}\n`, { mode: 0o600, flag: "wx" });
  // `writeFileSync`'s mode is subject to the process umask; state the mode
  // outright so the credential is never group- or world-readable.
  chmodSync(file, 0o600);
  slot.token = token;
  return token;
}

/**
 * The credential THIS process minted, or null when none was minted. Null is
 * the fail-closed answer: the trust decision refuses without a credential.
 */
export function expectedDevLocalToken(): string | null {
  return tokenSlot().token;
}

/**
 * Read the credential from the instance data directory — the CLIENT side of
 * the contract, for a local tool that must present the token. Returns null when
 * the file is absent or unreadable (which is the answer for every process that
 * is not this operator on this machine).
 */
export function readDevLocalTokenFile(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const raw = readFileSync(devLocalTokenPath(env), "utf8").trim();
    return raw === "" ? null : raw;
  } catch {
    return null;
  }
}

/** Test seam: forget the minted credential so a fresh mint can be exercised. */
export function resetDevLocalTokenForTest(): void {
  tokenSlot().token = null;
}
