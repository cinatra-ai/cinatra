// The development fixture account's secret.
//
// The account the development boot seeds used to carry a password assembled
// from literals in this repository, so every reader of the source knew the
// credential of every instance that had ever booted it, and the account was
// seeded even on an instance served to the whole internet. Four rules replace
// that, and each one is exercised here:
//
//   1. the password is minted fresh on every boot, is crypto-strong, and is
//      NEVER PRINTED — the boot writes it to one 0600 file under the local
//      runtime data directory and names that file instead, because a boot log
//      is read by whoever can read the log and this boot runs on runners whose
//      logs are public;
//   2. seeding is REFUSED, with a printed sentence, whenever any origin the
//      instance is configured to serve is not loopback, private-network or
//      otherwise local-only — a container-network alias, a reserved local name
//      ending and a single-label name are all local, and none of them refuses;
//   3. a fixture row an earlier boot left behind has its password rotated to
//      this boot's secret, so a password from an earlier boot stops working;
//   4. the end-to-end harnesses read the secret from the environment the
//      instance was started with, or from the file the boot names — never from
//      a literal in this repository.
//
// Behaviour first (the rules are a pure module so they can be driven directly),
// then SOURCE WIRING pins in the house style — the boot and the harnesses must
// actually be wired to those rules, and no literal credential may return.

import { afterEach, describe, expect, it, vi } from "vitest";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  DEV_FIXTURE_PASSWORD_ENV,
  DEV_FIXTURE_PASSWORD_FILE_RELATIVE,
  MIN_DEV_FIXTURE_PASSWORD_LENGTH,
  devFixturePasswordFilePath,
  devFixtureSeedRefusal,
  devFixtureSeedingAllowed,
  generateDevFixturePassword,
  readDevFixturePasswordFile,
  removeDevFixturePasswordFile,
  writeDevFixturePasswordFile,
  isLoopbackOrPrivateOrigin,
  requireInjectedDevFixturePassword,
  resolveDevFixturePassword,
  retireDevFixturePassword,
  rotateDevFixturePassword,
} from "@/lib/dev-fixture-secret";

// ---------------------------------------------------------------------------
// 1. A fresh secret on every boot, shown once.
// ---------------------------------------------------------------------------

