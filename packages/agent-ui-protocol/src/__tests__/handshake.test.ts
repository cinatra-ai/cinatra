import { describe, expect, it } from "vitest";

import { ASSISTANT_STREAM_CONTRACT_VERSION } from "../contract";
import {
  buildAssistantStreamCapabilities,
  compareContractVersions,
  negotiateContract,
  negotiateStreamContract,
} from "../handshake";

describe("buildAssistantStreamCapabilities", () => {
  it("advertises the current contract, resumable SSE, and defaults", () => {
    const caps = buildAssistantStreamCapabilities({ auth: ["session"] });
    expect(caps.contract).toBe(ASSISTANT_STREAM_CONTRACT_VERSION);
    expect([...caps.supportedContracts]).toEqual([ASSISTANT_STREAM_CONTRACT_VERSION]);
    expect(caps.resumable).toBe(true);
    expect(caps.transport).toBe("sse");
    expect([...caps.auth]).toEqual(["session"]);
    expect([...caps.renderableViews]).toEqual([]);
  });

  it("carries the surface's auth modes + emittable renderable views", () => {
    const caps = buildAssistantStreamCapabilities({
      auth: ["token-broker"],
      renderableViews: ["content_change_proposal", "artifact_preview"],
    });
    expect([...caps.auth]).toEqual(["token-broker"]);
    expect([...caps.renderableViews]).toEqual([
      "content_change_proposal",
      "artifact_preview",
    ]);
  });

  // Acceptance (#1217): "no bespoke frame or contractVersion names remain in
  // the contract." The handshake must not resurrect the retired `/capabilities`
  // vocabulary — no `contractVersion`, no frozen `sseFrames` list, no
  // per-behavior `supports*` flags.
  it("carries NONE of the retired `/capabilities` field names", () => {
    const caps = buildAssistantStreamCapabilities({
      auth: ["session", "token-broker"],
      renderableViews: ["content_change_proposal"],
    });
    const keys = Object.keys(caps);
    for (const retired of [
      "contractVersion",
      "sseFrames",
      "supportsChangesFrame",
      "supportsMarkdown",
      "supportsTokenExchange",
      "streamPath",
      "tokenPath",
    ]) {
      expect(keys).not.toContain(retired);
    }
  });
});

describe("compareContractVersions", () => {
  it("orders semver-shaped versions numerically per segment", () => {
    expect(compareContractVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareContractVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareContractVersions("1.2.0", "1.10.0")).toBeLessThan(0); // 2 < 10, not lexical
    expect(compareContractVersions("1.0", "1.0.0")).toBe(0); // missing segment == 0
    expect(compareContractVersions("1.0.1", "1.0")).toBeGreaterThan(0);
  });
});

describe("negotiateContract", () => {
  it("picks the highest mutually-supported version", () => {
    const result = negotiateContract(["1.0.0", "1.1.0"], {
      supportedContracts: ["1.0.0", "1.1.0", "2.0.0"],
    });
    expect(result).toEqual({ ok: true, contract: "1.1.0" });
  });

  it("fails closed with both lists when there is no mutual version", () => {
    const result = negotiateContract(["3.0.0"], {
      supportedContracts: ["1.0.0", "2.0.0"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("no_mutual_contract");
      expect([...result.clientSupported]).toEqual(["3.0.0"]);
      expect([...result.serverSupported]).toEqual(["1.0.0", "2.0.0"]);
    }
  });

  it("negotiates the current single-version contract with itself", () => {
    const caps = buildAssistantStreamCapabilities({ auth: ["session"] });
    const result = negotiateContract([ASSISTANT_STREAM_CONTRACT_VERSION], caps);
    expect(result).toEqual({
      ok: true,
      contract: ASSISTANT_STREAM_CONTRACT_VERSION,
    });
  });
});

describe("negotiateStreamContract (version + auth + required views)", () => {
  const server = buildAssistantStreamCapabilities({
    auth: ["token-broker"],
    renderableViews: ["content_change_proposal", "artifact_preview"],
  });

  it("succeeds when version, auth, and required views all agree", () => {
    const result = negotiateStreamContract(
      {
        supportedContracts: [ASSISTANT_STREAM_CONTRACT_VERSION],
        authMode: "token-broker",
        requiredViews: ["content_change_proposal"],
        requiresResumable: true,
      },
      server,
    );
    expect(result).toEqual({
      ok: true,
      contract: ASSISTANT_STREAM_CONTRACT_VERSION,
      authMode: "token-broker",
      requiredViews: ["content_change_proposal"],
    });
  });

  it("succeeds with no required views (client renders what it knows)", () => {
    const result = negotiateStreamContract(
      { supportedContracts: [ASSISTANT_STREAM_CONTRACT_VERSION], authMode: "token-broker" },
      server,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect([...result.requiredViews]).toEqual([]);
  });

  it("fails closed on no mutual contract version (delegates, echoes both lists)", () => {
    const result = negotiateStreamContract(
      { supportedContracts: ["9.9.9"], authMode: "token-broker" },
      server,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_mutual_contract");
  });

  it("fails closed when the server does not accept the client's auth mode — never downgrades", () => {
    const result = negotiateStreamContract(
      { supportedContracts: [ASSISTANT_STREAM_CONTRACT_VERSION], authMode: "session" },
      server, // server only accepts token-broker
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "auth_mode_unsupported") {
      expect(result.clientAuthMode).toBe("session");
      expect([...result.serverAuthModes]).toEqual(["token-broker"]);
    } else {
      throw new Error(`expected auth_mode_unsupported, got ${JSON.stringify(result)}`);
    }
  });

  it("fails closed listing the required views the server cannot emit", () => {
    const result = negotiateStreamContract(
      {
        supportedContracts: [ASSISTANT_STREAM_CONTRACT_VERSION],
        authMode: "token-broker",
        requiredViews: ["content_change_proposal", "not_a_view"],
      },
      server,
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "required_view_unsupported") {
      expect([...result.missingViews]).toEqual(["not_a_view"]);
    } else {
      throw new Error(`expected required_view_unsupported, got ${JSON.stringify(result)}`);
    }
  });

  it("fails closed when the client requires resume on a non-resumable surface", () => {
    const nonResumable = {
      ...buildAssistantStreamCapabilities({ auth: ["session"] }),
      resumable: false,
    };
    const result = negotiateStreamContract(
      {
        supportedContracts: [ASSISTANT_STREAM_CONTRACT_VERSION],
        authMode: "session",
        requiresResumable: true,
      },
      nonResumable,
    );
    expect(result).toEqual({ ok: false, reason: "not_resumable" });
  });

  it("checks version BEFORE auth (most-fundamental failure wins)", () => {
    const result = negotiateStreamContract(
      { supportedContracts: ["9.9.9"], authMode: "session" }, // both would fail
      server,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_mutual_contract");
  });
});
