/**
 * D2 — non-registry provenance carries a CONTENT DIGEST (cinatra#3204).
 *
 * The upload roads (file archive, repository) deliver bytes that no registry
 * ever attested. Before this module the two non-registry source shapes could
 * only record a REVISION identifier (`resolvedSha` / `resolvedCommitOrTreeHash`)
 * — a pointer, not a statement about the delivered tree — and source
 * discrimination was a package-NAME heuristic.
 *
 * This suite locks the algorithm, its canonical encoding, its distinctness from
 * a Git object id, and the explicit provenance predicates that replace the
 * heuristic.
 *
 * Run: cd packages/extensions && pnpm exec vitest run src/__tests__/extension-package-digest.test.ts
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { isExtensionSource, validateExtensionSource } from "../canonical-types";
import {
  EXTENSION_TREE_DIGEST_RE,
  assertExtensionTreeDigest,
  canonicalExtensionTreeEncoding,
  computeExtensionTreeDigest,
  describeSourceProvenance,
  isExtensionTreeDigest,
  isRegistryAttestedSource,
  sourceContentDigest,
} from "../extension-package-digest";

const te = new TextEncoder();
const bytes = (s: string) => te.encode(s);

describe("canonical tree encoding", () => {
  it("is one line per entry: sha256 hex, byte length, path", async () => {
    const encoding = canonicalExtensionTreeEncoding([
      ["package.json", bytes("{}")],
    ]);
    const hex = createHash("sha256").update(Buffer.from(bytes("{}"))).digest("hex");
    expect(encoding).toBe(`${hex} 2 package.json\n`);
  });

  it("sorts entries by the UTF-8 byte order of their path, so entry order cannot change the digest", async () => {
    const a = await computeExtensionTreeDigest([
      ["b.txt", bytes("B")],
      ["a.txt", bytes("A")],
    ]);
    const b = await computeExtensionTreeDigest([
      ["a.txt", bytes("A")],
      ["b.txt", bytes("B")],
    ]);
    expect(a).toBe(b);
  });

  it("binds the PATH, not only the bytes — a renamed file changes the digest", async () => {
    const a = await computeExtensionTreeDigest([["a.txt", bytes("same")]]);
    const b = await computeExtensionTreeDigest([["b.txt", bytes("same")]]);
    expect(a).not.toBe(b);
  });

  it("binds the CONTENT — one flipped byte changes the digest", async () => {
    const a = await computeExtensionTreeDigest([["a.txt", bytes("same")]]);
    const b = await computeExtensionTreeDigest([["a.txt", bytes("samf")]]);
    expect(a).not.toBe(b);
  });

  it("binds the byte LENGTH, so a shorter file can never be padded into another's line", async () => {
    const encoding = canonicalExtensionTreeEncoding([["a.txt", bytes("ab")]]);
    expect(encoding).toMatch(/ 2 a\.txt\n$/);
  });

  it("refuses a duplicate path rather than digesting an ambiguous tree", () => {
    expect(() =>
      canonicalExtensionTreeEncoding([
        ["a.txt", bytes("one")],
        ["a.txt", bytes("two")],
      ]),
    ).toThrow(/duplicate path "a\.txt"/);
  });

  it("refuses an empty tree — there is nothing to attest", async () => {
    await expect(computeExtensionTreeDigest([])).rejects.toThrow(/no files/);
  });
});

describe("digest shape", () => {
  it("is prefixed sha256- and 64 lowercase hex", async () => {
    const digest = await computeExtensionTreeDigest([["a.txt", bytes("A")]]);
    expect(digest).toMatch(EXTENSION_TREE_DIGEST_RE);
    expect(digest.startsWith("sha256-")).toBe(true);
    expect(digest.slice("sha256-".length)).toHaveLength(64);
  });

  it("is NOT a Git object id — the same single-file tree digests differently from git hash-object", async () => {
    const content = bytes("hello\n");
    const digest = await computeExtensionTreeDigest([["hello.txt", content]]);
    // git blob encoding: "blob <len>\0<bytes>" under sha1 AND under sha256.
    const gitBlobSha1 = createHash("sha1")
      .update(Buffer.concat([Buffer.from("blob 6\0"), Buffer.from(content)]))
      .digest("hex");
    const gitBlobSha256 = createHash("sha256")
      .update(Buffer.concat([Buffer.from("blob 6\0"), Buffer.from(content)]))
      .digest("hex");
    expect(digest).not.toBe(`sha256-${gitBlobSha1}`);
    expect(digest).not.toBe(`sha256-${gitBlobSha256}`);
  });

  it("isExtensionTreeDigest rejects a bare hex, an uppercase hex and a sha512 SRI", () => {
    expect(isExtensionTreeDigest("a".repeat(64))).toBe(false);
    expect(isExtensionTreeDigest(`sha256-${"A".repeat(64)}`)).toBe(false);
    expect(isExtensionTreeDigest("sha512-abc")).toBe(false);
  });

  it("assertExtensionTreeDigest names the field it refused", () => {
    expect(() => assertExtensionTreeDigest("nope", "source.contentDigest")).toThrow(
      /source\.contentDigest/,
    );
  });
});

describe("explicit provenance (replaces the package-name heuristic)", () => {
  const verdaccio = {
    type: "verdaccio" as const,
    registryUrl: "https://registry.example",
    packageName: "@vendor/thing",
    version: "1.0.0",
    integrity: "sha512-abc",
  };
  const local = {
    type: "local" as const,
    path: "upload:archive",
    resolvedCommitOrTreeHash: "upload@1.0.0",
    contentDigest: `sha256-${"b".repeat(64)}`,
  };
  const github = {
    type: "github" as const,
    repo: "vendor/thing",
    ref: "main",
    resolvedSha: "f".repeat(40),
    contentDigest: `sha256-${"c".repeat(64)}`,
  };

  it("only a verdaccio source is registry-attested", () => {
    expect(isRegistryAttestedSource(verdaccio)).toBe(true);
    expect(isRegistryAttestedSource(local)).toBe(false);
    expect(isRegistryAttestedSource(github)).toBe(false);
    expect(isRegistryAttestedSource({ type: "bundled", packageName: "x", version: "1" })).toBe(
      false,
    );
    expect(isRegistryAttestedSource(null)).toBe(false);
  });

  it("a SCOPED local package name no longer classifies as registry-backed", () => {
    // The retired heuristic (isVerdaccioBackedRef) said "scoped name OR a
    // version present ⇒ verdaccio". Both of these carry a scoped name and a
    // version and are still NOT registry-attested.
    expect(isRegistryAttestedSource(local)).toBe(false);
    expect(isRegistryAttestedSource(github)).toBe(false);
  });

  it("reads the content digest off the non-registry sources only", () => {
    expect(sourceContentDigest(local)).toBe(local.contentDigest);
    expect(sourceContentDigest(github)).toBe(github.contentDigest);
    expect(sourceContentDigest(verdaccio)).toBeNull();
  });

  it("never describes a supplied package as registry-attested", () => {
    expect(describeSourceProvenance(verdaccio)).toBe("registry-attested");
    expect(describeSourceProvenance(local)).toBe("supplied file");
    expect(describeSourceProvenance(github)).toBe("supplied repository");
    expect(describeSourceProvenance({ type: "bundled", packageName: "x", version: "1" })).toBe(
      "image-bundled",
    );
  });
});

describe("the recorded digest is validated fail-closed", () => {
  const wellFormed = `sha256-${"a".repeat(64)}`;

  it("accepts a local/github source with NO digest — every row written before #3204", () => {
    expect(
      isExtensionSource({ type: "local", path: "upload:x", resolvedCommitOrTreeHash: "upload@1" }),
    ).toBe(true);
    expect(
      isExtensionSource({ type: "github", repo: "v/t", ref: "main", resolvedSha: "f".repeat(40) }),
    ).toBe(true);
  });

  it("accepts a well-formed digest", () => {
    expect(
      isExtensionSource({
        type: "local",
        path: "upload:x",
        resolvedCommitOrTreeHash: "upload@1",
        contentDigest: wellFormed,
      }),
    ).toBe(true);
  });

  it("REFUSES a malformed digest rather than reading it as an attestation", () => {
    for (const bad of ["", "sha256-nope", "a".repeat(64), `sha256-${"A".repeat(64)}`]) {
      expect(
        isExtensionSource({
          type: "local",
          path: "upload:x",
          resolvedCommitOrTreeHash: "upload@1",
          contentDigest: bad,
        }),
      ).toBe(false);
      expect(
        isExtensionSource({
          type: "github",
          repo: "v/t",
          ref: "main",
          resolvedSha: "f".repeat(40),
          contentDigest: bad,
        }),
      ).toBe(false);
    }
  });

  it("names the offending field in the structured error list", () => {
    expect(
      validateExtensionSource({
        type: "local",
        path: "upload:x",
        resolvedCommitOrTreeHash: "upload@1",
        contentDigest: "sha256-nope",
      }),
    ).toContain("local.contentDigest");
    expect(
      validateExtensionSource({
        type: "github",
        repo: "v/t",
        ref: "main",
        resolvedSha: "f".repeat(40),
        contentDigest: "sha256-nope",
      }),
    ).toContain("github.contentDigest");
  });
});
