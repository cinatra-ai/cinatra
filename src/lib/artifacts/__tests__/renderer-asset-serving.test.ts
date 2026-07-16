/**
 * Digest-pinned immutable serving core (epic #1620 M1 Slice A — cinatra#1630,
 * plan §5.1.2 / AC-8): traversal-safe path parsing, active-digest-only
 * admission (serves only activated bundle paths), immutable JS headers, and
 * no path-derived filesystem access.
 */
import { describe, expect, it } from "vitest";

import { buildDigestPinnedUrl } from "../runtime-renderer-descriptor";
import type { AdmittedClientBundleTuple } from "@cinatra-ai/sdk-extensions/artifact-client-bundle";
import {
  decideRendererAssetServe,
  parseRendererAssetPath,
  rendererAssetHeaders,
} from "../renderer-asset-serving";

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

/** Turn a built digest-pinned URL back into the catch-all route segments. */
function segmentsOf(url: string): string[] {
  return url.replace("/api/artifact-renderer-assets/", "").split("/");
}

describe("parseRendererAssetPath — round-trips the URL builder, fail-closed", () => {
  it("parses a URL produced by buildDigestPinnedUrl (scoped package survives as one segment)", () => {
    const res = parseRendererAssetPath(segmentsOf(buildDigestPinnedUrl(tuple())));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.parsed).toEqual({
        digest: DIGEST,
        slot: "detail",
        packageName: "@cinatra-ai/json-artifact",
        entry: "client/detail.js",
      });
    }
  });

  it("rejects too-few segments, a bad digest, and an unknown slot", () => {
    expect(parseRendererAssetPath([DIGEST, "detail", "@x/y"]).ok).toBe(false);
    expect(parseRendererAssetPath(["short", "detail", "@x/y", "a.js"]).ok).toBe(false);
    expect(parseRendererAssetPath([DIGEST, "listRow", "@x/y", "a.js"]).ok).toBe(false);
  });

  it("REFUSES a path-traversal entry segment (no path-derived FS access)", () => {
    expect(parseRendererAssetPath([DIGEST, "detail", "@x/y", "..", "etc", "passwd"]).ok).toBe(false);
    expect(parseRendererAssetPath([DIGEST, "detail", "@x/y", ".", "x.js"]).ok).toBe(false);
    // an encoded traversal decodes then fails the safe-segment check
    expect(parseRendererAssetPath([DIGEST, "detail", "@x/y", "%2e%2e", "x"]).ok).toBe(false);
  });

  it("REFUSES an unsafe package segment", () => {
    expect(parseRendererAssetPath([DIGEST, "detail", "..", "x.js"]).ok).toBe(false);
  });
});

describe("headers — immutable + correct JS MIME", () => {
  it("is content-addressed-immutable JS with nosniff", () => {
    const h = rendererAssetHeaders();
    expect(h["Content-Type"]).toMatch(/javascript/);
    expect(h["Cache-Control"]).toMatch(/immutable/);
    expect(h["Cache-Control"]).toMatch(/max-age=31536000/);
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
  });
});

describe("decideRendererAssetServe — serves ONLY the active admitted digest", () => {
  const parse = parseRendererAssetPath(segmentsOf(buildDigestPinnedUrl(tuple())));

  it("serves when the requested digest IS the active admitted one", () => {
    const d = decideRendererAssetServe({ parse, activeDigest: DIGEST });
    expect(d.serve).toBe(true);
    if (d.serve) {
      expect(d.storeRelPath).toBe(`${DIGEST}/client/detail.js`);
      expect(d.headers["Cache-Control"]).toMatch(/immutable/);
    }
  });

  it("404s a superseded/never-admitted digest and a null (archived) active digest", () => {
    expect(decideRendererAssetServe({ parse, activeDigest: "b".repeat(128) })).toMatchObject({ serve: false, status: 404 });
    expect(decideRendererAssetServe({ parse, activeDigest: null })).toMatchObject({ serve: false, status: 404 });
  });

  it("400s a malformed request path", () => {
    expect(
      decideRendererAssetServe({ parse: parseRendererAssetPath(["short"]), activeDigest: DIGEST }),
    ).toMatchObject({ serve: false, status: 400 });
  });
});
