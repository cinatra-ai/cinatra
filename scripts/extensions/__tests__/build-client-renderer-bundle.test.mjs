/**
 * Publish-time CLIENT-bundle builder (epic #1620 M1 Slice A — cinatra#1630):
 *  - PARITY: the inlined mirror stays byte-in-lockstep with the SDK source of
 *    truth (`@cinatra-ai/sdk-extensions/artifact-client-bundle`).
 *  - EXTERNALS GATE: rejects un-sanctioned externals + bundled/transitive React.
 *  - FUNCTIONAL: a real esbuild browser build of a JSX renderer keeps React +
 *    jsx-runtime EXTERNAL, bundles no React, and produces a stable digest +
 *    integrity + a verifiable Ed25519 signature over the exact tuple.
 */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import * as builder from "../build-client-renderer-bundle.mjs";
import * as sdk from "@cinatra-ai/sdk-extensions/artifact-client-bundle";

const tmps = [];
afterAll(async () => {
  await Promise.all(tmps.map((d) => rm(d, { recursive: true, force: true })));
});

describe("parity — inlined mirror == SDK source of truth", () => {
  it("externals allowlist, react-family set, scheme, and digest grammar match", () => {
    expect(builder.CLIENT_BUNDLE_EXTERNAL_ALLOWLIST).toEqual([...sdk.CLIENT_BUNDLE_EXTERNAL_ALLOWLIST]);
    expect(builder.REACT_FAMILY_BASE_PACKAGES).toEqual([...sdk.REACT_FAMILY_BASE_PACKAGES]);
    expect(builder.CLIENT_BUNDLE_SIGNATURE_SCHEME).toBe(sdk.CLIENT_BUNDLE_SIGNATURE_SCHEME);
    expect(builder.HOST_DESIGN_TOKEN_MODULE).toBe(sdk.HOST_DESIGN_TOKEN_MODULE);
    expect(String(builder.STORE_DIGEST_RE)).toBe(String(sdk.STORE_DIGEST_RE));
  });

  it("the host-shared design-primitives id + contract stay in lockstep", () => {
    // cinatra#3471 slice 2: the builder externalizes the primitives module, so
    // its inlined mirror must carry the SAME id and the SAME contract version.
    expect(builder.HOST_DESIGN_PRIMITIVES_MODULE).toBe(sdk.HOST_DESIGN_PRIMITIVES_MODULE);
    expect(builder.HOST_DESIGN_PRIMITIVES_CONTRACT_VERSION).toBe(
      sdk.HOST_DESIGN_PRIMITIVES_CONTRACT_VERSION,
    );
    expect(builder.HOST_DESIGN_PRIMITIVES_CONTRACT_MAJOR).toBe(
      sdk.HOST_DESIGN_PRIMITIVES_CONTRACT_MAJOR,
    );
    expect(builder.CLIENT_BUNDLE_EXTERNAL_ALLOWLIST).toContain(sdk.HOST_DESIGN_PRIMITIVES_MODULE);
    // Every input the rule branches on, on BOTH sides of the check — a builder
    // that ignored an explicit `hostServes`, or accepted a malformed one, would
    // drift silently past a parity test that only passed `builtAgainst`.
    const BUILT_AGAINST = ["1.0.0", "1.9.9", "2.0.0", "0.9.0", "^1.0.0", "1", "1.0.0-rc.1", "", undefined, 1];
    const HOST_SERVES = [undefined, "1.0.0", "1.4.2", "2.0.0", "^1.0.0", "", null];
    for (const builtAgainst of BUILT_AGAINST) {
      for (const hostServes of HOST_SERVES) {
        expect(builder.checkDesignPrimitivesContract({ builtAgainst, hostServes })).toBe(
          sdk.checkDesignPrimitivesContract({ builtAgainst, hostServes }),
        );
      }
    }
    // …and the near-miss specifier is refused by the builder's own mirror, not
    // only by the SDK gate (the exact-tuple discipline React has).
    expect(builder.isAllowedClientBundleExternal(sdk.HOST_DESIGN_PRIMITIVES_MODULE)).toBe(true);
    expect(builder.isAllowedClientBundleExternal("@cinatra-ai/design-primitives/button")).toBe(false);
    expect(
      builder.checkClientBundleExternals({
        externals: ["react", "@cinatra-ai/design-primitives/button"],
        inputBasePackages: ["@fixture/pkg"],
      }),
    ).toMatch(/un-sanctioned external/);
    expect(builder.designPrimitivesContractMajorOf("3.1.4")).toBe(
      sdk.designPrimitivesContractMajorOf("3.1.4"),
    );
  });

  it("the canonical signature payload is byte-identical to the SDK builder", () => {
    const fields = {
      packageName: "@cinatra-ai/json-artifact",
      slot: "detail",
      digest: "a".repeat(128),
      entry: "client/detail.js",
      propsApiVersion: 1,
      sdkAbiRange: "^2.4.0",
      reactPeerRange: "^19.0.0",
      reactDomPeerRange: "^19.0.0",
      tokenModuleAbi: "1.0.0",
      integrity: "sha512-Zm9v",
    };
    expect(builder.buildClientBundleSignaturePayload(fields)).toBe(
      sdk.buildClientBundleSignaturePayload(fields),
    );
  });
});

