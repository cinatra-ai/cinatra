import { describe, it, expect, vi } from "vitest";

// Generic-gateway acceptance SKELETON (issue #2016, D8) — present now (compiles;
// skipped/todo legs), so S2/S3/S4 "turn it green" rather than author it.
//
// It deliberately lives HERE (tests/e2e/wp-mcp-gateway/), NOT in packages/llm, to
// keep S1 off S0's broad packages/** code-owner surface (design §6). It extends
// the hoisted-mock pattern of packages/llm/src/external-mcp-toolbox-injection.test.ts
// (mock STATIC_EXTENSION_MANIFEST + buildExternalMcpServerTools, then assert
// injection follows the manifest with ZERO host source change). The fixture it
// enrolls is the third-party dedicated server this S1 PR stands up
// (`fixturelabs-server`, docker/wordpress/fixture-plugin) — confirmed live in the
// committed captures (captures/annotations-a-raw-tools-list.json): six first-class
// tools with annotations transported.
//
// NOTE on execution: tests/e2e/** is not in the root vitest include (so the live
// equivalence.spec.ts never runs in normal PR CI); this skeleton is therefore
// TYPECHECK-covered (tsconfig `**/*.ts`) today and is wired into a vitest run by
// the stage that flips its first leg green. The legs are `it.todo` so they are
// pending (never red) until then.
//
// The hoisted fixture below is the shape each leg will mock. It is data-only (no
// host imports) so the skeleton compiles without pulling S0's packages/** graph.
const h = vi.hoisted(() => {
  // A third-party CONNECTOR extension record that contributes an external-MCP
  // toolbox (the marker S2/S3 enrollment keys off), standing in for the enrolled
  // `fixturelabs-server`.
  const dedicatedServerRecord = {
    packageName: "@cinatra-fixtures/fixturelabs-mcp",
    scope: "cinatra-fixtures",
    kind: "connector" as const,
    version: "1.0.0",
    sourceDir: "extensions/cinatra-fixtures/fixturelabs-mcp",
    providesExternalMcpToolbox: true,
    // The live server + its six tools (annotated + unannotated variants).
    serverId: "fixturelabs-server",
    restRoute: "/wp-json/fixturelabs/fixturelabs-server",
    tools: [
      "fixturelabs-note-get",
      "fixturelabs-note-set",
      "fixturelabs-note-delete",
      "fixturelabs-note-get-unannotated",
      "fixturelabs-note-get-malformed",
      "fixturelabs-note-get-contradictory",
    ],
  };
  return { dedicatedServerRecord };
});

describe("generic gateway — third-party dedicated server auto-enrollment (D8)", () => {
  // SKIPPED until S2/S3 enrollment lands. The body documents the exact assertion
  // the enrollment stage will turn green: mock STATIC_EXTENSION_MANIFEST with
  // h.dedicatedServerRecord + GENERATED_EXTERNAL_MCP_TOOLBOXES, then assert
  // buildExternalMcpServerTools() enrolls `fixturelabs-server` and lists its six
  // tools with ZERO cinatra source change (marker-driven, per the injection test).
  it.skip("auto-enrolls the third-party fixturelabs-server with zero cinatra changes", () => {
    const rec = h.dedicatedServerRecord;
    expect(rec.providesExternalMcpToolbox).toBe(true);
    expect(rec.serverId).toBe("fixturelabs-server");
    expect(rec.tools).toHaveLength(6);
    // S2/S3: assert buildExternalMcpServerTools() enrolls rec.serverId + rec.tools.
  });
  it.todo("makes each enrolled fixturelabs-server tool callable through the gateway");
});

describe("generic gateway — uncapped multi-server tools_list (S2/S3)", () => {
  // Green when multi-server listing lands: with the default server AND the
  // dedicated fixturelabs-server both enrolled, assert the aggregated tools_list
  // is UNCAPPED (no truncation of the second server's tools).
  it.todo("lists tools from multiple enrolled servers without a cap");
});

describe("generic gateway — default config injects nothing provider-direct (S4)", () => {
  // Green when the S4 injection decision consumes the exposure-mode verdict
  // (docker/wordpress/EXPOSURE-MODE.md = triad-only): under the DEFAULT config,
  // assert no gateway-server tools are injected provider-direct (M1/list only).
  it.todo("injects nothing provider-direct for gateway servers under the default config");
});

describe("generic gateway — restricted mode restricts + lists denials (S4)", () => {
  // Green when restricted mode lands: assert an allowlist restricts the enrolled
  // tools AND the denied tools are reported (not silently dropped).
  it.todo("restricts tools under restricted mode and reports the denials");
});
