import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSchemaConfig } from "@/lib/extension-schema-config";
import { chooseConnectorUiRender, type ConnectorUiManifest } from "@/lib/connector-ui-render";
import { scanHostPeerValueImports } from "@/lib/extension-package-store-core";

// The in-repo schema-config connector fixture (also packed into a tarball by the
// prod-container hot-install proof). These tests lock the contract the
// proof relies on: a valid schema-config manifest, a model-B-clean register entry.
const FIXTURE_DIR = join(__dirname, "fixtures", "schema-config-connector");

function readFixture(rel: string): string {
  return readFileSync(join(FIXTURE_DIR, rel), "utf8");
}

describe("schema-config fixture connector", () => {
  const manifest = JSON.parse(readFixture("package.json")) as {
    cinatra: ConnectorUiManifest & { serverEntry?: string };
  };

  it("declares a schema-config surface with no React", () => {
    expect(manifest.cinatra.uiSurface).toBe("schema-config");
    // Built-artifacts-only contract (cinatra#161): the fixture is packed into a
    // tarball by the prod-container hot-install proof, so its serverEntry must
    // resolve to a concrete Node-importable artifact, not a TS source mirror.
    expect(manifest.cinatra.serverEntry).toBe("./register.mjs");
  });

  it("ships the BUILT register.mjs the serverEntry names (the runtime store materializer's install-time gate)", () => {
    const builtSrc = readFixture("register.mjs");
    // model-B clean: no host-peer VALUE import in the built entry either.
    expect(scanHostPeerValueImports(builtSrc)).toEqual([]);
    expect(builtSrc).toContain("export function register(ctx)");
  });

  it("ships a configSchema that passes the fail-closed parser", () => {
    const parsed = parseSchemaConfig(manifest.cinatra.configSchema);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const kinds = parsed.surface.fields.map((f) => f.kind);
      expect(kinds).toEqual(["secret", "status-probe", "named-action"]);
    }
  });

  it("routes to the schema-config renderer (no bundled React)", () => {
    expect(chooseConnectorUiRender(manifest.cinatra).kind).toBe("schema-config");
  });

  it("imports the host SDK TYPE-ONLY — register.ts carries no host-peer VALUE import (model B)", () => {
    const registerSrc = readFixture("register.ts");
    expect(scanHostPeerValueImports(registerSrc)).toEqual([]);
    // sanity: it really does reference the host SDK (type-only), so the empty
    // scan is meaningful, not a missed file.
    expect(registerSrc).toContain('import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions"');
  });
});
