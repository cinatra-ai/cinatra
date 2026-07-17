/**
 * llm-providers S2 (#1713, AC2) — approval-vocabulary boundary check in the
 * extension toolbox sanitizer.
 *
 * Toolbox modules are extension code: a stale extension build may still emit
 * the retired three-value `requireApproval` vocabulary, and any module can
 * emit garbage. The sanitizer is the ONE boundary every toolbox result
 * crosses, so it enforces:
 *   - unknown `approval` values → entry DROPPED (an unrecognized token must
 *     never fall through to a provider map where it would read as
 *     auto-execute);
 *   - legacy `requireApproval: "always" | "read-only"` → entry DROPPED
 *     (approval INTENT the new key no longer carries — silently auto-executing
 *     it is the exact downgrade AC2 retires);
 *   - legacy `requireApproval: "never"` → key STRIPPED, tool kept (identical
 *     semantics to the `auto_execute` default);
 *   - well-formed entries (absent / auto_execute / approval_required) pass
 *     through unchanged — enforcement of approval_required against a
 *     provider's declared capability is the adapters' job, not the boundary's.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/generated/extensions.server", () => ({
  GENERATED_EXTERNAL_MCP_TOOLBOXES: {},
}));

import type { ExtensionExternalMcpTool } from "@cinatra-ai/sdk-extensions";
import type { LlmMcpServerTool } from "@cinatra-ai/llm";
import { sanitizeExternalMcpToolboxTools } from "@/lib/external-mcp-toolbox-loader.server";

// ---------------------------------------------------------------------------
// Type-level mirror lock (compile-time): `ExtensionExternalMcpTool` is the
// SDK's structural mirror of the host's `LlmMcpServerTool` — a vocabulary
// drift in EITHER direction (e.g. one side renaming/retyping `approval`) must
// fail `pnpm typecheck`, not surface at runtime.
//
// ONE quarantined exception: the SDK side additionally carries the retired
// `requireApproval` as a @deprecated type-level compatibility member, so
// companion extension sources built against the previous SDK still typecheck
// while their migrations land (this boundary's sanitizer strips/drops the
// legacy key fail-closed at runtime). The host type must NEVER gain it — a
// host-constructed tool bypasses this sanitizer, so a type-legal
// `requireApproval: "always"` on the host side would silently serialize as
// auto-execution (the exact downgrade AC2 retires). The canonical mirror is
// therefore compared with the compat key Omit-ed, and the compat key itself is
// locked to exactly the retired vocabulary, SDK-only.
// ---------------------------------------------------------------------------
type CanonicalSdkTool = Omit<ExtensionExternalMcpTool, "requireApproval">;
// (a) SDK → host: every extension-built tool's canonical shape is usable where
// the host expects its own tool shape.
const _sdkAssignableToHost: LlmMcpServerTool = {} as CanonicalSdkTool;
// (b) host → SDK: the host shape satisfies the SDK mirror (no host-only key
// an extension could not produce).
const _hostAssignableToSdk: ExtensionExternalMcpTool = {} as LlmMcpServerTool;
// (c) key-set parity: neither side invents a key the other lacks, beyond the
// quarantined compat key.
type _SdkExtraKeys = Exclude<keyof CanonicalSdkTool, keyof LlmMcpServerTool>;
type _HostExtraKeys = Exclude<keyof LlmMcpServerTool, keyof ExtensionExternalMcpTool>;
const _noSdkExtraKeys: _SdkExtraKeys extends never ? true : false = true;
const _noHostExtraKeys: _HostExtraKeys extends never ? true : false = true;
// (d) the deprecated compat key: present on the SDK side with EXACTLY the
// retired three-value vocabulary (optional), and ABSENT from the host type.
const _compatKeyExactlyRetiredVocab: ExtensionExternalMcpTool["requireApproval"] extends
  | "never"
  | "always"
  | "read-only"
  | undefined
  ? "never" | "always" | "read-only" extends NonNullable<ExtensionExternalMcpTool["requireApproval"]>
    ? true
    : false
  : false = true;
const _hostLacksCompatKey: "requireApproval" extends keyof LlmMcpServerTool ? false : true = true;
void _sdkAssignableToHost;
void _hostAssignableToSdk;
void _noSdkExtraKeys;
void _noHostExtraKeys;
void _compatKeyExactlyRetiredVocab;
void _hostLacksCompatKey;

const base = {
  type: "mcp" as const,
  serverLabel: "fixture",
  serverUrl: "https://fixture.example.test/mcp",
};

describe("sanitizeExternalMcpToolboxTools — approval vocabulary boundary (#1713 AC2)", () => {
  it("passes a tool with NO approval value through unchanged (undefined ⇒ auto_execute downstream)", () => {
    const tools = sanitizeExternalMcpToolboxTools("fixture", [{ ...base }]);
    expect(tools).toEqual([{ ...base }]);
  });

  it("passes auto_execute and approval_required through unchanged", () => {
    const tools = sanitizeExternalMcpToolboxTools("fixture", [
      { ...base, approval: "auto_execute" },
      { ...base, serverLabel: "guarded", approval: "approval_required" },
    ]);
    expect(tools).toEqual([
      { ...base, approval: "auto_execute" },
      { ...base, serverLabel: "guarded", approval: "approval_required" },
    ]);
  });

  it("DROPS a tool carrying an unknown approval value (fail closed, never auto-execute garbage)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tools = sanitizeExternalMcpToolboxTools("fixture", [
        { ...base, approval: "always" },
        { ...base, serverLabel: "ok" },
      ]);
      expect(tools).toEqual([{ ...base, serverLabel: "ok" }]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown approval value"));
    } finally {
      warn.mockRestore();
    }
  });

  it('STRIPS a legacy requireApproval: "never" (identical semantics to the default) and keeps the tool', () => {
    const tools = sanitizeExternalMcpToolboxTools("fixture", [
      { ...base, requireApproval: "never" },
    ]);
    expect(tools).toEqual([{ ...base }]);
    expect(tools[0]).not.toHaveProperty("requireApproval");
  });

  it('DROPS a legacy requireApproval approval intent ("always" / "read-only") instead of auto-executing it', () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tools = sanitizeExternalMcpToolboxTools("fixture", [
        { ...base, requireApproval: "always" },
        { ...base, serverLabel: "ro", requireApproval: "read-only" },
        { ...base, serverLabel: "ok" },
      ]);
      expect(tools).toEqual([{ ...base, serverLabel: "ok" }]);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("retired requireApproval"));
    } finally {
      warn.mockRestore();
    }
  });

  it("still throws on a non-array and still drops structurally invalid entries (pre-existing contract)", () => {
    expect(() => sanitizeExternalMcpToolboxTools("fixture", "nope")).toThrow(/non-array/);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tools = sanitizeExternalMcpToolboxTools("fixture", [{ type: "mcp" }, { ...base }]);
      expect(tools).toEqual([{ ...base }]);
    } finally {
      warn.mockRestore();
    }
  });
});
