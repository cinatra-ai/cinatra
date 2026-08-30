// -----------------------------------------------------------------------------
// The development fixture account's secret.
//
// The development boot seeds one fixture account so the end-to-end harnesses
// have a real person to sign in as. Its password used to be assembled from
// literals in this repository: anyone who read the source knew the credential of
// every instance that had ever booted it, and the account was seeded even when
// the instance was served to the whole internet.
//
// This module holds the four rules that replace that, as pure environment and
// crypto logic — no server-only APIs and no IO — so the boot, the harnesses and
// the tests all read exactly the same rules:
//
//   1. the password is minted fresh on every boot, from a crypto source, past a
//      length floor, and is shown to the operator EXACTLY ONCE. Nothing writes
//      it to a file or to the database in clear; the account keeps a hash;
//   2. seeding is REFUSED, with a sentence the operator can read, whenever any
//      origin the instance is configured to be served on is not a loopback or
//      private-network address;
//   3. an account an earlier boot left behind is rotated onto this boot's
//      secret, so a password from an earlier boot stops working;
//   4. a harness that needs the password reads the value the instance was
//      started with, from the environment — never a literal, never a file.
// -----------------------------------------------------------------------------

import { randomBytes } from "node:crypto";

import { isPrivateUrl } from "@/lib/url-policy";

const TAG = "[dev-fixture-account]";

/**
 * The setting that carries the fixture account's password INTO an instance and
 * OUT to a harness. An operator who needs to know the password ahead of time
 * sets it; otherwise the boot mints one and prints it.
 */
export const DEV_FIXTURE_PASSWORD_ENV = "CINATRA_DEV_FIXTURE_PASSWORD";

/** No fixture password, minted or supplied, is ever shorter than this. */
export const MIN_DEV_FIXTURE_PASSWORD_LENGTH = 24;

/**
 * Every setting that can name the origin this instance is served on. The
 * refusal below reads ALL of them: an instance is public if ANY of them is.
 */
const SERVED_ORIGIN_SETTINGS = [
  "NEXT_PUBLIC_APP_URL",
  "BETTER_AUTH_URL",
  "NEXT_PUBLIC_BETTER_AUTH_URL",
] as const;

/**
 * A fresh password for this boot. 33 random bytes render as 44 characters that
 * survive a shell, a URL and a sign-in form unharmed — comfortably past the
 * floor, and drawn from the platform's cryptographic source.
 */
export function generateDevFixturePassword(): string {
  return randomBytes(33).toString("base64url");
}

/**
 * True when the given address is one only this machine or its own network can
 * reach. Loopback in all its spellings is decided here, as are the IPv6 private
 * ranges; the IPv4 private ranges are decided by the shared classifier so there
 * is one reading of them.
 *
 * FAIL CLOSED. Everything this function cannot positively recognise as local is
 * NOT local, because the caller refuses on a false answer:
 *   - a value with no scheme (`app.example.org:8443`) parses as a URL whose
 *     hostname is empty — it is a public host name, never a local one;
 *   - a wildcard bind address (`0.0.0.0`, `[::]`) is the address a server
 *     listens on for EVERY interface, so an instance configured to be served
 *     there is reachable from outside and is treated as public.
 */
