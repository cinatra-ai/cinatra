/**
 * D1 — a SOURCE-AGNOSTIC entry into the install pipeline (cinatra#3204).
 *
 * The pipeline's registry coupling was never in its gates. It was in two
 * injected seams: `resolveIntegrity` (which read the sha512 SRI off a registry
 * packument) and `materialize` (which fetched that registry's tarball). Every
 * other step — the signed materialization plan, the signature verdict, the
 * host-compat gate, the install-op journal, host-port grants, provenance, the
 * finalize cross-check, the rollback — is source-agnostic already.
 *
 * So a supplied package does not need a second installer, and this suite says
 * so: it seals the delivered tree into an immutable snapshot with a verified
 * digest, and swaps ONLY those two seams. Everything after them is the pipeline
 * a store install runs, unchanged.
 *
 * Run: pnpm exec vitest run src/lib/__tests__/extension-install-supplied-source.test.ts
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

import {
  SUPPLIED_SOURCE_REGISTRY_IDENTITY,
  makeSuppliedSourceInstallPipelineDeps,
  packSuppliedPackageTarball,
  sealSuppliedPackage,
  suppliedPackageProvenance,
} from "@/lib/extension-install-supplied-source";

const te = new TextEncoder();

function tree(extra: Record<string, string> = {}): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  files.set(
    "package.json",
    te.encode(
      JSON.stringify({
        name: "@cinatra-ai/fixture-skill",
        version: "1.2.3",
        cinatra: { kind: "skill" },
      }),
    ),
  );
  files.set("skills/fixture/SKILL.md", te.encode("# fixture\n"));
  for (const [name, content] of Object.entries(extra)) files.set(name, te.encode(content));
  return files;
}

async function digestOf(files: Map<string, Uint8Array>): Promise<string> {
  const { computeExtensionTreeDigest } = await import(
    "@cinatra-ai/extensions/extension-package-digest"
  );
  return computeExtensionTreeDigest(files);
}

async function snapshot(over: Partial<Parameters<typeof sealSuppliedPackage>[0]> = {}) {
  const files = over.files ?? tree();
  return sealSuppliedPackage({
    packageName: "@cinatra-ai/fixture-skill",
    version: "1.2.3",
    extensionKind: "skill",
    contentDigest: over.contentDigest ?? (await digestOf(files)),
    origin: { kind: "file", fileName: "fixture-skill.zip" },
    ...over,
    files,
  });
}

// ---------------------------------------------------------------------------
// The seal: a stated digest is VERIFIED, never trusted
// ---------------------------------------------------------------------------

describe("sealing a supplied package", () => {
  it("verifies the stated digest against the delivered tree", async () => {
    const sealed = await snapshot();
    expect(sealed.contentDigest).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(sealed.integrity).toMatch(/^sha512-/);
  });

  it("REFUSES a tree whose bytes do not match the digest stated at preview", async () => {
    const previewDigest = await digestOf(tree());
    await expect(
      snapshot({ files: tree({ "extra.txt": "swapped in after the preview" }), contentDigest: previewDigest }),
    ).rejects.toThrow(/does not match the content digest stated for it/);
  });

  it("names BOTH digests in the refusal, so the swap is visible", async () => {
    const previewDigest = await digestOf(tree());
    await expect(
      snapshot({ files: tree({ "extra.txt": "x" }), contentDigest: previewDigest }),
    ).rejects.toThrow(new RegExp(previewDigest));
  });

  it("refuses a malformed stated digest rather than recomputing over it", async () => {
    await expect(snapshot({ contentDigest: "sha256-nope" })).rejects.toThrow(
      /stated content digest/,
    );
  });

  it("refuses a tree whose package.json disagrees with the stated identity", async () => {
    await expect(
      snapshot({ packageName: "@cinatra-ai/other-skill" }),
    ).rejects.toThrow(/identifies as "@cinatra-ai\/fixture-skill"/);
    await expect(snapshot({ version: "9.9.9" })).rejects.toThrow(/identifies as .*1\.2\.3/);
  });
});

// ---------------------------------------------------------------------------
// The tarball: deterministic, npm-shaped, and its OWN root of trust
// ---------------------------------------------------------------------------

describe("the sealed tarball", () => {
  it("is byte-deterministic — the same tree always packs to the same bytes", async () => {
    const a = packSuppliedPackageTarball(tree());
    const b = packSuppliedPackageTarball(tree());
    expect(Buffer.compare(a, b)).toBe(0);
  });

  it("carries the npm `package/` prefix the materializer strips", async () => {
    const tar = gunzipSync(packSuppliedPackageTarball(tree()));
    // ustar header names live in the first 100 bytes of each 512-byte block.
    const names: string[] = [];
    for (let off = 0; off + 512 <= tar.length; off += 512) {
      const raw = tar.subarray(off, off + 100).toString("utf8").replace(/\0.*$/, "");
      if (raw === "") break;
      names.push(raw);
      const size = parseInt(tar.subarray(off + 124, off + 135).toString("utf8").trim(), 8) || 0;
      off += Math.ceil(size / 512) * 512;
    }
    expect(names).toContain("package/package.json");
    expect(names).toContain("package/skills/fixture/SKILL.md");
  });

  it("is extracted by the SAME tar reader the store materializer uses", async () => {
    // The strongest available proof that the hand-rolled writer produces a real
    // archive: unpack it with node-tar exactly as `materializePackageToStore`
    // does (strip: 1), and read the files back off disk.
    const tar = await import("tar");
    const { mkdtemp, readFile, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = (await import("node:path")).default;
    const root = await mkdtemp(path.join(tmpdir(), "cinatra-3204-tgz-"));
    try {
      const tgz = path.join(root, "pkg.tgz");
      const dest = path.join(root, "out");
      await writeFile(tgz, packSuppliedPackageTarball(tree()));
      await (await import("node:fs/promises")).mkdir(dest, { recursive: true });
      await tar.x({ file: tgz, cwd: dest, strip: 1 });
      expect(JSON.parse(await readFile(path.join(dest, "package.json"), "utf8")).name).toBe(
        "@cinatra-ai/fixture-skill",
      );
      expect(await readFile(path.join(dest, "skills/fixture/SKILL.md"), "utf8")).toBe(
        "# fixture\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("computes the sha512 SRI over exactly those bytes", async () => {
    const sealed = await snapshot();
    const expected = `sha512-${createHash("sha512").update(sealed.tarball).digest("base64")}`;
    expect(sealed.integrity).toBe(expected);
  });

  it("changes the SRI when one byte of the delivered tree changes", async () => {
    const a = await snapshot();
    const changed = tree({ "skills/fixture/SKILL.md": "# fixture!\n" });
    const b = await snapshot({ files: changed, contentDigest: await digestOf(changed) });
    expect(a.integrity).not.toBe(b.integrity);
  });
});

// ---------------------------------------------------------------------------
// Provenance: honest, digest-carrying, never registry-attested
// ---------------------------------------------------------------------------

describe("the provenance a supplied install records", () => {
  it("records `local` for a file upload, carrying the D2 digest", async () => {
    const sealed = await snapshot();
    const source = suppliedPackageProvenance(sealed);
    expect(source.type).toBe("local");
    expect(source).toMatchObject({ contentDigest: sealed.contentDigest });
  });

  it("records `github` for a repository, carrying the pinned SHA and the D2 digest", async () => {
    const sealed = await snapshot({
      origin: { kind: "github", repo: "vendor/thing", ref: "main", resolvedSha: "a".repeat(40) },
    });
    const source = suppliedPackageProvenance(sealed);
    expect(source).toMatchObject({
      type: "github",
      repo: "vendor/thing",
      ref: "main",
      resolvedSha: "a".repeat(40),
      contentDigest: sealed.contentDigest,
    });
  });

  it("passes the canonical source validators", async () => {
    const { isExtensionSource, validateExtensionSource } = await import(
      "@cinatra-ai/extensions/canonical-types"
    );
    for (const origin of [
      { kind: "file" as const, fileName: "x.zip" },
      { kind: "github" as const, repo: "v/t", ref: "main", resolvedSha: "b".repeat(40) },
    ]) {
      const source = suppliedPackageProvenance(await snapshot({ origin }));
      expect(validateExtensionSource(source)).toEqual([]);
      expect(isExtensionSource(source)).toBe(true);
    }
  });

  it("is never registry-attested", async () => {
    const { describeSourceProvenance, isRegistryAttestedSource } = await import(
      "@cinatra-ai/extensions/extension-package-digest"
    );
    const source = suppliedPackageProvenance(await snapshot());
    expect(isRegistryAttestedSource(source)).toBe(false);
    expect(describeSourceProvenance(source)).toBe("supplied file");
  });
});

// ---------------------------------------------------------------------------
// The seam: only resolveIntegrity + materialize are replaced
// ---------------------------------------------------------------------------

describe("the pipeline deps a supplied install runs on", () => {
  const inertBase = () =>
    ({
      resolveIntegrity: async () => {
        throw new Error("the registry resolver must never run for a supplied package");
      },
      materialize: async () => {
        throw new Error("the registry materializer must never run for a supplied package");
      },
      readRequestedPorts: async () => ["4000"],
      readDeclaredCompat: async () => ({ sdkAbiRange: null }),
      recordProvenance: async () => {},
      recordRequestedGrant: async () => {},
      approveGrant: async () => {},
      // a marker dep that must survive untouched
      emitOperationalEvent: () => {},
    }) as unknown as Parameters<typeof makeSuppliedSourceInstallPipelineDeps>[0];

  it("replaces exactly two seams and leaves every other dep identical", async () => {
    const base = inertBase();
    const sealed = await snapshot();
    const deps = makeSuppliedSourceInstallPipelineDeps(base, sealed);
    const replaced = Object.keys(base).filter(
      (k) => (deps as Record<string, unknown>)[k] !== (base as Record<string, unknown>)[k],
    );
    expect(replaced.sort()).toEqual(["materialize", "resolveIntegrity"]);
  });

  it("resolves integrity from the sealed bytes, not from a registry", async () => {
    const sealed = await snapshot();
    const deps = makeSuppliedSourceInstallPipelineDeps(inertBase(), sealed);
    const resolved = await deps.resolveIntegrity("@cinatra-ai/fixture-skill", "1.2.3");
    expect(resolved.integrity).toBe(sealed.integrity);
    expect(resolved.resolvedVersion).toBe("1.2.3");
    // NO materialization plan and NO signature: a supplied package is unsigned,
    // and claiming otherwise would let it through the plan-bearing gate.
    expect(resolved.materializationPlan).toBeUndefined();
    expect(resolved.signature ?? null).toBeNull();
  });

  it("refuses to resolve a package other than the one that was sealed", async () => {
    const deps = makeSuppliedSourceInstallPipelineDeps(inertBase(), await snapshot());
    await expect(deps.resolveIntegrity("@cinatra-ai/other", "1.2.3")).rejects.toThrow(
      /sealed for "@cinatra-ai\/fixture-skill@1\.2\.3"/,
    );
    await expect(
      deps.resolveIntegrity("@cinatra-ai/fixture-skill", "9.9.9"),
    ).rejects.toThrow(/sealed for "@cinatra-ai\/fixture-skill@1\.2\.3"/);
  });

  it("reports a registry identity that is NOT a trusted activation host, so grants stay pending", async () => {
    const { trustedActivationHosts } = await import("@/lib/extension-trust-config");
    const deps = makeSuppliedSourceInstallPipelineDeps(inertBase(), await snapshot());
    const { registryUrl } = await deps.resolveIntegrity("@cinatra-ai/fixture-skill", "1.2.3");
    expect(registryUrl).toBe(SUPPLIED_SOURCE_REGISTRY_IDENTITY);
    const hosts = trustedActivationHosts();
    expect(hosts.some((h) => registryUrl.includes(h))).toBe(false);
  });

  it("materializes the SEALED bytes through the store's own materializer", async () => {
    const sealed = await snapshot();
    const seen: { bytes?: Buffer; integrity?: string; expectedKind?: string } = {};
    const deps = makeSuppliedSourceInstallPipelineDeps(inertBase(), sealed, {
      materializePackageToStore: async (input, matDeps) => {
        const fetched = await matDeps!.fetchTarball!({
          packageName: input.packageName,
          packageVersion: input.version,
          expectedIntegrity: input.expectedIntegrity,
        });
        seen.bytes = fetched.bytes;
        seen.integrity = input.expectedIntegrity;
        seen.expectedKind = input.expectedKind;
        return {
          storeDir: "/store/skill/x/deadbeef",
          digest: "deadbeef",
          integrity: input.expectedIntegrity,
          contentHash: "ch",
          packageName: input.packageName,
          version: input.version,
          kind: "skill",
          reused: false,
        } as never;
      },
    });
    const mat = await deps.materialize({
      packageName: "@cinatra-ai/fixture-skill",
      version: "1.2.3",
      expectedIntegrity: sealed.integrity,
      registryUrl: SUPPLIED_SOURCE_REGISTRY_IDENTITY,
      expectedKind: "skill",
    });
    expect(mat.storeDir).toBe("/store/skill/x/deadbeef");
    expect(seen.integrity).toBe(sealed.integrity);
    expect(seen.expectedKind).toBe("skill");
    expect(Buffer.compare(seen.bytes!, sealed.tarball)).toBe(0);
  });

  it("refuses to materialize against an integrity other than the sealed one", async () => {
    const sealed = await snapshot();
    const deps = makeSuppliedSourceInstallPipelineDeps(inertBase(), sealed, {
      materializePackageToStore: async () => {
        throw new Error("must not be reached");
      },
    });
    await expect(
      deps.materialize({
        packageName: "@cinatra-ai/fixture-skill",
        version: "1.2.3",
        expectedIntegrity: "sha512-somethingelse",
        registryUrl: SUPPLIED_SOURCE_REGISTRY_IDENTITY,
      }),
    ).rejects.toThrow(/integrity .* does not match the sealed package/);
  });
});

// ---------------------------------------------------------------------------
// LONG AND NON-ASCII PATHS (convergence round, cinatra#3204)
//
// ustar carries a path in two fields — 155 bytes of directory prefix and 100
// bytes of leaf — and both are BYTE fields that a writer truncates silently.
// Two things therefore have to be true of the splitter: it must find a "/"
// boundary whenever one exists that fits (a package with a deep-but-legal path
// must pack, not be refused), and it must measure encoded bytes (a 100-
// CHARACTER non-ASCII path is longer than 100 bytes and must not be written
// truncated under a name nobody chose).
// ---------------------------------------------------------------------------

describe("the tar writer records long paths at a boundary that fits", () => {
  const deepLeaf = "a".repeat(95);

  async function extractNames(files: Map<string, Uint8Array>): Promise<string[]> {
    const tar = await import("tar");
    const { mkdtemp, writeFile, rm, readdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = (await import("node:path")).default;
    const root = await mkdtemp(path.join(tmpdir(), "cinatra-3204-ustar-"));
    try {
      const tgz = path.join(root, "pkg.tgz");
      const dest = path.join(root, "out");
      await writeFile(tgz, packSuppliedPackageTarball(files));
      await (await import("node:fs/promises")).mkdir(dest, { recursive: true });
      await tar.x({ file: tgz, cwd: dest, strip: 1 });
      const out: string[] = [];
      const walk = async (dir: string, prefix: string) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
          else out.push(rel);
        }
      };
      await walk(dest, "");
      return out.sort();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("packs a path that exceeds 100 bytes but splits at a legal boundary", async () => {
    // "package/" + "src/" + 95 characters = 107 bytes: too long for the leaf
    // field alone, and splittable at "package/src". The retired splitter walked
    // AWAY from the only usable boundary and refused this package outright.
    const files = tree();
    files.set(`src/${deepLeaf}`, te.encode("x"));
    expect(() => packSuppliedPackageTarball(files)).not.toThrow();
    expect(await extractNames(files)).toContain(`src/${deepLeaf}`);
  });

  it("refuses a leaf too long for the name field rather than truncating it", async () => {
    const files = tree();
    files.set("b".repeat(120), te.encode("x"));
    expect(() => packSuppliedPackageTarball(files)).toThrow(/too long to record in a tar archive/);
  });

  it("measures ENCODED BYTES, so a short non-ASCII leaf is not silently cut", async () => {
    // 60 characters of a three-byte code point = 180 bytes: under 100
    // characters, far over the 100-byte field. Measuring characters would have
    // written a truncated name; measuring bytes refuses it.
    const files = tree();
    files.set("ü".repeat(60), te.encode("x"));
    expect(() => packSuppliedPackageTarball(files)).toThrow(/too long to record in a tar archive/);
  });
});
