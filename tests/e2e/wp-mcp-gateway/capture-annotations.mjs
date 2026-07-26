#!/usr/bin/env node
/**
 * Live annotation-transport capture producer for the WP MCP gateway
 * (issue #2016, S1).
 *
 * SCAFFOLD (C0): declares the env contract and the six sub-claim plan (a–f,
 * design §3). The full JSON-RPC / MCP-SDK capture logic lands in C3; this file
 * exists in C0 so (1) the capture workflow's `capture` job has a stable
 * producer path once it activates (docker/wordpress/pins.lock lands in C1), and
 * (2) the workflow path filter (tests/e2e/wp-mcp-gateway/capture-*.mjs) is armed
 * to re-fire the run whenever the producer changes.
 *
 * Runs ONLY on a runner against the booted pinned fixture — never on the box.
 *
 * Env contract (mirrors tests/e2e/proof-capture/capture-permissions.mjs):
 *   WP_BASE_URL       — base URL of the booted fixture (e.g. http://localhost:8080)
 *   WP_MCP_BASIC_AUTH — base64("admin:<app-password>"), minted per-run on the
 *                       throwaway container (no committed secret; the exact
 *                       HTTP Basic scheme from buildBasicAuthHeader).
 *
 * Until C3 fills the sub-claims, this scaffold validates the env, prints the
 * plan, and exits 0 (so a pre-C3 boot proves build+boot without a false red).
 */

// The six annotation-transport sub-claims this producer will emit as verbatim
// transcripts under ./captures/ (design §3). Filled in C3.
const SUB_CLAIMS = [
  ["a", "raw tools/list on default + fixturelabs-server; assert readOnly/destructive hints present"],
  ["b", "MCP SDK Client.listTools() per server; serialize tools[].annotations"],
  ["c", "gateway triad tools/call using names + shapes from adapter-0.5.0-api-map.json"],
  ["d", "eafm annotation coverage incl. delete / search-replace / code-snippet"],
  ["e", "fixturelabs-server unannotated / malformed / contradictory tools, as emitted"],
  ["f", "assert every fixturelabs/* ability surfaces via the eafm/default-server tools/list"],
];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`capture-annotations: missing required env ${name}`);
    process.exit(1);
  }
  return value;
}

function main() {
  const baseUrl = requireEnv("WP_BASE_URL");
  requireEnv("WP_MCP_BASIC_AUTH");

  console.log(`capture-annotations (C0 scaffold) — target ${baseUrl}`);
  console.log("planned sub-claims (design §3, implemented in C3):");
  for (const [id, description] of SUB_CLAIMS) {
    console.log(`  (${id}) ${description}`);
  }
  console.error(
    "capture-annotations.mjs is a C0 scaffold — the full capture (sub-claims a–f, " +
      "committed transcripts) lands in C3 (#2016). Exiting 0.",
  );
}

main();
