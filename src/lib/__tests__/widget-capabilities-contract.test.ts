import { describe, expect, it } from "vitest";

import {
  SUPPORTED_CONTRACT_VERSIONS,
  CURRENT_CONTRACT_VERSION,
} from "@/lib/wp-drupal-contract";
import { buildCapabilities } from "@/lib/widget-capabilities";

// ---------------------------------------------------------------------------
// buildCapabilities() is the server side of the widget capability/version
// negotiation. Since the local widget treats /capabilities as a HARD
// PREREQUISITE — it refuses to mount on ANY missing required field, missing
// mutual contract version, or supportsTokenExchange !== true (cinatra#220, the
// "drop the old-instance fallback" change) — this test pins the contract
// guarantee that a HEALTHY instance always emits every field the strict client
// validates, so the client can never false-trip into the unavailable chrome.
// ---------------------------------------------------------------------------
describe("buildCapabilities contract guarantee (strict-client negotiation)", () => {
  const caps = buildCapabilities("wordpress-content-editor");

  it("advertises a non-empty supportedContractVersions array", () => {
    expect(Array.isArray(caps.supportedContractVersions)).toBe(true);
    expect(caps.supportedContractVersions.length).toBeGreaterThan(0);
    expect(caps.supportedContractVersions).toEqual([...SUPPORTED_CONTRACT_VERSIONS]);
  });

  it("includes the current contract version among the supported set (mutual version is always resolvable)", () => {
    expect(caps.supportedContractVersions).toContain(CURRENT_CONTRACT_VERSION);
  });

  it("advertises supportsTokenExchange:true — the broker token is the only client stream-auth model", () => {
    expect(caps.capabilities.supportsTokenExchange).toBe(true);
  });

  it("advertises a non-empty streamPath and tokenPath (both required by the strict client)", () => {
    expect(typeof caps.capabilities.streamPath).toBe("string");
    expect(caps.capabilities.streamPath.length).toBeGreaterThan(0);
    expect(caps.capabilities.streamPath).toBe(
      "/api/agents/wordpress-content-editor/stream",
    );
    expect(typeof caps.capabilities.tokenPath).toBe("string");
    expect(caps.capabilities.tokenPath.length).toBeGreaterThan(0);
    expect(caps.capabilities.tokenPath).toBe(
      "/api/agents/wordpress-content-editor/token",
    );
  });

  it("emits the forward flags as explicit booleans (opt-in: absent flag DISABLES the client behavior)", () => {
    // The client enables a behavior ONLY when the flag is === true. A healthy
    // instance advertises both, so apply-changes + markdown stay enabled.
    expect(caps.capabilities.supportsChangesFrame).toBe(true);
    expect(caps.capabilities.supportsMarkdown).toBe(true);
  });

  it("emits the frozen SSE frame list", () => {
    expect(caps.capabilities.sseFrames).toEqual(["text", "changes", "error", "done"]);
  });
});
