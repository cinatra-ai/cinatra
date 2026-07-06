// cinatra#976 (epic #978 W-D) — the vendor-neutral dev-auto-setup ORCHESTRATION
// SHELL. The per-vendor provisioning moved into the owning connector
// `dev-setup.ts` hooks; this suite covers the shell's OWN surface: the generic
// helpers + their dev/loopback/allowlist guards (the runtime constraints codex
// flagged on the #1026 contract). The hook discovery + import path is exercised
// end-to-end on the live docker stack (out-of-scope here; live-stack UAT).
//
// SECRET BOUNDARY: assertions only ever check booleans/strings — never a
// credential.

import { describe, expect, it, vi, beforeEach } from "vitest";

// `server-only` is auto-stubbed by the root vitest alias.
const spawnSync = vi.fn();
vi.mock("node:child_process", () => ({ spawnSync: (...args: unknown[]) => spawnSync(...args) }));

import { trimTrailingSlashes, probeHttpAnswered } from "@/lib/dev-auto-setup";

// These helpers are loopback-gated but NOT dev-gated (they only READ; the
// dev/container gates cover the docker-exec + mint writers), so the suite needs
// no runtime-mode stubbing.
beforeEach(() => {
  vi.clearAllMocks();
});

describe("trimTrailingSlashes (linear, ReDoS-safe)", () => {
  it("strips one or many trailing slashes without touching the rest", () => {
    expect(trimTrailingSlashes("http://localhost:8080///")).toBe("http://localhost:8080");
    expect(trimTrailingSlashes("http://localhost:8080")).toBe("http://localhost:8080");
    expect(trimTrailingSlashes("/")).toBe("");
    expect(trimTrailingSlashes("")).toBe("");
  });
});

describe("probeHttpAnswered — loopback gate + no shell interpolation", () => {
  it("refuses a non-loopback URL WITHOUT spawning curl (loopback hard-gate)", () => {
    expect(probeHttpAnswered("http://evil.example.com/")).toBe(false);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("refuses a non-http(s) loopback scheme WITHOUT spawning curl (protocol gate)", () => {
    expect(probeHttpAnswered("file://localhost/etc/passwd")).toBe(false);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("probes a loopback URL argv-based (curl invoked with an argv array, no shell string)", () => {
    spawnSync.mockReturnValue({ status: 0, stdout: "200" });
    expect(probeHttpAnswered("http://localhost:8080/")).toBe(true);
    expect(spawnSync).toHaveBeenCalledTimes(1);
    const [cmd, argv, opts] = spawnSync.mock.calls[0];
    expect(cmd).toBe("curl");
    expect(Array.isArray(argv)).toBe(true);
    // The URL is a discrete argv element — never concatenated into a shell string.
    expect(argv).toContain("http://localhost:8080/");
    // No `shell: true` — argv is executed directly.
    expect((opts as { shell?: boolean }).shell).toBeUndefined();
  });

  it("treats a curl '000' (no HTTP response) as unreachable", () => {
    spawnSync.mockReturnValue({ status: 0, stdout: "000" });
    expect(probeHttpAnswered("http://127.0.0.1:9999/")).toBe(false);
  });

  it("treats a non-zero curl exit (connection refused) as unreachable", () => {
    spawnSync.mockReturnValue({ status: 7, stdout: "" });
    expect(probeHttpAnswered("http://localhost:8080/")).toBe(false);
  });
});