describe("the fixture password is a per-boot secret, never a source literal", () => {
  it("mints a different value every time, past the length floor, from a crypto source", () => {
    const minted = new Set<string>();
    for (let i = 0; i < 32; i += 1) {
      const value = generateDevFixturePassword();
      expect(value.length).toBeGreaterThanOrEqual(MIN_DEV_FIXTURE_PASSWORD_LENGTH);
      expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
      minted.add(value);
    }
    expect(minted.size).toBe(32);
  });

  it("holds ONE value for the life of a boot, and a fresh boot mints a fresh one", async () => {
    const env: Record<string, string | undefined> = {};
    const first = resolveDevFixturePassword(env);
    expect(first.source).toBe("generated");
    expect(resolveDevFixturePassword(env).password).toBe(first.password);

    vi.resetModules();
    const nextBoot = await import("@/lib/dev-fixture-secret");
    expect(nextBoot.resolveDevFixturePassword({}).password).not.toBe(first.password);
  });

  it("takes the operator's own value when one is supplied, and ignores one below the floor", async () => {
    vi.resetModules();
    const supplied = await import("@/lib/dev-fixture-secret");
    const chosen = "chosen-by-the-operator-and-long-enough";
    expect(supplied.resolveDevFixturePassword({ [DEV_FIXTURE_PASSWORD_ENV]: chosen })).toEqual({
      password: chosen,
      source: "injected",
    });

    vi.resetModules();
    const tooShort = await import("@/lib/dev-fixture-secret");
    const resolved = tooShort.resolveDevFixturePassword({ [DEV_FIXTURE_PASSWORD_ENV]: "short" });
    expect(resolved.source).toBe("generated");
    expect(resolved.password).not.toBe("short");
    expect(resolved.password.length).toBeGreaterThanOrEqual(MIN_DEV_FIXTURE_PASSWORD_LENGTH);
  });

  // THE VALUE IS NEVER PRINTED. A boot log is read by whoever can read the log,
  // and this boot runs on continuous-integration runners whose logs are public:
  // printing it published the credential of every instance the job booted.
  it("never prints the secret — it names the file it wrote it to, and the setting", async () => {
    vi.resetModules();
    const boot = await import("@/lib/dev-fixture-secret");
    const secret = "never-printed-and-long-enough-x";
    const cwd = tempInstanceRoot();
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      boot.printDevFixtureSecretOnce("fixture@example.com", secret, "generated", cwd);
      boot.printDevFixtureSecretOnce("fixture@example.com", secret, "generated", cwd);
    } finally {
      spy.mockRestore();
    }
    const printed = lines.join("\n");
    expect(printed).not.toContain(secret);
    expect(printed).toContain(boot.devFixturePasswordFilePath(cwd));
    expect(printed).toContain(DEV_FIXTURE_PASSWORD_ENV);
    // Once for the whole boot: the second call says nothing.
    expect(lines).toHaveLength(1);
  });

  it("puts the value in that file, readable by nobody else", async () => {
    vi.resetModules();
    const boot = await import("@/lib/dev-fixture-secret");
    const secret = "written-to-the-file-and-long-enough";
    const cwd = tempInstanceRoot();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      boot.printDevFixtureSecretOnce("fixture@example.com", secret, "generated", cwd);
    } finally {
      spy.mockRestore();
    }
    const file = boot.devFixturePasswordFilePath(cwd);
    expect(fs.readFileSync(file, "utf8").trim()).toBe(secret);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------
// 1b. The file the boot names — written, read back, and taken away with the
//     account it belongs to.
// ---------------------------------------------------------------------------

const tempRoots: string[] = [];

function tempInstanceRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cinatra-dev-fixture-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("the boot writes the secret to one 0600 file instead of printing it", () => {
  it("lives under the gitignored local runtime data directory", () => {
    expect(DEV_FIXTURE_PASSWORD_FILE_RELATIVE).toBe(
      path.join("data", "dev-fixture-account", "password"),
    );
    const gitignore = fs.readFileSync(path.join(__dirname, "..", "..", "..", ".gitignore"), "utf8");
    expect(gitignore).toMatch(/^\/data\/$/m);
  });

  it("writes the value, and nothing else, at mode 0600", () => {
    const cwd = tempInstanceRoot();
    const secret = "a-value-long-enough-for-the-floor";
    expect(writeDevFixturePasswordFile(secret, cwd)).toBe(devFixturePasswordFilePath(cwd));
    expect(fs.readFileSync(devFixturePasswordFilePath(cwd), "utf8").trim()).toBe(secret);
    expect(fs.statSync(devFixturePasswordFilePath(cwd)).mode & 0o777).toBe(0o600);
  });

  // The mode argument only applies when a file is CREATED, so a file an earlier
  // boot left behind with a wider mode would otherwise keep it.
  it("narrows a file an earlier boot left behind with a wider mode", () => {
    const cwd = tempInstanceRoot();
    fs.mkdirSync(path.dirname(devFixturePasswordFilePath(cwd)), { recursive: true });
    fs.writeFileSync(devFixturePasswordFilePath(cwd), "older", { mode: 0o644 });
    writeDevFixturePasswordFile("a-value-long-enough-for-the-floor", cwd);
    expect(fs.statSync(devFixturePasswordFilePath(cwd)).mode & 0o777).toBe(0o600);
  });

  it("reads back exactly what was written, and says nothing when there is no file", () => {
    const cwd = tempInstanceRoot();
    expect(readDevFixturePasswordFile(cwd)).toBeNull();
    writeDevFixturePasswordFile("a-value-long-enough-for-the-floor", cwd);
    expect(readDevFixturePasswordFile(cwd)).toBe("a-value-long-enough-for-the-floor");
  });

  it("takes the file away when the account it belongs to is taken away", async () => {
    const cwd = tempInstanceRoot();
    writeDevFixturePasswordFile("a-value-long-enough-for-the-floor", cwd);
    removeDevFixturePasswordFile(cwd);
    expect(readDevFixturePasswordFile(cwd)).toBeNull();
    // And removing one that is not there is not an error: the paths that call
    // it are already refusing.
    expect(() => removeDevFixturePasswordFile(cwd)).not.toThrow();
  });

  it("never throws on an instance root it cannot write", () => {
    expect(writeDevFixturePasswordFile("a-value-long-enough-for-the-floor", "/dev/null/nope")).toBeNull();
  });

  // The value must never be readable by anyone else, not even for the instant
  // between the write and a narrowing chmod: the descriptor is narrowed first.
  it("never lets the value exist in a file anybody else can read", () => {
    const cwd = tempInstanceRoot();
    const file = devFixturePasswordFilePath(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "older", { mode: 0o666 });
    writeDevFixturePasswordFile("a-value-long-enough-for-the-floor", cwd);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, "utf8").trim()).toBe("a-value-long-enough-for-the-floor");
  });

  // A link left in the file's place must be REFUSED, not followed: following it
  // would write this boot's secret into a file of somebody else's choosing and
  // chmod that file.
  it("refuses to follow a link left in the file's place", () => {
    const cwd = tempInstanceRoot();
    const file = devFixturePasswordFilePath(cwd);
    const elsewhere = path.join(cwd, "elsewhere");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(elsewhere, "untouched", { mode: 0o644 });
    fs.symlinkSync(elsewhere, file);
    expect(writeDevFixturePasswordFile("a-value-long-enough-for-the-floor", cwd)).toBeNull();
    expect(fs.readFileSync(elsewhere, "utf8")).toBe("untouched");
  });

  // mkdir's mode applies only when the directory is CREATED.
  it("narrows a directory an earlier boot left behind wide open", () => {
    const cwd = tempInstanceRoot();
    const dir = path.dirname(devFixturePasswordFilePath(cwd));
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    writeDevFixturePasswordFile("a-value-long-enough-for-the-floor", cwd);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });
});

