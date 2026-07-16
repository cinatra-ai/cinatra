/**
 * Shared client-bundle contract (epic #1620 M1 Slice A — cinatra#1630): the
 * externals allowlist gate, the exact-tuple identity + `reactPeerSet`
 * fingerprint (over both React ranges), and the canonical browser-bundle
 * signature payload. Pure; no crypto.
 */
import { describe, expect, it } from "vitest";

import {
  CLIENT_BUNDLE_EXTERNAL_ALLOWLIST,
  CLIENT_BUNDLE_SIGNATURE_SCHEME,
  HOST_DESIGN_TOKEN_MODULE,
  basePackageOf,
  buildClientBundleSignaturePayload,
  checkClientBundleExternals,
  clientBundleTupleEquals,
  isAllowedClientBundleExternal,
  parseClientBundleTuple,
  reactPeerSetFingerprint,
  REACT_PEER_SET_SEPARATOR,
  type AdmittedClientBundleTuple,
} from "../artifact-client-bundle";

const DIGEST = "a".repeat(128);

function tuple(over: Partial<AdmittedClientBundleTuple> = {}): AdmittedClientBundleTuple {
  return {
    packageName: "@cinatra-ai/json-artifact",
    slot: "detail",
    digest: DIGEST,
    entry: "client/detail.js",
    propsApiVersion: 1,
    sdkAbiRange: "^2.4.0",
    reactPeerRange: "^19.0.0",
    reactDomPeerRange: "^19.0.0",
    tokenModuleAbi: "1.0.0",
    ...over,
  };
}

describe("externals allowlist", () => {
  it("sanctions exactly React/ReactDOM entry points + the design-token module", () => {
    expect(CLIENT_BUNDLE_EXTERNAL_ALLOWLIST).toContain("react");
    expect(CLIENT_BUNDLE_EXTERNAL_ALLOWLIST).toContain("react/jsx-runtime");
    expect(CLIENT_BUNDLE_EXTERNAL_ALLOWLIST).toContain("react-dom");
    expect(CLIENT_BUNDLE_EXTERNAL_ALLOWLIST).toContain("react-dom/client");
    expect(CLIENT_BUNDLE_EXTERNAL_ALLOWLIST).toContain(HOST_DESIGN_TOKEN_MODULE);
    expect(isAllowedClientBundleExternal("react")).toBe(true);
    expect(isAllowedClientBundleExternal("lodash")).toBe(false);
  });

  it("passes a conforming bundle (only host peers external, no bundled React)", () => {
    expect(
      checkClientBundleExternals({
        externals: ["react", "react/jsx-runtime", "react-dom", HOST_DESIGN_TOKEN_MODULE],
        inputBasePackages: ["@cinatra-ai/json-artifact"],
      }),
    ).toBeNull();
  });

  it("REJECTS an un-sanctioned external", () => {
    const reason = checkClientBundleExternals({
      externals: ["react", "lodash"],
      inputBasePackages: [],
    });
    expect(reason).toMatch(/un-sanctioned external/);
    expect(reason).toMatch(/lodash/);
  });

  it("REJECTS a bundled/transitive React copy (react in the input set)", () => {
    const reason = checkClientBundleExternals({
      externals: [],
      inputBasePackages: ["@cinatra-ai/json-artifact", "react"],
    });
    expect(reason).toMatch(/bundled\/transitive React/);
  });

  it("REJECTS a bundled react-dom copy", () => {
    const reason = checkClientBundleExternals({
      externals: ["react"],
      inputBasePackages: ["react-dom"],
    });
    expect(reason).toMatch(/bundled\/transitive React/);
  });
});

describe("basePackageOf", () => {
  it("collapses scoped + unscoped subpaths; null for relative", () => {
    expect(basePackageOf("react/jsx-runtime")).toBe("react");
    expect(basePackageOf("@scope/name/sub")).toBe("@scope/name");
    expect(basePackageOf("./local")).toBeNull();
  });
});

describe("exact-tuple identity + reactPeerSet fingerprint", () => {
  it("parses a well-formed tuple and rejects a bad digest / extra key", () => {
    expect(parseClientBundleTuple(tuple()).ok).toBe(true);
    expect(parseClientBundleTuple(tuple({ digest: "short" })).ok).toBe(false);
    expect(parseClientBundleTuple({ ...tuple(), extra: 1 }).ok).toBe(false);
  });

  it("fingerprint folds BOTH React ranges injectively", () => {
    expect(reactPeerSetFingerprint("^19.0.0", "^19.0.0")).toBe(
      `^19.0.0${REACT_PEER_SET_SEPARATOR}^19.0.0`,
    );
    // Swapping the two ranges yields a DIFFERENT fingerprint (order-sensitive) —
    // the NUL separator makes the fold injective even for space/pipe ranges.
    expect(reactPeerSetFingerprint("^19.0.0", "^18.0.0")).not.toBe(
      reactPeerSetFingerprint("^18.0.0", "^19.0.0"),
    );
    expect(reactPeerSetFingerprint(">=19 <20", "^19.0.0")).not.toBe(
      reactPeerSetFingerprint(">=19", "<20 ^19.0.0"),
    );
  });

  it("tuple equality is byte-wise over every field incl. both peer ranges", () => {
    expect(clientBundleTupleEquals(tuple(), tuple())).toBe(true);
    expect(clientBundleTupleEquals(tuple(), tuple({ digest: "b".repeat(128) }))).toBe(false);
    expect(clientBundleTupleEquals(tuple(), tuple({ reactDomPeerRange: "^18.0.0" }))).toBe(false);
  });
});

describe("canonical signature payload", () => {
  it("is deterministic, scheme-prefixed, and binds the exact tuple + integrity", () => {
    const integrity = "sha512-Zm9v";
    const payload = buildClientBundleSignaturePayload({ ...tuple(), integrity });
    expect(payload.startsWith(`${CLIENT_BUNDLE_SIGNATURE_SCHEME}\n`)).toBe(true);
    expect(payload).toBe(buildClientBundleSignaturePayload({ ...tuple(), integrity }));
    expect(payload.endsWith(integrity)).toBe(true);
    // A single field change changes the payload bytes (binding property).
    const other = buildClientBundleSignaturePayload({ ...tuple({ digest: "b".repeat(128) }), integrity });
    expect(other).not.toBe(payload);
  });
});
