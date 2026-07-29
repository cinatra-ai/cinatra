import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// cinatra#1927 — the host reader that resolves the DECLARED protection of an
// installed package from its materialized `cinatra/config.json`. This is the
// production default behind the removal gates' injectable reader, so its
// absence-vs-corruption split IS the gate's fail-open/fail-closed boundary:
//
//   absent declaration  → false  (every extension in the fleet today; an
//                                 ordinary uninstall must stay unaffected)
//   present but broken  → THROW  (we cannot prove removability → refuse)

import {
  readDeclaredProtectionFromStore,
  resolveDeclaredProtectionForPackage,
  ExtensionProtectionReadError,
} from "@/lib/extension-protection-host";

let root: string;

async function makePackage(
  dirName: string,
  config: string | null,
  opts: { noCinatraDir?: boolean } = {},
): Promise<string> {
  const dir = join(root, dirName);
  await mkdir(dir, { recursive: true });
  if (!opts.noCinatraDir && config !== null) {
    await mkdir(join(dir, "cinatra"), { recursive: true });
    await writeFile(join(dir, "cinatra", "config.json"), config, "utf8");
  }
  return dir;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cinatra-1927-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

describe("readDeclaredProtectionFromStore — absence is a provable non-protection", () => {
  it("returns FALSE when the package ships no cinatra/ dir at all", async () => {
    const dir = await makePackage("no-cinatra", null, { noCinatraDir: true });
    await expect(readDeclaredProtectionFromStore(dir, "@acme/x")).resolves.toBe(false);
  });

  it("returns FALSE when the store dir does not exist", async () => {
    await expect(
      readDeclaredProtectionFromStore(join(root, "does-not-exist"), "@acme/x"),
    ).resolves.toBe(false);
  });

  it("returns FALSE for a valid config with no `protected` key", async () => {
    const dir = await makePackage("no-flag", JSON.stringify({ formatVersion: 1 }));
    await expect(readDeclaredProtectionFromStore(dir, "@acme/x")).resolves.toBe(false);
  });

  it("returns FALSE for an explicit `protected: false`", async () => {
    const dir = await makePackage("flag-false", JSON.stringify({ formatVersion: 1, protected: false }));
    await expect(readDeclaredProtectionFromStore(dir, "@acme/x")).resolves.toBe(false);
  });
});

describe("readDeclaredProtectionFromStore — a declared flag is honored, kind-agnostically", () => {
  it("returns TRUE for an ASSISTANT (agent-kind) declaration", async () => {
    const dir = await makePackage(
      "agent-protected",
      JSON.stringify({
        formatVersion: 1,
        protected: true,
        assistant: {
          abiVersion: 1,
          displayName: "Example",
          preferredTag: "example",
          persona: "…",
          skillBundle: ["chat-assistant-core"],
          launch: { kind: "local" },
          delivery: { kind: "host-runtime" },
        },
      }),
    );
    await expect(readDeclaredProtectionFromStore(dir, "@acme/agent")).resolves.toBe(true);
  });

  it("returns TRUE for a CONNECTOR declaration (the reader never inspects the kind)", async () => {
    const dir = await makePackage(
      "connector-protected",
      JSON.stringify({ formatVersion: 1, protected: true, access: { scope: { only: "admin" } } }),
    );
    await expect(readDeclaredProtectionFromStore(dir, "@acme/connector")).resolves.toBe(true);
  });

  it("returns TRUE for a bare declaration carrying only the flag", async () => {
    const dir = await makePackage("bare-protected", JSON.stringify({ formatVersion: 1, protected: true }));
    await expect(readDeclaredProtectionFromStore(dir, "@acme/bare")).resolves.toBe(true);
  });
});

describe("readDeclaredProtectionFromStore — corruption FAILS CLOSED", () => {
  it("THROWS on a config that is not valid JSON", async () => {
    const dir = await makePackage("bad-json", "{ not json");
    await expect(readDeclaredProtectionFromStore(dir, "@acme/x")).rejects.toBeInstanceOf(
      ExtensionProtectionReadError,
    );
  });

  it("THROWS on a non-boolean `protected` — never coerced to a truthy/falsy verdict", async () => {
    const dir = await makePackage("bad-flag", JSON.stringify({ formatVersion: 1, protected: "true" }));
    await expect(readDeclaredProtectionFromStore(dir, "@acme/x")).rejects.toMatchObject({
      code: "INVALID_PROTECTION_DECLARATION",
    });
  });

  it("THROWS when the config exists but is unreadable", async () => {
    const dir = await makePackage("unreadable", JSON.stringify({ formatVersion: 1, protected: true }));
    const file = join(dir, "cinatra", "config.json");
    await chmod(file, 0o000);
    try {
      // Root ignores mode bits; skip the assertion rather than assert a false
      // negative in a container that runs as uid 0.
      const readableAnyway = await readDeclaredProtectionFromStore(dir, "@acme/x").then(
        () => true,
        () => false,
      );
      if (readableAnyway) return;
      await expect(readDeclaredProtectionFromStore(dir, "@acme/x")).rejects.toBeInstanceOf(
        ExtensionProtectionReadError,
      );
    } finally {
      await chmod(file, 0o644).catch(() => undefined);
    }
  });
});

describe("resolveDeclaredProtectionForPackage — package-level resolution", () => {
  it("returns FALSE when the package has no materialized record", async () => {
    await expect(
      resolveDeclaredProtectionForPackage("@acme/absent", { listStoreRecords: async () => [] }),
    ).resolves.toBe(false);
  });

  it("only inspects records for the REQUESTED package", async () => {
    const inspected: string[] = [];
    await resolveDeclaredProtectionForPackage("@acme/wanted", {
      resolveActiveDigest: async () => null,
      listStoreRecords: async () => [
        { packageName: "@acme/other", storeDir: "/s/other" },
        { packageName: "@acme/wanted", storeDir: "/s/wanted" },
      ],
      readFromStoreDir: async (storeDir) => {
        inspected.push(storeDir);
        return false;
      },
    });
    expect(inspected).toEqual(["/s/wanted"]);
  });

  it("with NO anchor it is the OR across a package's records (fail-safe fallback)", async () => {
    await expect(
      resolveDeclaredProtectionForPackage("@acme/multi", {
        listStoreRecords: async () => [
          { packageName: "@acme/multi", storeDir: "/s/v1" },
          { packageName: "@acme/multi", storeDir: "/s/v2" },
        ],
        readFromStoreDir: async (storeDir) => storeDir === "/s/v2",
        resolveActiveDigest: async () => null,
      }),
    ).resolves.toBe(true);
  });

  // codex round-1 (SEV med): a stale pre-GC digest of a formerly-protected
  // version must NOT make the CURRENT, unprotected install unremovable.
  it("ANCHOR-BOUND: a stale protected digest does NOT block the active unprotected install", async () => {
    await expect(
      resolveDeclaredProtectionForPackage("@acme/multi", {
        listStoreRecords: async () => [
          { packageName: "@acme/multi", storeDir: "/s/old", declaredDigest: "d-old" },
          { packageName: "@acme/multi", storeDir: "/s/new", declaredDigest: "d-new" },
        ],
        // The OLD (stale) materialization declared protection; the ACTIVE one does not.
        readFromStoreDir: async (storeDir) => storeDir === "/s/old",
        resolveActiveDigest: async () => "d-new",
      }),
    ).resolves.toBe(false);
  });

  it("ANCHOR-BOUND: the ACTIVE digest's declaration is honored", async () => {
    await expect(
      resolveDeclaredProtectionForPackage("@acme/multi", {
        listStoreRecords: async () => [
          { packageName: "@acme/multi", storeDir: "/s/old", declaredDigest: "d-old" },
          { packageName: "@acme/multi", storeDir: "/s/new", declaredDigest: "d-new" },
        ],
        readFromStoreDir: async (storeDir) => storeDir === "/s/new",
        resolveActiveDigest: async () => "d-new",
      }),
    ).resolves.toBe(true);
  });

  it("falls back to the fail-safe OR when the anchored digest is not materialized", async () => {
    await expect(
      resolveDeclaredProtectionForPackage("@acme/multi", {
        listStoreRecords: async () => [
          { packageName: "@acme/multi", storeDir: "/s/old", declaredDigest: "d-old" },
        ],
        readFromStoreDir: async () => true,
        resolveActiveDigest: async () => "d-missing",
      }),
    ).resolves.toBe(true);
  });

  it("propagates a reader throw (fail-closed all the way up to the gate)", async () => {
    await expect(
      resolveDeclaredProtectionForPackage("@acme/broken", {
        resolveActiveDigest: async () => null,
        listStoreRecords: async () => [{ packageName: "@acme/broken", storeDir: "/s/x" }],
        readFromStoreDir: async () => {
          throw new ExtensionProtectionReadError("boom");
        },
      }),
    ).rejects.toBeInstanceOf(ExtensionProtectionReadError);
  });
});