export function isLoopbackOrPrivateOrigin(value: string | null | undefined): boolean {
  if (typeof value !== "string" || value.trim() === "") return false;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  // A value with no scheme parses with an opaque protocol and an EMPTY host —
  // `new URL("app.example.org:8443").hostname` is "". Only a real web origin is
  // classified at all; anything else fails closed.
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const hostname = url.hostname.toLowerCase();
  if (hostname === "") return false;
  // `new URL("http://[::1]:3000").hostname` keeps the brackets.
  const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (host === "") return false;
  if (host.includes(":")) return isPrivateIpv6(host);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (/^127\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  // `0.0.0.0` is the every-interface bind address, not a local address.
  if (host === "0.0.0.0") return false;
  return isPrivateUrl(`http://${host}`);
}

/**
 * True for an IPv6 address only this machine or its own network can reach:
 * the loopback address, the unique-local range (fc00::/7 — an address that
 * starts `fc` or `fd`) and the link-local range (fe80::/10). The unspecified
 * address `::` is the every-interface bind address, so it is NOT local.
 */
function isPrivateIpv6(host: string): boolean {
  if (host === "::1") return true;
  if (host === "::" || host === "") return false;
  if (/^f[cd][0-9a-f]{0,2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]?:/.test(host)) return true;
  return false;
}

/**
 * The sentence to print instead of seeding the fixture account, or null when
 * seeding may go ahead. An instance that is reachable from outside its own
 * network never carries the fixture account, so a password printed on one
 * operator's screen can never be typed at somebody else's sign-in page.
 */
export function devFixtureSeedRefusal(
  env: Record<string, string | undefined> = process.env,
): string | null {
  for (const setting of SERVED_ORIGIN_SETTINGS) {
    const value = env[setting];
    if (typeof value !== "string" || value.trim() === "") continue;
    if (!isLoopbackOrPrivateOrigin(value)) {
      return (
        `refusing to seed the development fixture account: this instance is configured to be served at ` +
        `${value.trim()} (${setting}), which is not a loopback or private-network address. ` +
        `The fixture account exists only on an instance nobody else can reach.`
      );
    }
  }
  return null;
}

/** Where this boot's password came from. */
export type DevFixtureSecret = { password: string; source: "injected" | "generated" };

let bootSecret: DevFixtureSecret | null = null;

/**
 * This boot's fixture password. Resolved once and held for the life of the
 * process, so every part of a boot agrees on one value; the next boot starts a
 * new process and therefore gets a new one. An operator who needs to know the
 * value in advance supplies it; a supplied value below the floor is ignored
 * (with a printed sentence) rather than weakening the account.
 */
export function resolveDevFixturePassword(
  env: Record<string, string | undefined> = process.env,
): DevFixtureSecret {
  if (bootSecret) return bootSecret;
  const supplied = env[DEV_FIXTURE_PASSWORD_ENV];
  if (typeof supplied === "string" && supplied.length >= MIN_DEV_FIXTURE_PASSWORD_LENGTH) {
    bootSecret = { password: supplied, source: "injected" };
    return bootSecret;
  }
  if (typeof supplied === "string" && supplied.trim() !== "") {
    console.log(
      `${TAG} ignoring the supplied ${DEV_FIXTURE_PASSWORD_ENV}: it is shorter than ` +
        `${MIN_DEV_FIXTURE_PASSWORD_LENGTH} characters. Minting one for this boot instead.`,
    );
  }
  bootSecret = { password: generateDevFixturePassword(), source: "generated" };
  return bootSecret;
}

let alreadyPrinted = false;

/**
 * Show the operator the fixture account's password — once for the whole boot.
 * This console line is the ONLY place the password appears in clear; no file
 * and no database column ever holds it.
 */
export function printDevFixtureSecretOnce(
  email: string,
  password: string,
  source: DevFixtureSecret["source"],
): void {
  if (alreadyPrinted) return;
  alreadyPrinted = true;
  const origin = source === "injected" ? "the password you supplied" : "a password minted for this boot";
  console.log(
    `${TAG} the development fixture account ${email} uses ${origin}. It is shown here once and is ` +
      `stored nowhere in clear:\n` +
      `${TAG}   ${password}\n` +
      `${TAG} set ${DEV_FIXTURE_PASSWORD_ENV} before starting the instance to choose it yourself — ` +
      `the end-to-end harnesses read it from there.`,
  );
}

/**
 * The fixture password, for a harness running beside an instance. The harness
 * is given the value the instance was started with; there is nothing to fall
 * back to, and a missing value says so plainly rather than guessing.
 */
export function requireInjectedDevFixturePassword(
  env: Record<string, string | undefined> = process.env,
): string {
  const value = env[DEV_FIXTURE_PASSWORD_ENV];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `The development fixture account's password is not available. Set ${DEV_FIXTURE_PASSWORD_ENV} to the ` +
        `value the instance was started with: the boot mints one per boot and prints it once, and setting ` +
        `this before the instance starts chooses it instead. It is deliberately written nowhere.`,
    );
  }
  // The SAME floor the boot applies. A shorter value is ignored by the boot,
  // which mints its own instead — so a harness that accepted it here would type
  // a password the instance never had and report an authentication failure that
  // says nothing about the thing under test.
  if (value.length < MIN_DEV_FIXTURE_PASSWORD_LENGTH) {
    throw new Error(
      `${DEV_FIXTURE_PASSWORD_ENV} is shorter than ${MIN_DEV_FIXTURE_PASSWORD_LENGTH} characters, so the ` +
        `instance ignored it and minted its own password for this boot. Supply a value at least ` +
        `${MIN_DEV_FIXTURE_PASSWORD_LENGTH} characters long to both the instance and this harness.`,
    );
  }
  return value;
}

/**
 * The small piece of the sign-in store a rotation needs. Keeping it to three
 * named operations lets the rule below be exercised for what it does — hash,
 * then store the hash — without a database.
 */
export type DevFixtureCredentialStore = {
  hasCredentialAccount: (userId: string) => Promise<boolean>;
  hashPassword: (plain: string) => Promise<string>;
  updateCredentialPassword: (userId: string, passwordHash: string) => Promise<void>;
};

/**
 * Put this boot's secret on an account an earlier boot created, so the password
 * that account carried before stops working. Returns false when the
 * account has no password to rotate; the caller treats that as a refusal rather
 * than leaving an account behind whose password it does not know.
 */
export async function rotateDevFixturePassword(
  userId: string,
  password: string,
  store: DevFixtureCredentialStore,
): Promise<boolean> {
  if (typeof password !== "string" || password.length < MIN_DEV_FIXTURE_PASSWORD_LENGTH) {
    throw new Error(
      `refusing to rotate the development fixture account onto a password shorter than ` +
        `${MIN_DEV_FIXTURE_PASSWORD_LENGTH} characters`,
    );
  }
  if (!(await store.hasCredentialAccount(userId))) return false;
  const passwordHash = await store.hashPassword(password);
  await store.updateCredentialPassword(userId, passwordHash);
  return true;
}

/**
 * Take the fixture account's password away from whoever knows it, without
 * handing it to anybody new. Used where the account must NOT be used at all:
 * on an instance the public can reach, and where this boot cannot put its own
 * secret on the account. A fresh secret is minted, stored as a hash and then
 * dropped unread, so the account survives as a row that nothing can sign in as
 * — an earlier boot's password stops working even on a boot that refuses to
 * seed. Returns false when there was no password to take away, and never
 * throws: this runs on paths that are already refusing.
 */
export async function retireDevFixturePassword(
  userId: string,
  store: DevFixtureCredentialStore,
): Promise<boolean> {
  try {
    return await rotateDevFixturePassword(userId, generateDevFixturePassword(), store);
  } catch {
    return false;
  }
}
