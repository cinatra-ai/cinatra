// ---------------------------------------------------------------------------
// THE PER-BOOT LOCAL CREDENTIAL.
// ---------------------------------------------------------------------------
//
// The loopback checks next door NARROW; this is what PROVES. A caller holds this
// secret only by being able to read a 0600 file in the instance data directory,
// which means being the user this instance runs as, on the machine it runs on.
// That is the property the destructive development-only routes actually wanted
// all along, and the one no header can supply.
//
// Minted fresh on every boot and never persisted anywhere else, so a value that
// leaks into a shell history or a log dies with the process that issued it.
//
// UNSET MEANS OFF. A tree where nothing minted a credential answers every caller
// with a refusal — the same fail-closed default `CINATRA_LIFECYCLE_SEED_TOKEN`
// takes in src/lib/test-support/lifecycle-seed-fence.ts, and for the same
// reason: a gate whose absent configuration means "allow" is not a gate.
//
// The path is a shared CONSTANT rather than a convention each caller repeats, so
// the process that writes it and the callers that present it cannot drift apart.
// The parallel work on the MCP dev-admin bypass reads the same file through the
// same two exports (`bootCredentialPath` / `readBootCredential`).
// ---------------------------------------------------------------------------

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { HeaderBag } from "@/lib/request-peer";

/** The header a local caller presents the credential in. */
export const BOOT_CREDENTIAL_HEADER = "x-cinatra-boot-token";

/** Overrides the instance data directory (a container mount, a test tmpdir). */
export const INSTANCE_DATA_DIR_ENV = "CINATRA_INSTANCE_DATA_DIR";

/** The credential's file name inside the instance data directory. */
export const BOOT_CREDENTIAL_FILENAME = "boot-token";

/** Shortest value worth calling high-entropy; a shorter file is refused rather
 *  than accepted weakly. 32 hex characters of `randomBytes` clears it. */
export const BOOT_CREDENTIAL_MIN_LENGTH = 32;

export type CredentialEnv = Record<string, string | undefined>;

/** The instance's own writable directory: the override, else `.cinatra` beside
 *  the instance root. Absolute, so no caller's cwd can move it mid-run.
 *
 *  THE CONTRACT WITH A SEPARATELY LAUNCHED PROCESS. The fallback resolves
 *  against THIS process's working directory, which is the instance root for the
 *  server. A CLI started from somewhere else has a different working directory
 *  and therefore cannot discover the file by the fallback — it must be told the
 *  instance root, which is what {@link INSTANCE_DATA_DIR_ENV} is for. The
 *  fallback is a convenience for the common single-checkout case, never the
 *  cross-process agreement; that agreement is the environment variable plus
 *  {@link BOOT_CREDENTIAL_FILENAME}. */
export function instanceDataDir(env: CredentialEnv = process.env): string {
  const override = env[INSTANCE_DATA_DIR_ENV]?.trim();
  if (override) return path.resolve(override);
  return path.resolve(process.cwd(), ".cinatra");
}

/** THE path both halves of this road agree on. */
export function bootCredentialPath(env: CredentialEnv = process.env): string {
  return path.join(instanceDataDir(env), BOOT_CREDENTIAL_FILENAME);
}

/**
 * Mint this boot's credential and write it 0600.
 *
 * THROWS outside a development runtime. The surfaces this credential opens do
 * not exist in production, so minting one there would be creating the key to a
 * door that must not be built — better a loud boot failure than a quiet file.
 *
 * `mode` on `writeFileSync` only applies to a file being CREATED, so an
 * existing file keeps whatever permissions it already had. Two things follow,
 * and both are done below rather than assumed: the PREVIOUS boot's credential
 * is removed before this one is written — so a mint that fails part way leaves
 * NO credential rather than silently re-arming the old one — and the mode is
 * set explicitly afterwards, so the 0600 the whole gate rests on holds however
 * the file came to exist.
 */
export function mintBootCredential(env: CredentialEnv = process.env): string {
  if (env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to mint a local boot credential under a production build.",
    );
  }
  if (env.CINATRA_RUNTIME_MODE !== "development") {
    throw new Error(
      "Refusing to mint a local boot credential outside a development runtime.",
    );
  }
  const secret = randomBytes(32).toString("hex");
  const file = bootCredentialPath(env);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Retire the previous boot's credential FIRST. If anything below throws, the
  // instance is left with no credential — which refuses everyone — instead of
  // with a token this boot never issued and cannot recognise as stale.
  rmSync(file, { force: true });
  writeFileSync(file, secret, { encoding: "utf8", mode: 0o600 });
  // Explicit, because `mode` above only applies to a file being created and
  // this one may have been created by an earlier, more permissive writer.
  chmodSync(file, 0o600);
  return secret;
}

/**
 * This boot's credential, or `null` when there is none to compare against.
 *
 * Deliberately re-read per call rather than cached: the file is rewritten on
 * every boot, and a dev process that survives a re-mint must follow the file
 * rather than an old copy of it. A short file reads as absent — see
 * {@link BOOT_CREDENTIAL_MIN_LENGTH}.
 */
export function readBootCredential(
  env: CredentialEnv = process.env,
): string | null {
  let contents: string;
  try {
    contents = readFileSync(bootCredentialPath(env), "utf8");
  } catch {
    return null;
  }
  const secret = contents.trim();
  return secret.length >= BOOT_CREDENTIAL_MIN_LENGTH ? secret : null;
}

/** Constant-time compare of two secrets of possibly different length. Mirrors
 *  `secretEquals` in src/lib/test-support/lifecycle-seed-fence.ts: padding to
 *  the longer of the two keeps `timingSafeEqual` from throwing on a length
 *  mismatch, which would itself leak the length. */
function secretEquals(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  const width = Math.max(a.length, b.length);
  const pa = Buffer.alloc(width);
  const pb = Buffer.alloc(width);
  a.copy(pa);
  b.copy(pb);
  return timingSafeEqual(pa, pb) && a.length === b.length;
}

/** Did this caller present THIS boot's credential? `false` whenever there is no
 *  credential to present, so an unarmed instance refuses everyone. */
export function bootCredentialPresented(
  headers: HeaderBag,
  env: CredentialEnv = process.env,
): boolean {
  const expected = readBootCredential(env);
  if (expected === null) return false;
  const presented = headers.get(BOOT_CREDENTIAL_HEADER);
  if (presented === null || presented.length === 0) return false;
  return secretEquals(presented, expected);
}
