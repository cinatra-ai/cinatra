/**
 * The per-boot local credential — the fact that a caller can only have by
 * being able to READ A 0600 FILE on this machine as this user.
 *
 * The loopback checks narrow; this is what proves. Everything here is about
 * the file's permissions, its per-boot freshness, and refusing to answer at
 * all when it was never minted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BOOT_CREDENTIAL_FILENAME,
  BOOT_CREDENTIAL_HEADER,
  BOOT_CREDENTIAL_MIN_LENGTH,
  INSTANCE_DATA_DIR_ENV,
  bootCredentialPath,
  bootCredentialPresented,
  instanceDataDir,
  mintBootCredential,
  readBootCredential,
} from "@/lib/boot-credential";

// A mint that cannot finish must leave NO credential behind — see the test at
// the end of the mint block. Real filesystems do not fail on demand, so the one
// call that must be able to fail is wrapped here; everything else passes
// straight through to the real node:fs, including this file's own use of it.
const fsControl = vi.hoisted(() => ({ failWrite: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (fsControl.failWrite) {
        throw new Error("injected write failure");
      }
      return actual.writeFileSync(...args);
    },
  };
});

let dataDir: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "cinatra-boot-credential-"));
  env = { [INSTANCE_DATA_DIR_ENV]: dataDir, CINATRA_RUNTIME_MODE: "development" };
});

afterEach(() => {
  fsControl.failWrite = false;
  rmSync(dataDir, { recursive: true, force: true });
});

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

describe("instanceDataDir / bootCredentialPath", () => {
  it("honors the explicit instance data directory", () => {
    expect(instanceDataDir(env)).toBe(dataDir);
    expect(bootCredentialPath(env)).toBe(
      path.join(dataDir, BOOT_CREDENTIAL_FILENAME),
    );
  });

  it("falls back to a directory under the instance root when unset", () => {
    const fallback = instanceDataDir({});
    expect(path.isAbsolute(fallback)).toBe(true);
    expect(fallback.endsWith(".cinatra")).toBe(true);
  });
});

describe("mintBootCredential", () => {
  it("writes a high-entropy secret to a 0600 file", () => {
    const minted = mintBootCredential(env);
    expect(minted.length).toBeGreaterThanOrEqual(BOOT_CREDENTIAL_MIN_LENGTH);
    const file = bootCredentialPath(env);
    expect(readFileSync(file, "utf8")).toBe(minted);
    // 0600 — owner read/write, nobody else. The whole gate rests on this.
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("mints a DIFFERENT secret on each boot", () => {
    const first = mintBootCredential(env);
    const second = mintBootCredential(env);
    expect(second).not.toBe(first);
    expect(readBootCredential(env)).toBe(second);
  });

  it("brings a pre-existing, more permissive file back to 0600", () => {
    // `mode` on writeFileSync applies only to a file being CREATED, so a token
    // file some earlier writer left world-readable would keep those bits and
    // the credential would be readable by every user on the machine — the one
    // property the whole gate rests on, quietly gone.
    const file = bootCredentialPath(env);
    writeFileSync(file, "x".repeat(BOOT_CREDENTIAL_MIN_LENGTH), "utf8");
    chmodSync(file, 0o644);
    const minted = mintBootCredential(env);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toBe(minted);
  });

  it("leaves NO credential when the mint cannot complete", () => {
    // The previous boot's token must not be silently re-armed by a failed
    // mint: the boot swallows a mint failure on purpose (an instance without a
    // credential refuses everyone, which is the right answer), and that is only
    // true if the failure actually leaves nothing behind.
    const previousBoot = mintBootCredential(env);
    expect(readBootCredential(env)).toBe(previousBoot);

    fsControl.failWrite = true;
    expect(() => mintBootCredential(env)).toThrow(/injected write failure/);
    fsControl.failWrite = false;

    expect(readBootCredential(env)).toBeNull();
    expect(
      bootCredentialPresented(
        headers({ [BOOT_CREDENTIAL_HEADER]: previousBoot }),
        env,
      ),
    ).toBe(false);
  });

  it("refuses to mint outside a development runtime", () => {
    expect(() =>
      mintBootCredential({ ...env, NODE_ENV: "production" }),
    ).toThrow();
    expect(() =>
      mintBootCredential({ ...env, CINATRA_RUNTIME_MODE: "production" }),
    ).toThrow();
  });
});

describe("readBootCredential", () => {
  it("returns null when nothing was ever minted — the gate is OFF by default", () => {
    expect(readBootCredential(env)).toBeNull();
  });

  it("returns null for a short (low-entropy) file rather than accepting it weakly", () => {
    writeFileSync(bootCredentialPath(env), "short", { mode: 0o600 });
    expect(readBootCredential(env)).toBeNull();
  });

  it("tolerates the trailing newline a shell redirect leaves behind", () => {
    const secret = "a".repeat(BOOT_CREDENTIAL_MIN_LENGTH);
    writeFileSync(bootCredentialPath(env), `${secret}\n`, { mode: 0o600 });
    expect(readBootCredential(env)).toBe(secret);
  });
});

describe("bootCredentialPresented", () => {
  it("accepts the minted secret in the boot-credential header", () => {
    const secret = mintBootCredential(env);
    expect(
      bootCredentialPresented(headers({ [BOOT_CREDENTIAL_HEADER]: secret }), env),
    ).toBe(true);
  });

  it("refuses a wrong secret of the same length", () => {
    const secret = mintBootCredential(env);
    const wrong = "b".repeat(secret.length);
    expect(
      bootCredentialPresented(headers({ [BOOT_CREDENTIAL_HEADER]: wrong }), env),
    ).toBe(false);
  });

  it("refuses a prefix of the real secret (no length-blind compare)", () => {
    const secret = mintBootCredential(env);
    expect(
      bootCredentialPresented(
        headers({ [BOOT_CREDENTIAL_HEADER]: secret.slice(0, -1) }),
        env,
      ),
    ).toBe(false);
  });

  it("refuses a request that presents nothing", () => {
    mintBootCredential(env);
    expect(bootCredentialPresented(headers({}), env)).toBe(false);
  });

  it("refuses everything when no credential was minted, even an empty header", () => {
    expect(bootCredentialPresented(headers({}), env)).toBe(false);
    expect(
      bootCredentialPresented(headers({ [BOOT_CREDENTIAL_HEADER]: "" }), env),
    ).toBe(false);
  });
});