// ---------------------------------------------------------------------------
// 2. Never on an instance the public can reach.
// ---------------------------------------------------------------------------

describe("seeding is refused unless every configured origin is loopback or private-network", () => {
  const classified: Array<[string, boolean]> = [
    ["http://127.0.0.1:3000", true],
    ["http://127.0.0.53", true],
    ["http://localhost:3000", true],
    ["http://app.localhost:3000", true],
    ["http://[::1]:3000", true],
    ["http://10.1.2.3", true],
    ["http://192.168.1.9:3000", true],
    ["http://172.20.0.4", true],
    ["http://[fd00::1]:3000", true],
    ["http://[fe80::1]", true],
    // The container-network alias a WordPress or Drupal container uses to
    // reach the app on the machine that runs it. It names THIS machine from
    // inside a container; nothing outside the machine can resolve it.
    ["http://host.docker.internal:3000", true],
    ["http://gateway.docker.internal:3000", true],
    // Names reserved for one machine or one network. None of them is
    // delegated in the public domain name system, so none can be an origin
    // somebody else reaches this instance at.
    ["http://app.internal", true],
    ["http://printer.local:631", true],
    ["http://box.lan", true],
    ["http://gateway.home.arpa", true],
    // A single-label name is a machine on this network, never a public host.
    ["http://build-box:3000", true],
    ["http://build-box.:3000", true],
    ["https://example.com", false],
    ["https://app.example.org:8443", false],
    ["http://203.0.113.7", false],
    ["https://app.example.com", false],
    ["http://203.0.113.10:3000", false],
    // A public name is public whatever it is dressed in: a trailing root dot
    // does not make one local.
    ["https://app.example.com.", false],
    ["not-a-url", false],
    ["", false],
    // A value with NO SCHEME parses as a URL whose hostname is empty. Reading
    // that as "local" would seed the fixture account on a public instance.
    ["app.example.org:8443", false],
    ["example.com:3000", false],
    // The every-interface bind addresses are how a server is served to the
    // whole network, so they are the opposite of local.
    ["http://0.0.0.0:3000", false],
    ["http://[::]:3000", false],
    // Not a web origin at all.
    ["ftp://127.0.0.1", false],
    ["file:///tmp/instance", false],
  ];

  it.each(classified)("classifies %s", (value, expected) => {
    expect(isLoopbackOrPrivateOrigin(value)).toBe(expected);
  });

  it("returns a printable sentence naming the origin it refused, and the setting that carries it", () => {
    const refusal = devFixtureSeedRefusal({ NEXT_PUBLIC_APP_URL: "https://example.com" });
    expect(refusal).toBeTruthy();
    expect(refusal).toContain("https://example.com");
    expect(refusal).toContain("NEXT_PUBLIC_APP_URL");
    expect(String(refusal).toLowerCase()).toContain("refus");
  });

  it("allows an instance served only on loopback or a private network", () => {
    expect(devFixtureSeedRefusal({ NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000" })).toBeNull();
    expect(devFixtureSeedRefusal({ NEXT_PUBLIC_APP_URL: "http://192.168.4.20:3000" })).toBeNull();
    expect(devFixtureSeedRefusal({})).toBeNull();
  });

  it("refuses when ANY configured origin is public, not only the first one it reads", () => {
    expect(
      devFixtureSeedRefusal({
        NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
        BETTER_AUTH_URL: "https://example.com",
      }),
    ).toBeTruthy();
    expect(devFixtureSeedRefusal({ NEXT_PUBLIC_BETTER_AUTH_URL: "https://example.com" })).toBeTruthy();
    expect(devFixtureSeedRefusal({ BETTER_AUTH_URL: "http://127.0.0.1:3000" })).toBeNull();
  });

  it("refuses an origin it cannot read at all rather than guessing it is local", () => {
    expect(devFixtureSeedRefusal({ NEXT_PUBLIC_APP_URL: "definitely not a url" })).toBeTruthy();
  });

  it("refuses a public origin written without a scheme", () => {
    const refusal = devFixtureSeedRefusal({ NEXT_PUBLIC_APP_URL: "app.example.org:8443" });
    expect(refusal).toBeTruthy();
    expect(refusal).toContain("app.example.org:8443");
  });

  it("refuses an instance configured to be served on every interface", () => {
    expect(devFixtureSeedRefusal({ NEXT_PUBLIC_APP_URL: "http://0.0.0.0:3000" })).toBeTruthy();
    expect(devFixtureSeedRefusal({ BETTER_AUTH_URL: "http://[::]:3000" })).toBeTruthy();
  });

  // The exact pair the WordPress/Drupal end-to-end harness boots the app with:
  // the containers reach the app through the docker-host alias, and the sign-in
  // stack is built on the loopback address. Neither is an exposure signal, so
  // the fixture account is seeded and the harness gets its credential.
  it("allows the container-network alias the end-to-end harness serves the app at", () => {
    expect(
      devFixtureSeedingAllowed({
        runtimeMode: "development",
        nodeEnv: "development",
        authBaseUrl: "http://localhost:3000",
        publicBaseUrl: "http://host.docker.internal:3000",
      }).allowed,
    ).toBe(true);
    expect(
      devFixtureSeedRefusal({
        BETTER_AUTH_URL: "http://localhost:3000",
        NEXT_PUBLIC_BETTER_AUTH_URL: "http://localhost:3000",
        NEXT_PUBLIC_APP_URL: "http://host.docker.internal:3000",
      }),
    ).toBeNull();
  });

  it("allows an instance served only on a name its own network resolves", () => {
    for (const local of [
      "http://gateway.docker.internal:3000",
      "http://app.internal",
      "http://printer.local:631",
      "http://box.lan",
      "http://gateway.home.arpa",
      "http://build-box:3000",
    ]) {
      expect(devFixtureSeedRefusal({ NEXT_PUBLIC_APP_URL: local }), local).toBeNull();
    }
  });

  // Widening what counts as local must not widen what counts as private on
  // either arm of the rule: a public name or a public address still refuses,
  // whether it arrives as the authentication base URL or as the public one.
  it("keeps refusing a public host name or a public address on either arm", () => {
    for (const exposed of ["https://app.example.com", "http://203.0.113.10:3000", "https://app.example.org:8443"]) {
      expect(
        devFixtureSeedingAllowed({
          runtimeMode: "development",
          nodeEnv: "development",
          authBaseUrl: "http://127.0.0.1:3000",
          publicBaseUrl: exposed,
        }).allowed,
        exposed,
      ).toBe(false);
      expect(
        devFixtureSeedingAllowed({
          runtimeMode: "development",
          nodeEnv: "development",
          authBaseUrl: exposed,
          publicBaseUrl: null,
        }).allowed,
        exposed,
      ).toBe(false);
    }
  });

  it("allows an instance served on a private IPv6 address", () => {
    expect(devFixtureSeedRefusal({ NEXT_PUBLIC_APP_URL: "http://[fd00::1]:3000" })).toBeNull();
    expect(devFixtureSeedRefusal({ NEXT_PUBLIC_APP_URL: "http://[::1]:3000" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. An earlier boot's password dies on this boot.
// ---------------------------------------------------------------------------

describe("an existing fixture account is rotated onto this boot's secret", () => {
  function recordingStore(hasAccount: boolean) {
    const writes: Array<{ userId: string; passwordHash: string }> = [];
    return {
      writes,
      store: {
        hasCredentialAccount: async () => hasAccount,
        hashPassword: async (plain: string) => `hash-of-${plain.length}-characters`,
        updateCredentialPassword: async (userId: string, passwordHash: string) => {
          writes.push({ userId, passwordHash });
        },
      },
    };
  }

  it("stores the HASH of the new secret against the account, never the secret", async () => {
    const secret = generateDevFixturePassword();
    const { store, writes } = recordingStore(true);
    await expect(rotateDevFixturePassword("fixture-user", secret, store)).resolves.toBe(true);
    expect(writes).toEqual([
      { userId: "fixture-user", passwordHash: `hash-of-${secret.length}-characters` },
    ]);
    expect(writes[0].passwordHash).not.toContain(secret);
  });

  it("reports that there was nothing to rotate, and writes nothing, when the account has no password", async () => {
    const { store, writes } = recordingStore(false);
    await expect(rotateDevFixturePassword("fixture-user", generateDevFixturePassword(), store)).resolves.toBe(
      false,
    );
    expect(writes).toEqual([]);
  });

  it("refuses to rotate onto a value below the length floor", async () => {
    const { store, writes } = recordingStore(true);
    await expect(rotateDevFixturePassword("fixture-user", "short", store)).rejects.toThrow(
      String(MIN_DEV_FIXTURE_PASSWORD_LENGTH),
    );
    expect(writes).toEqual([]);
  });

  // An account this boot will NOT be using must still stop answering to the
  // password an earlier boot gave it.
  it("retires the account onto a secret nobody is told, so nothing can sign in as it", async () => {
    const { store, writes } = recordingStore(true);
    const bootSecret = generateDevFixturePassword();
    await expect(retireDevFixturePassword("fixture-user", store)).resolves.toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0].userId).toBe("fixture-user");
    // What was stored is a hash of something at or past the floor, and is not
    // this boot's secret — the retired value is minted and dropped unread.
    const hashedLength = Number(/^hash-of-(\d+)-characters$/.exec(writes[0].passwordHash)?.[1]);
    expect(hashedLength).toBeGreaterThanOrEqual(MIN_DEV_FIXTURE_PASSWORD_LENGTH);
    expect(writes[0].passwordHash).not.toContain(bootSecret);
  });

  it("reports that there was nothing to retire when the account has no password", async () => {
    const { store, writes } = recordingStore(false);
    await expect(retireDevFixturePassword("fixture-user", store)).resolves.toBe(false);
    expect(writes).toEqual([]);
  });

  it("never throws on a store that fails — it runs on paths that are already refusing", async () => {
    const store = {
      hasCredentialAccount: async () => true,
      hashPassword: async () => {
        throw new Error("the sign-in store is unavailable");
      },
      updateCredentialPassword: async () => {},
    };
    await expect(retireDevFixturePassword("fixture-user", store)).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. The harnesses read the secret from the environment.
// ---------------------------------------------------------------------------

describe("the harnesses read the secret the instance was started with", () => {
  it("returns the value the instance was started with", () => {
    const supplied = "supplied-to-the-harness-and-long-enough";
    expect(requireInjectedDevFixturePassword({ [DEV_FIXTURE_PASSWORD_ENV]: supplied })).toBe(supplied);
  });

  it("says which setting is missing rather than falling back to anything", () => {
    expect(() => requireInjectedDevFixturePassword({})).toThrow(DEV_FIXTURE_PASSWORD_ENV);
    expect(() => requireInjectedDevFixturePassword({ [DEV_FIXTURE_PASSWORD_ENV]: "  " })).toThrow(
      DEV_FIXTURE_PASSWORD_ENV,
    );
  });

  // The boot IGNORES a supplied value below the floor and mints its own. A
  // harness that accepted the short value would type a password the instance
  // never had, and report an authentication failure that says nothing.
  it("holds a supplied value to the SAME floor the boot applies", () => {
    expect(() => requireInjectedDevFixturePassword({ [DEV_FIXTURE_PASSWORD_ENV]: "too-short" })).toThrow(
      String(MIN_DEV_FIXTURE_PASSWORD_LENGTH),
    );
    const atTheFloor = "x".repeat(MIN_DEV_FIXTURE_PASSWORD_LENGTH);
    expect(requireInjectedDevFixturePassword({ [DEV_FIXTURE_PASSWORD_ENV]: atTheFloor })).toBe(atTheFloor);
  });
});

// ---------------------------------------------------------------------------
// 5. SOURCE WIRING pins — the boot and the harnesses use the rules above.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const DEV_AUTO_SETUP_PATH = path.join(REPO_ROOT, "src", "lib", "dev-auto-setup.ts");
const GLOBAL_SETUP_PATH = path.join(REPO_ROOT, "tests", "e2e", "wp-drupal-uat", "global-setup.ts");
const HELPERS_PATH = path.join(REPO_ROOT, "tests", "e2e", "wp-drupal-uat", "helpers.ts");

function readSource(p: string): string {
  return fs.readFileSync(p, "utf8");
}
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
function extractFunctionBody(source: string, fnName: string): string {
  const decl = `export async function ${fnName}(`;
  const startIdx = source.indexOf(decl);
  if (startIdx < 0) throw new Error(`extractFunctionBody: '${fnName}' not found`);
  const openBrace = source.indexOf("{", startIdx);
  if (openBrace < 0) throw new Error(`extractFunctionBody: '${fnName}' has no opening brace`);
  let depth = 0;
  for (let i = openBrace; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBrace + 1, i);
    }
  }
  throw new Error(`extractFunctionBody: '${fnName}' has unbalanced braces`);
}

describe("the development boot is wired to the fixture-secret rules", () => {
  it("carries no literal fixture password any more", () => {
    const src = readSource(DEV_AUTO_SETUP_PATH);
    expect(src).not.toMatch(/\["cinatra",\s*"uat",\s*"dev"/);
    expect(stripComments(src)).not.toMatch(/DEV_UAT_USER\.password/);
  });

  it("resolves the boot's secret from the shared rules and shows it once", () => {
    const body = stripComments(extractFunctionBody(readSource(DEV_AUTO_SETUP_PATH), "ensureDevConnectActor"));
    expect(body).toMatch(/resolveDevFixturePassword\(/);
    expect(body).toMatch(/printDevFixtureSecretOnce\(/);
  });

  it("refuses a publicly served instance BEFORE it reads or writes anything in the database", () => {
    const body = stripComments(extractFunctionBody(readSource(DEV_AUTO_SETUP_PATH), "ensureDevConnectActor"));
    const refusalIdx = body.indexOf("devFixtureSeedingAllowed(");
    const firstQueryIdx = body.indexOf("runPostgresQueriesSync");
    const signUpIdx = body.indexOf("signUpEmail");
    expect(refusalIdx).toBeGreaterThan(-1);
    expect(firstQueryIdx).toBeGreaterThan(refusalIdx);
    expect(signUpIdx).toBeGreaterThan(refusalIdx);
  });

  it("rotates an account an earlier boot left behind", () => {
    const body = stripComments(extractFunctionBody(readSource(DEV_AUTO_SETUP_PATH), "ensureDevConnectActor"));
    expect(body).toMatch(/rotateDevFixturePassword\(/);
  });

  // Refusing to seed is not enough on an instance that used to be private: an
  // account an earlier boot created is still there, answering to that boot's
  // password. The refusal branch takes the password away.
  it("retires an account an earlier boot left behind when it refuses to seed", () => {
    const body = stripComments(extractFunctionBody(readSource(DEV_AUTO_SETUP_PATH), "ensureDevConnectActor"));
    const refusalIdx = body.indexOf("devFixtureSeedingAllowed(");
    const retireIdx = body.indexOf("retireStaleDevFixtureAccount");
    expect(retireIdx).toBeGreaterThan(refusalIdx);
    const src = stripComments(readSource(DEV_AUTO_SETUP_PATH));
    expect(src).toMatch(/async function retireStaleDevFixtureAccount\(/);
    expect(src).toMatch(/retireDevFixturePassword\(/);
  });

  // A live account whose password nobody was ever told is no use to anybody:
  // the operator is shown it as soon as the account carries it, ahead of the
  // organisation wiring, any step of which can return early.
  it("shows the operator the secret before the wiring that can return early", () => {
    const body = stripComments(extractFunctionBody(readSource(DEV_AUTO_SETUP_PATH), "ensureDevConnectActor"));
    const printIdx = body.indexOf("printDevFixtureSecretOnce");
    const orgIdx = body.indexOf("ensureDefaultOrganizationRow");
    expect(printIdx).toBeGreaterThan(-1);
    expect(orgIdx).toBeGreaterThan(-1);
    expect(orgIdx).toBeGreaterThan(printIdx);
  });

  // Every path that decides NOT to wire the actor takes the password away with
  // it: an account this boot will not wire must leave no credential behind for
  // a harness — or anybody else — to sign in with.
  it("takes the password file away on every path that refuses to wire the actor", () => {
    const body = stripComments(extractFunctionBody(readSource(DEV_AUTO_SETUP_PATH), "ensureDevConnectActor"));
    const printIdx = body.indexOf("printDevFixtureSecretOnce");
    expect(printIdx).toBeGreaterThan(-1);
    const after = body.slice(printIdx);
    const refusalReturns = after.split("return null;").length - 1;
    const removals = after.split("removeDevFixturePasswordFile()").length - 1;
    expect(refusalReturns).toBeGreaterThan(0);
    expect(removals).toBe(refusalReturns);
  });

  it("takes an earlier boot\u2019s password file away when it refuses to seed", () => {

    const body = stripComments(extractFunctionBody(readSource(DEV_AUTO_SETUP_PATH), "ensureDevConnectActor"));
    const refusalIdx = body.indexOf("devFixtureSeedingAllowed(");
    const removeIdx = body.indexOf("removeDevFixturePasswordFile");
    expect(refusalIdx).toBeGreaterThan(-1);
    expect(removeIdx).toBeGreaterThan(refusalIdx);
  });

  it("never writes the secret into the handoff file", () => {
    const src = stripComments(readSource(DEV_AUTO_SETUP_PATH));
    expect(src).toMatch(/type DevConnectActor = \{ userId: string; orgId: string; email: string \}/);
    const body = stripComments(extractFunctionBody(readSource(DEV_AUTO_SETUP_PATH), "ensureDevConnectActor"));
    expect(body).not.toMatch(/JSON\.stringify\(\s*actor/);
  });
});

describe("the end-to-end harness is wired to the fixture-secret rules", () => {
  it("keeps no password in the handoff file's shape", () => {
    expect(stripComments(readSource(GLOBAL_SETUP_PATH))).toMatch(
      /DevActor = \{ userId: string; orgId: string; email: string \}/,
    );
  });

  it("reads the password the instance was started with, in both consumers", () => {
    const globalSetup = stripComments(readSource(GLOBAL_SETUP_PATH));
    const helpers = stripComments(readSource(HELPERS_PATH));
    expect(globalSetup).toContain(DEV_FIXTURE_PASSWORD_ENV);
    expect(globalSetup).toMatch(/readDevActorPassword/);
    expect(helpers).toMatch(/readDevActorPassword/);
    expect(globalSetup).not.toMatch(/actor\.password/);
    expect(helpers).not.toMatch(/actor\.password/);
  });

  // The harness and the instance must agree on which supplied values are
  // usable, or a short one authenticates against a password the instance
  // silently replaced.
  it("holds the supplied password to the same floor the boot applies", () => {
    const globalSetup = stripComments(readSource(GLOBAL_SETUP_PATH));
    expect(globalSetup).toMatch(/MIN_DEV_FIXTURE_PASSWORD_LENGTH = 24/);
    expect(globalSetup).toMatch(/value\.length < MIN_DEV_FIXTURE_PASSWORD_LENGTH/);
  });
});

// ---------------------------------------------------------------------------
// 7. The continuous-integration run treats this boot's password as a per-run
//    minted value, like every other one the job mints.
// ---------------------------------------------------------------------------

describe("the per-run password is covered by the job's leak scrubber and masking check", () => {
  it("is one of the minted values the artifact scrubber removes and the scan looks for", () => {
    const script = readSource(path.join(REPO_ROOT, "scripts", "ci", "uat-diagnostics.sh"));
    const list = /MINTED_KEYS=\(([^)]*)\)/.exec(script)?.[1] ?? "";
    expect(list).toContain(DEV_FIXTURE_PASSWORD_ENV);
  });

  it("is one of the minted values the public-log masking check asserts", () => {
    const script = readSource(path.join(REPO_ROOT, "scripts", "ci", "uat-mask-verify.mjs"));
    const list = /const MINTED_KEYS = \[([^\]]*)\]/.exec(script)?.[1] ?? "";
    expect(list).toContain(DEV_FIXTURE_PASSWORD_ENV);
  });
});
