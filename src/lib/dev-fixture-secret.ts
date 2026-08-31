// -----------------------------------------------------------------------------
// The development fixture account's secret.
//
// The development boot seeds one fixture account so the end-to-end harnesses
// have a real person to sign in as. Its password used to be assembled from
// literals in this repository: anyone who read the source knew the credential of
// every instance that had ever booted it, and the account was seeded even when
// the instance was served to the whole internet.
//
// This module holds the four rules that replace that, as environment, crypto and
// one file — no server-only APIs — so the boot, the harnesses and the tests all
// read exactly the same rules:
//
//   1. the password is minted fresh on every boot, from a crypto source, past a
//      length floor. It is NEVER PRINTED: a boot log is read by whoever can read
//      the log, and on a continuous-integration runner that is the public. The
//      boot writes the value to ONE file instead — under the local runtime data
//      directory, at file mode 0600 — and says where it put it. The database
//      only ever holds a hash;
//   2. seeding is REFUSED, with a sentence the operator can read, whenever any
//      origin the instance is configured to be served on is not a loopback or
//      private-network address;
//   3. an account an earlier boot left behind is rotated onto this boot's
//      secret, so a password from an earlier boot stops working;
//   4. a harness that needs the password reads the value the instance was
//      started with — from the environment, or from the 0600 file the boot
//      names; never from a literal in this repository.
// -----------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";

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
 * Where this boot writes the fixture account's password, relative to the
 * instance's working directory.
 *
 * `data/` is the local runtime data directory — generated, gitignored, and
 * already the home of everything an instance writes about itself. The file
 * holds the value and nothing else, so a reader needs no parser, and it is
 * written at mode 0600 so only the account that started the instance can read
 * it. It replaces PRINTING the value: a log line is read by whoever can read
 * the log, and on a continuous-integration runner that is the public.
 */
export const DEV_FIXTURE_PASSWORD_FILE_RELATIVE = path.join(
  "data",
  "dev-fixture-account",
  "password",
);

/** The absolute path of that file for a given instance working directory. */
export function devFixturePasswordFilePath(cwd: string = process.cwd()): string {
  return path.join(cwd, DEV_FIXTURE_PASSWORD_FILE_RELATIVE);
}

/**
 * Write this boot's password where the operator, a harness or the command line
 * can read it. Returns the path written, or null when the instance could not
 * write it — a boot that cannot write the file still boots, and says so.
 *
 * THE VALUE IS NEVER WIDELY READABLE, not even for an instant, and it never
 * follows a link:
 *   - the file is opened with `O_NOFOLLOW`, so a symbolic link an earlier run
 *     (or anybody else with write access to the directory) left in its place is
 *     refused rather than followed and overwritten;
 *   - the descriptor is narrowed to 0600 BEFORE a byte is written, so a file an
 *     earlier boot left behind at a wider mode cannot expose this boot's value
 *     in the window between the write and a later `chmod`;
 *   - the directory is narrowed to 0700 on every boot, because the `mode` of
 *     `mkdirSync` applies only when the directory is CREATED.
 */
export function writeDevFixturePasswordFile(
  password: string,
  cwd: string = process.cwd(),
): string | null {
  const file = devFixturePasswordFilePath(cwd);
  let fd: number | null = null;
  try {
    const dir = path.dirname(file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    fd = openSync(
      file,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_TRUNC |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(fd, 0o600);
    writeSync(fd, `${password}\n`);
    return file;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
  }
}

/**
 * The password the running instance wrote, for a harness or the command line
 * beside it. Null when there is no file, or when it is empty — a caller then
 * says which setting to supply rather than guessing a value.
 */
export function readDevFixturePasswordFile(cwd: string = process.cwd()): string | null {
  try {
    const value = readFileSync(devFixturePasswordFilePath(cwd), "utf8").trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

/**
 * Take the file away. Called wherever the fixture account itself is being taken
 * away, so a password an earlier boot wrote cannot outlive the account it
 * belonged to. Best-effort and silent on absence.
 */
export function removeDevFixturePasswordFile(cwd: string = process.cwd()): void {
  try {
    rmSync(devFixturePasswordFilePath(cwd), { force: true });
  } catch {
    /* best-effort */
  }
}

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
 * Tell the operator where the fixture account's password is — once for the whole
 * boot — and put it there.
 *
 * THE VALUE IS NEVER PRINTED. A boot log is read by whoever can read the log,
 * and this boot runs on continuous-integration runners whose logs are public, so
 * printing it published the credential of every instance that job booted. What
 * is printed is the FILE the value was written to and the setting that chooses
 * it; whoever may read the file may have the password, and nobody else.
 */
export function printDevFixtureSecretOnce(
  email: string,
  password: string,
  source: DevFixtureSecret["source"],
  cwd: string = process.cwd(),
): void {
  if (alreadyPrinted) return;
  alreadyPrinted = true;
  const origin = source === "injected" ? "the password you supplied" : "a password minted for this boot";
  const file = writeDevFixturePasswordFile(password, cwd);
  const whereItIs = file
    ? `The value is never printed: it is in ${file}, readable only by the account that started this ` +
      `instance (mode 0600). A harness or the command line reads it from there.`
    : `The value is never printed, and it could NOT be written to ${devFixturePasswordFilePath(cwd)} on ` +
      `this boot, so nothing on this machine holds it. Restart with ${DEV_FIXTURE_PASSWORD_ENV} set to ` +
      `a value of your own if you need to know it.`;
  console.log(
    `${TAG} the development fixture account ${email} uses ${origin}. ${whereItIs}\n` +
      `${TAG} set ${DEV_FIXTURE_PASSWORD_ENV} before starting the instance to choose it yourself.`,
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
        `value the instance was started with, or read it from the file the boot names at startup ` +
        `(${DEV_FIXTURE_PASSWORD_FILE_RELATIVE}, mode 0600). Setting this before the instance starts ` +
        `chooses the password instead of letting the boot mint one. It is never printed.`,
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
  // Whatever happens to the row, the file goes: a password an earlier boot
  // wrote must not outlive the account it belonged to.
  removeDevFixturePasswordFile();
  try {
    return await rotateDevFixturePassword(userId, generateDevFixturePassword(), store);
  } catch {
    return false;
  }
}
