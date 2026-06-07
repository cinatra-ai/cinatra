// Hermetic guard for `cinatra dev tunnel`.
//
// `runDevTunnel`'s `start` path requires Docker + Tailscale + a Nango
// token + the main app DB, so it CANNOT be exercised end-to-end in a
// hermetic unit test. What this suite locks instead is the set of
// safety-critical STRUCTURAL invariants, none of which need Docker/network:
//
//   1. REUSE, NOT DUPLICATION: the clone-start provisioning helpers are
//      each defined EXACTLY ONCE in index.mjs. `runDevTunnel` must call
//      them by reference, never fork a copy. A copy-paste would make this
//      assertion fail.
//
//   2. DEV-ONLY HARD REFUSAL: invoking `dev tunnel <action>` with
//      CINATRA_RUNTIME_MODE=production throws the `development-only`
//      refusal BEFORE any Docker / Nango / DB side effect. The gate is
//      the very first thing after reading env.
//
//   3. CLONE-START PARITY: `runDevTunnel` uses the SAME shared hostname
//      decision module (`verifyRegisteredHostnameMatchesPrediction` +
//      `shouldWritePublicBaseUrl`) and carries the byte-identical
//      optimistic-write + one-honest-log-line markers as `runCloneStart`.
//      The dead detached poll must stay removed from both paths.
//
// All three are asserted from the index.mjs SOURCE TEXT (1 + 3) or via a
// `runCli` call that throws before touching anything (2).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { runCli } from "../src/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = readFileSync(
  path.join(HERE, "..", "src", "index.mjs"),
  "utf8",
);

