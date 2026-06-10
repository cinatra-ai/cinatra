// Extension → host/SDK compatibility module: the manifest reader, the
// loaders-parity verdict, and the actionable refusal message shared by the
// registry install pipeline and the workflow install saga.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SDK_EXTENSIONS_ABI_VERSION } from "@cinatra-ai/sdk-extensions";

import {
  evaluateHostSdkCompat,
  formatHostSdkCompatRefusal,
  readDeclaredHostCompatFromStore,
} from "@/lib/extension-host-compat";

function tmpStoreDir(pkgJson: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-compat-"));
  if (pkgJson !== null) fs.writeFileSync(path.join(dir, "package.json"), pkgJson);
  return dir;
}

describe("readDeclaredHostCompatFromStore", () => {
  it("reads a declared cinatra.sdkAbiRange from the materialized package.json", async () => {
    const dir = tmpStoreDir(JSON.stringify({ name: "@cinatra-ai/x", cinatra: { sdkAbiRange: "^2" } }));
    expect(await readDeclaredHostCompatFromStore(dir)).toEqual({ sdkAbiRange: "^2" });
  });

  it("reads null when the manifest declares no range (unpinned)", async () => {
    const dir = tmpStoreDir(JSON.stringify({ name: "@cinatra-ai/x", cinatra: {} }));
    expect(await readDeclaredHostCompatFromStore(dir)).toEqual({ sdkAbiRange: null });
  });

  it("reads null for a non-string declaration", async () => {
    const dir = tmpStoreDir(JSON.stringify({ name: "@cinatra-ai/x", cinatra: { sdkAbiRange: 2 } }));
    expect(await readDeclaredHostCompatFromStore(dir)).toEqual({ sdkAbiRange: null });
  });

  it("reads null for a missing or unparseable package.json", async () => {
    expect(await readDeclaredHostCompatFromStore(tmpStoreDir(null))).toEqual({ sdkAbiRange: null });
    expect(await readDeclaredHostCompatFromStore(tmpStoreDir("{ NOT JSON"))).toEqual({ sdkAbiRange: null });
  });
});

describe("evaluateHostSdkCompat (loaders-parity verdict)", () => {
  const hostMajor = Number(SDK_EXTENSIONS_ABI_VERSION.split(".")[0]);

  it("compatible for an undeclared / wildcard range (unpinned)", () => {
    expect(evaluateHostSdkCompat(null).compatible).toBe(true);
    expect(evaluateHostSdkCompat(undefined).compatible).toBe(true);
    expect(evaluateHostSdkCompat("*").compatible).toBe(true);
    expect(evaluateHostSdkCompat("").compatible).toBe(true);
  });

  it("compatible when the host ABI satisfies the declared range", () => {
    expect(evaluateHostSdkCompat(`^${hostMajor}`).compatible).toBe(true);
    expect(evaluateHostSdkCompat(SDK_EXTENSIONS_ABI_VERSION).compatible).toBe(true);
    expect(evaluateHostSdkCompat(`>=1`).compatible).toBe(true);
  });

  it("incompatible (fail closed) when the host ABI is outside the declared range", () => {
    expect(evaluateHostSdkCompat(`^${hostMajor + 1}`).compatible).toBe(false);
    expect(evaluateHostSdkCompat(`>=${hostMajor + 1}`).compatible).toBe(false);
    expect(evaluateHostSdkCompat(`${hostMajor - 1}`).compatible).toBe(false);
  });

  it("incompatible (fail closed) for a malformed range", () => {
    expect(evaluateHostSdkCompat("not-a-range").compatible).toBe(false);
    expect(evaluateHostSdkCompat("^1 || ^2").compatible).toBe(false);
  });

  it("reports the host ABI version for error surfaces", () => {
    expect(evaluateHostSdkCompat("*").hostAbiVersion).toBe(SDK_EXTENSIONS_ABI_VERSION);
  });
});

describe("formatHostSdkCompatRefusal (actionable error)", () => {
  it("names the op, package@version, the declared range, the host ABI, and the remedy", () => {
    const msg = formatHostSdkCompatRefusal({
      op: "update",
      packageName: "@cinatra-ai/foo",
      version: "1.2.3",
      sdkAbiRange: "^99",
    });
    expect(msg).toContain("update of @cinatra-ai/foo@1.2.3 refused");
    expect(msg).toContain('cinatra.sdkAbiRange "^99"');
    expect(msg).toContain(`@cinatra-ai/sdk-extensions ABI ${SDK_EXTENSIONS_ABI_VERSION}`);
    expect(msg).toContain("upgrade the host");
    expect(msg).toContain("previously installed version (if any) is untouched");
  });
});
