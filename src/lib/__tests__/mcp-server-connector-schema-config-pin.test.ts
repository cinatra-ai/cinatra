// cinatra#658 (PR-4) — the PR-3↔PR-4 vocabulary-skew GUARD at the pin.
//
// PR-4's lock step bumps the @cinatra-ai/mcp-server-connector pin to the merged
// PR-3 (schema-config) version, regenerating STATIC_EXTENSION_MANIFEST. This test
// asserts the PINNED connector's declared `configSchema`:
//   (a) parses against THIS PR's extended renderer grammar (no skew), and
//   (b) the host render decision routes it to the schema-config branch (so it
//       renders declaratively WITHOUT a rebuild),
//   (c) every action id it references is one of the four contract actions the
//       connector (read/probe) + the host (createServer/deleteServer) provide.
//
// If PR-3 and PR-4 ever drift (a connector references a DSL field kind the host
// renderer does not implement), THIS test fails at the moment of the pin.

import { describe, it, expect } from "vitest";
import { STATIC_EXTENSION_MANIFEST } from "@/lib/generated/extensions.server";
import { parseSchemaConfig, collectActionIds } from "@/lib/extension-schema-config";
import { chooseConnectorUiRender } from "@/lib/connector-ui-render";
import {
  resolveExtensionUiAction,
  __resetExtensionUiRegistry,
} from "@/lib/extension-ui-registry";
import { registerMcpServerWriteActions } from "@/lib/mcp-server-write-actions";

const PKG = "@cinatra-ai/mcp-server-connector";

describe("mcp-server-connector pin: schema-config renders without rebuild (#658)", () => {
  const manifest = STATIC_EXTENSION_MANIFEST[PKG];

  it("the pinned connector declares a schema-config surface", () => {
    expect(manifest, "mcp-server-connector must be bundled/pinned in the manifest").toBeTruthy();
    expect(manifest?.uiSurface).toBe("schema-config");
    expect(manifest?.configSchema).toBeTruthy();
  });

  it("its configSchema parses against PR-4's extended renderer grammar", () => {
    const parsed = parseSchemaConfig(manifest?.configSchema);
    if (!parsed.ok) console.error("configSchema parse errors:", parsed.errors);
    expect(parsed.ok).toBe(true);
  });

  it("the host render decision routes it to the schema-config (no-rebuild) branch", () => {
    const render = chooseConnectorUiRender(manifest);
    expect(render.kind).toBe("schema-config");
  });

  it("references only the four contract action ids", () => {
    const parsed = parseSchemaConfig(manifest?.configSchema);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const ids = collectActionIds(parsed.surface).sort();
      // listServers + connectionServiceReady (connector read/probe) +
      // createServer + deleteServer (host write actions).
      expect(ids).toEqual(
        ["connectionServiceReady", "createServer", "deleteServer", "listServers"].sort(),
      );
    }
  });

  it("host write-action binding DISCOVERS the package from the manifest (no hardcoded name)", () => {
    // registerMcpServerWriteActions reads the generated manifest to find the
    // package declaring both write action ids, then binds the host handlers into
    // the ui-action registry for it — proving the instance-coupling-free wiring.
    __resetExtensionUiRegistry();
    registerMcpServerWriteActions();
    expect(resolveExtensionUiAction(PKG, "createServer")).toBeTruthy();
    expect(resolveExtensionUiAction(PKG, "deleteServer")).toBeTruthy();
    __resetExtensionUiRegistry();
  });
});