function defCount(name) {
  // function declarations only (`function NAME(` / `async function NAME(`).
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`, "g");
  return (INDEX_SRC.match(re) ?? []).length;
}

// --- 1. reuse, not duplication -------------------------------------------

describe("dev tunnel — reuses clone-start machinery (no duplication)", () => {
  it("runDevTunnel is defined exactly once", () => {
    expect(defCount("runDevTunnel")).toBe(1);
  });

  it.each([
    "renderCloneComposeTemplate",
    "writeTailscaleServeConfig",
    "waitForTailscaleFunnelUrl",
    "writeClonePublicBaseUrl",
    "autoMintTailscaleAuthKeyFromNango",
    "probeHttp",
  ])("clone-start helper %s is defined exactly once (not forked)", (name) => {
    expect(defCount(name)).toBe(1);
  });

  it("runDevTunnel calls the shared helpers by reference", () => {
    // Slice out the runDevTunnel body so we assert the *call sites* live
    // inside it (not merely somewhere in the file).
    const start = INDEX_SRC.indexOf("async function runDevTunnel(");
    expect(start).toBeGreaterThan(-1);
    const nextFn = INDEX_SRC.indexOf("\nfunction readPidFromFile(", start);
    expect(nextFn).toBeGreaterThan(start);
    const body = INDEX_SRC.slice(start, nextFn);
    for (const helper of [
      "renderCloneComposeTemplate(",
      "writeTailscaleServeConfig(",
      "waitForTailscaleFunnelUrl(",
      "writeClonePublicBaseUrl(",
      "autoMintTailscaleAuthKeyFromNango(",
      "verifyRegisteredHostnameMatchesPrediction(",
      "shouldWritePublicBaseUrl(",
      "cloneComposePath(",
      "cloneTailscaleServePath(",
      "cloneComposeProjectName(",
      "cloneRuntimeDir(",
      "deriveDevTailscaleHostname(",
    ]) {
      expect(body.includes(helper)).toBe(true);
    }
  });
});

// --- 2. dev-only hard refusal --------------------------------------------

describe("dev tunnel — development-only hard gate", () => {
  it.each(["start", "stop", "status"])(
    "refuses `dev tunnel %s` under CINATRA_RUNTIME_MODE=production before any side effect",
    async (action) => {
      const prev = process.env.CINATRA_RUNTIME_MODE;
      process.env.CINATRA_RUNTIME_MODE = "production";
      try {
        await expect(runCli(["dev", "tunnel", action])).rejects.toThrow(
          /cinatra dev tunnel is development-only/,
        );
      } finally {
        if (prev === undefined) delete process.env.CINATRA_RUNTIME_MODE;
        else process.env.CINATRA_RUNTIME_MODE = prev;
      }
    },
  );

  it("rejects an unknown dev tunnel sub-command", async () => {
    const prev = process.env.CINATRA_RUNTIME_MODE;
    // Even in development mode, a bad sub-action must throw the usage
    // error (sub-action parse happens before the dev gate is moot).
    process.env.CINATRA_RUNTIME_MODE = "development";
    try {
      await expect(runCli(["dev", "tunnel", "bogus"])).rejects.toThrow(
        /Unknown 'cinatra dev tunnel' sub-command/,
      );
    } finally {
      if (prev === undefined) delete process.env.CINATRA_RUNTIME_MODE;
      else process.env.CINATRA_RUNTIME_MODE = prev;
    }
  });
});

// --- 3. clone-start parity ------------------------------------------------

describe("dev tunnel — matches runCloneStart hostname and public URL behavior", () => {
  const start = INDEX_SRC.indexOf("async function runDevTunnel(");
  const nextFn = INDEX_SRC.indexOf("\nfunction readPidFromFile(", start);
  const body = INDEX_SRC.slice(start, nextFn);

  it("guards the RAW registered Self.DNSName without circular validation", () => {
    expect(
      body.includes(
        "verifyRegisteredHostnameMatchesPrediction({\n      registered: registeredDnsName,",
      ),
    ).toBe(true);
  });

  it("writes publicBaseUrl optimistically gated only by shouldWritePublicBaseUrl", () => {
    expect(
      body.includes(
        "if (shouldWritePublicBaseUrl({ funnelUrl, hostnameCheck })) {",
      ),
    ).toBe(true);
    expect(
      body.includes("await writeClonePublicBaseUrl(mainDbUrl, funnelUrl, { source: urlSource })"),
    ).toBe(true);
  });

  it("preserves the tailscale-auto / tailscale-funnel source tagging", () => {
    expect(
      body.includes(
        'tailscaleAuthkeySource === "nango" ? "tailscale-auto" : "tailscale-funnel"',
      ),
    ).toBe(true);
  });

  it("emits ONE honest informational log line, NOT a probe", () => {
    // The detached 5-minute /api/mcp/health poll must stay deleted. It is
    // architecturally incoherent in a one-shot CLI: it can run once, then
    // the process exits on event-loop drain. The optimistic write is
    // followed by a single accurate log line; reachability is propagation
    // timing outside the CLI lifecycle.
    expect(
      body.includes("publicBaseUrl written (source: ${urlSource}). Tailscale Funnel"),
    ).toBe(true);
    expect(body.includes("(One-shot CLI does not ")).toBe(true);
    // The dead poll's /api/mcp/health PROBE CALL must be entirely gone
    // (no probe of pollFunnelUrl anywhere in runDevTunnel).
    const probeCalls =
      body.match(/probeHttp\(`\$\{pollFunnelUrl\}\/api\/mcp\/health`/g)
        ?.length ?? 0;
    expect(probeCalls).toBe(0);
  });

  it("keeps the dev-tunnel Tailscale block free of setTimeout or detached polling", () => {
    // Hard guard against the dead 5-min poll IIFE returning. None of the
    // poll's structural signatures may exist anywhere in runDevTunnel.
    expect(body.includes("void (async () => {")).toBe(false);
    expect(body.includes("setTimeout(")).toBe(false);
    expect(body.includes("timer.unref")).toBe(false);
    expect(body.includes("pollProjectName")).toBe(false);
    expect(body.includes("pollFunnelUrl")).toBe(false);
    expect(body.includes("MCP health via Funnel")).toBe(false);
    expect(body.includes("background check")).toBe(false);
    expect(body.includes("not yet reachable after 5m")).toBe(false);
    // Nor the old synchronous probe gate.
    expect(body.includes("mcpProbe")).toBe(false);
  });

  it("fails loud with NO write on a hostname-collision mismatch", () => {
    // Guard mismatch ⇒ shouldWritePublicBaseUrl returns false ⇒ the typed
    // TailscaleProvisionError branch logs "publicBaseUrl NOT written" and
    // no writeClonePublicBaseUrl runs on that path.
    expect(body.includes("const err = hostnameCheck.error;")).toBe(true);
    expect(body.includes("err instanceof TailscaleProvisionError")).toBe(true);
    expect(body.includes("publicBaseUrl NOT written.")).toBe(true);
  });

  it("brings up ONLY the tailscale compose service with an inert WAYFLOW_PORT", () => {
    expect(
      body.includes('"up",\n    "-d",\n    "tailscale",'),
    ).toBe(true);
    expect(body.includes("DEV_MAIN_UNUSED_WAYFLOW_PORT")).toBe(true);
  });

  it("uses the reserved dev-main slug and asserts no real clone collides", () => {
    expect(body.includes('const DEV_MAIN_SLUG = "dev-main";')).toBe(true);
    expect(
      body.includes("getClone(readRegistry(defaultRegistryPath()), DEV_MAIN_SLUG)"),
    ).toBe(true);
  });
});
