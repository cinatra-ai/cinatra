// The SUPPLIED-package content digest and the explicit provenance discriminant
// (cinatra#3204 D2). These are the properties the rest of the deliverable rests
// on: one algorithm, one canonical encoding, and a digest that is not a Git id.

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import {
  CONTENT_DIGEST_ALGORITHM,
  CONTENT_DIGEST_ENCODING_ID,
  CONTENT_DIGEST_RE,
  computeContentDigest,
  describeSuppliedProvenance,
  encodeCanonicalTree,
  isContentDigest,
  isPackageRefProvenance,
  isSuppliedPackageProvenance,
} from "../index";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("the content digest algorithm", () => {
  it("is hex sha256 over the canonical tree encoding, and says so", async () => {
    expect(CONTENT_DIGEST_ALGORITHM).toBe("sha256");
    const entries = [{ path: "package.json", bytes: bytes('{"name":"x"}') }];
    const digest = await computeContentDigest(entries);
    expect(CONTENT_DIGEST_RE.test(digest)).toBe(true);
    // Recomputed independently from the documented encoding — the digest is the
    // encoding's sha256 and nothing else.
    const expected = createHash("sha256").update(encodeCanonicalTree(entries)).digest("hex");
    expect(digest).toBe(expected);
  });

  it("carries the encoding id as a domain-separation prefix", () => {
    const encoded = encodeCanonicalTree([{ path: "a", bytes: bytes("b") }]);
    const head = new TextDecoder().decode(encoded.subarray(0, CONTENT_DIGEST_ENCODING_ID.length));
    expect(head).toBe(CONTENT_DIGEST_ENCODING_ID);
  });

  it("is order-independent: the same tree in any listing order gives one digest", async () => {
    const a = await computeContentDigest([
      { path: "b.txt", bytes: bytes("two") },
      { path: "a.txt", bytes: bytes("one") },
    ]);
    const b = await computeContentDigest([
      { path: "a.txt", bytes: bytes("one") },
      { path: "b.txt", bytes: bytes("two") },
    ]);
    expect(a).toBe(b);
  });

  it("distinguishes trees that only a separator-based encoding would confuse", async () => {
    // Length-prefixed framing: a path that embeds what a naive encoding would
    // treat as a separator cannot impersonate a different tree.
    const a = await computeContentDigest([{ path: "a\nb", bytes: bytes("") }]);
    const b = await computeContentDigest([
      { path: "a", bytes: bytes("") },
      { path: "b", bytes: bytes("") },
    ]);
    expect(a).not.toBe(b);
  });

  it("changes when any byte of any file changes", async () => {
    const a = await computeContentDigest([{ path: "f", bytes: bytes("hello") }]);
    const b = await computeContentDigest([{ path: "f", bytes: bytes("hellp") }]);
    expect(a).not.toBe(b);
  });

  it("changes when a file is renamed, even with identical bytes", async () => {
    const a = await computeContentDigest([{ path: "one", bytes: bytes("same") }]);
    const b = await computeContentDigest([{ path: "two", bytes: bytes("same") }]);
    expect(a).not.toBe(b);
  });

  it("refuses a tree that names the same path twice", () => {
    expect(() =>
      encodeCanonicalTree([
        { path: "dup", bytes: bytes("a") },
        { path: "dup", bytes: bytes("b") },
      ]),
    ).toThrow(/more than once/);
  });

  it("is NOT a Git object id: the same tree under two commits digests the same", async () => {
    // A Git commit id folds in parents, author, committer, timestamps and the
    // message. This digest folds in the delivered files and nothing else, so two
    // different commits over identical content are indistinguishable to it —
    // which is exactly the property the install road needs.
    const tree = [{ path: "SKILL.md", bytes: bytes("# skill") }];
    const fromCommitA = await computeContentDigest(tree);
    const fromCommitB = await computeContentDigest(tree.map((e) => ({ ...e })));
    expect(fromCommitA).toBe(fromCommitB);

    // And it is not the Git blob/tree hash either — a Git object id would be the
    // sha1/sha256 over Git's own `<type> <len>\0<payload>` framing.
    const gitBlobLike = createHash("sha256")
      .update(Buffer.concat([Buffer.from("blob 7\0"), Buffer.from("# skill")]))
      .digest("hex");
    expect(fromCommitA).not.toBe(gitBlobLike);
  });
});

describe("isContentDigest", () => {
  it("accepts hex sha256 and rejects everything else", () => {
    expect(isContentDigest("a".repeat(64))).toBe(true);
    expect(isContentDigest("A".repeat(64))).toBe(false); // upper case is not the grammar
    expect(isContentDigest("a".repeat(63))).toBe(false);
    expect(isContentDigest("a".repeat(128))).toBe(false); // a store digest is not a content digest
    expect(isContentDigest("")).toBe(false);
    expect(isContentDigest(undefined)).toBe(false);
  });
});

describe("explicit supplied provenance", () => {
  const digest = "b".repeat(64);

  it("accepts a complete local provenance", () => {
    expect(isSuppliedPackageProvenance({ type: "local", path: "snap.tgz", contentDigest: digest })).toBe(true);
  });

  it("accepts a complete github provenance", () => {
    expect(
      isSuppliedPackageProvenance({
        type: "github",
        repo: "owner/repo",
        ref: "main",
        resolvedSha: "c".repeat(40),
        contentDigest: digest,
      }),
    ).toBe(true);
  });

  it("refuses supplied provenance with no content digest — provenance you cannot check is not provenance", () => {
    expect(isSuppliedPackageProvenance({ type: "local", path: "snap.tgz" })).toBe(false);
    expect(
      isSuppliedPackageProvenance({ type: "github", repo: "o/r", ref: "main", resolvedSha: "abc" }),
    ).toBe(false);
  });

  it("refuses a malformed digest rather than storing it", () => {
    expect(isSuppliedPackageProvenance({ type: "local", path: "s", contentDigest: "pending" })).toBe(false);
  });

  it("treats verdaccio as ref provenance but never as SUPPLIED provenance", () => {
    expect(isPackageRefProvenance({ type: "verdaccio" })).toBe(true);
    expect(isSuppliedPackageProvenance({ type: "verdaccio" })).toBe(false);
  });

  it("never describes a supplied package as coming from a registry", () => {
    const local = describeSuppliedProvenance({ type: "local", path: "s", contentDigest: digest });
    expect(local).toContain("supplied file");
    expect(local).not.toMatch(/registry/i);
    const gh = describeSuppliedProvenance({
      type: "github",
      repo: "owner/repo",
      ref: "v1",
      resolvedSha: "d".repeat(40),
      contentDigest: digest,
    });
    expect(gh).toContain("owner/repo");
    expect(gh).not.toMatch(/registry/i);
  });
});