describe("externals gate", () => {
  it("passes a conforming external set; rejects un-sanctioned + bundled React", () => {
    expect(
      builder.checkClientBundleExternals({ externals: ["react", "react/jsx-runtime"], inputBasePackages: ["@x/y"] }),
    ).toBeNull();
    expect(
      builder.checkClientBundleExternals({
        externals: ["react", builder.HOST_DESIGN_PRIMITIVES_MODULE],
        inputBasePackages: ["@x/y"],
      }),
    ).toBeNull();
    expect(
      builder.checkClientBundleExternals({ externals: ["lodash"], inputBasePackages: [] }),
    ).toMatch(/un-sanctioned external/);
    expect(
      builder.checkClientBundleExternals({ externals: [], inputBasePackages: ["react"] }),
    ).toMatch(/bundled\/transitive React/);
  });
});

async function writeFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "client-bundle-fixture-"));
  tmps.push(dir);
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: "@fixture/demo-artifact",
        peerDependencies: { react: "^19.0.0", "react-dom": "^19.0.0", "@cinatra-ai/design": "^1.0.0" },
        cinatra: {
          kind: "artifact",
          artifact: {
            ui: {
              abiVersion: 1,
              sdkAbiRange: "^2.4.0",
              renderers: { detail: { entry: "./src/detail.tsx", propsApiVersion: 1 } },
            },
          },
        },
      },
      null,
      2,
    ),
  );
  await mkdir(path.join(dir, "src"), { recursive: true });
  // A JSX renderer that imports React + a design token — both must stay external.
  await writeFile(
    path.join(dir, "src", "detail.tsx"),
    [
      'import * as React from "react";',
      "export default function Detail() {",
      "  const [n, setN] = React.useState(0);",
      "  return <button onClick={() => setN(n + 1)}>{n}</button>;",
      "}",
    ].join("\n"),
  );
  return dir;
}

describe("functional — real esbuild browser build", () => {
  it("keeps React + jsx-runtime external, bundles no React, and yields a stable digest", async () => {
    const dir = await writeFixture();
    const built = await builder.buildClientRendererBundle({ packageDir: dir, slot: "detail" });

    // React family stays EXTERNAL, nothing React bundled.
    expect(built.externals).toContain("react");
    expect(built.externals.some((s) => s === "react/jsx-runtime")).toBe(true);
    expect(built.inputBasePackages).not.toContain("react");
    expect(built.inputBasePackages).not.toContain("react-dom");

    // The exact admitted tuple is assembled from the manifest + computed digest.
    expect(built.tuple.packageName).toBe("@fixture/demo-artifact");
    expect(built.tuple.slot).toBe("detail");
    // The tuple entry is the EMITTED bundle name (served + signed), not the
    // source .tsx — the digest-pinned URL targets the output.
    expect(built.tuple.entry).toBe(built.outBasename);
    expect(built.tuple.entry).not.toMatch(/\.tsx$/);
    expect(built.tuple.reactPeerRange).toBe("^19.0.0");
    expect(built.tuple.reactDomPeerRange).toBe("^19.0.0");
    expect(built.tuple.sdkAbiRange).toBe("^2.4.0");
    expect(built.tuple.propsApiVersion).toBe(1);
    expect(sdk.STORE_DIGEST_RE.test(built.tuple.digest)).toBe(true);
    expect(built.integrity.startsWith("sha512-")).toBe(true);

    // The bundle is a valid SDK tuple, and the signature verifies over it.
    expect(sdk.parseClientBundleTuple(built.tuple).ok).toBe(true);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const priv = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    const sig = builder.signClientBundle({ ...built.tuple, integrity: built.integrity }, priv);
    const payload = sdk.buildClientBundleSignaturePayload({ ...built.tuple, integrity: built.integrity });
    expect(cryptoVerify(null, Buffer.from(payload, "utf8"), publicKey, Buffer.from(sig, "base64"))).toBe(true);
    // A tampered digest breaks the signature (binding property).
    const tamperedPayload = sdk.buildClientBundleSignaturePayload({ ...built.tuple, digest: "b".repeat(128), integrity: built.integrity });
    expect(cryptoVerify(null, Buffer.from(tamperedPayload, "utf8"), publicKey, Buffer.from(sig, "base64"))).toBe(false);
  });
});
