/**
 * The KIND-AWARE, HARDENED archive reader (cinatra#3204 D3 — criteria 1, 2, 3, 4
 * and 5; the red-first per-kind coverage criterion 29 asks for).
 *
 * The reader has no filesystem, no network and no execution, so "leaves nothing
 * written" is a property of the module rather than of a cleanup step: every
 * refusal below is proven to reject, and the module is proven to contain no
 * execution surface at all (the last describe block reads its own source).
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/upload-archive-supplied-kinds.test.ts
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

import { createZipBuffer } from "../zip-helpers";
import {
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_TOTAL_BYTES,
  SUPPLIED_ARCHIVE_KINDS,
  archiveEntryNameRefusal,
  readZipEntries,
  resolveSuppliedArchive,
} from "../upload-archive";
import {
  MAX_SUPPLIED_TREE_BYTES,
  MAX_SUPPLIED_TREE_ENTRIES,
  SUPPLIED_PACKAGE_KINDS,
  SUPPLIED_REPOSITORY_SUBJECT,
  computeContentDigest,
  resolveSuppliedPackageTree,
} from "@cinatra-ai/extension-types";

// ---------------------------------------------------------------------------
// Fixtures — one minimal, VALID package per live kind.
// ---------------------------------------------------------------------------

const OAS_FLOW = JSON.stringify({ component_type: "Flow", agentspec_version: "26.1.0", name: "A" });
const DESCRIPTOR = JSON.stringify({ name: "thing", schema: { type: "object" } });

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}
const storedZip = (files: { name: string; content: string }[]) =>
  toArrayBuffer(createZipBuffer(files));

const pkgJson = (over: Record<string, unknown>) =>
  JSON.stringify({ name: "@acme/thing", version: "1.0.0", ...over });

const KIND_FIXTURES: Record<string, { name: string; content: string }[]> = {
  agent: [
    {
      name: "package.json",
      content: pkgJson({ name: "@acme/thing-agent", cinatra: { kind: "agent", entrypoint: "cinatra/oas.json" } }),
    },
    { name: "cinatra/oas.json", content: OAS_FLOW },
  ],
  skill: [
    { name: "package.json", content: pkgJson({ name: "@acme/thing-skill", cinatra: { kind: "skill" } }) },
    { name: "skills/thing/SKILL.md", content: "---\nname: thing\n---\n# Thing" },
  ],
  connector: [
    {
      name: "package.json",
      content: pkgJson({
        name: "@acme/thing-connector",
        cinatra: { kind: "connector", uiSurface: "schema-config", serverEntry: "dist/server.js" },
      }),
    },
    { name: "dist/server.js", content: "export function register(){ throw new Error('never run'); }" },
  ],
  artifact: [
    {
      name: "package.json",
      content: pkgJson({ name: "@acme/thing-artifact", cinatra: { kind: "artifact", entrypoint: "cinatra/artifact.json" } }),
    },
    { name: "cinatra/artifact.json", content: DESCRIPTOR },
  ],
};

const resolveFixture = async (files: { name: string; content: string }[]) =>
  resolveSuppliedArchive(await readZipEntries(storedZip(files)));

// ---------------------------------------------------------------------------
// Criterion 1 + 2 — one accepted kind per live kind
// ---------------------------------------------------------------------------

describe("resolveSuppliedArchive accepts every live kind", () => {
  it("declares exactly the four live kinds and not the retired one", () => {
    expect([...SUPPLIED_ARCHIVE_KINDS]).toEqual(["agent", "skill", "connector", "artifact"]);
    expect(SUPPLIED_ARCHIVE_KINDS as readonly string[]).not.toContain("workflow");
  });

  it("accepts an AGENT package and resolves its OAS Flow document", async () => {
    const r = await resolveFixture(KIND_FIXTURES.agent);
    expect(r.kind).toBe("agent");
    expect(r.packageName).toBe("@acme/thing-agent");
    expect(r.version).toBe("1.0.0");
    expect([...r.payload.keys()]).toEqual(["cinatra/oas.json"]);
  });

  it("accepts a SKILL package and resolves its SKILL.md", async () => {
    const r = await resolveFixture(KIND_FIXTURES.skill);
    expect(r.kind).toBe("skill");
    expect([...r.payload.keys()]).toEqual(["skills/thing/SKILL.md"]);
  });

  it("accepts a CONNECTOR package and resolves its declared serverEntry (criterion 2)", async () => {
    const r = await resolveFixture(KIND_FIXTURES.connector);
    expect(r.kind).toBe("connector");
    expect([...r.payload.keys()]).toEqual(["dist/server.js"]);
  });

  it("accepts an ARTIFACT package and resolves its descriptor", async () => {
    const r = await resolveFixture(KIND_FIXTURES.artifact);
    expect(r.kind).toBe("artifact");
    expect([...r.payload.keys()]).toEqual(["cinatra/artifact.json"]);
  });

  it("accepts each kind under a single top-level folder too", async () => {
    for (const [kind, files] of Object.entries(KIND_FIXTURES)) {
      const name = JSON.parse(files[0].content).name as string;
      const folder = name.slice(name.indexOf("/") + 1);
      const wrapped = files.map((f) => ({ name: `${folder}/${f.name}`, content: f.content }));
      const r = await resolveSuppliedArchive(await readZipEntries(storedZip(wrapped)));
      expect(r.kind).toBe(kind);
      expect(r.strippedPrefix).toBe(folder);
    }
  });
});

// ---------------------------------------------------------------------------
// Criterion 1 — the refusal set, each naming what was found and what is accepted
// ---------------------------------------------------------------------------

describe("resolveSuppliedArchive refuses by name", () => {
  it("refuses an archive that declares NO kind", async () => {
    await expect(
      resolveFixture([{ name: "package.json", content: pkgJson({ cinatra: {} }) }]),
    ).rejects.toThrow(/declares no cinatra\.kind/);
  });

  it("refuses an UNKNOWN kind and lists what is accepted", async () => {
    await expect(
      resolveFixture([{ name: "package.json", content: pkgJson({ cinatra: { kind: "widget" } }) }]),
    ).rejects.toThrow(/"widget" is not an extension kind this product installs/);
  });

  it("refuses the RETIRED workflow kind as retired, not as unknown", async () => {
    await expect(
      resolveFixture([{ name: "package.json", content: pkgJson({ cinatra: { kind: "workflow" } }) }]),
    ).rejects.toThrow(/"workflow" is a retired extension kind/);
  });

  it("refuses an archive with no package.json at all", async () => {
    await expect(resolveFixture([{ name: "README.md", content: "hi" }])).rejects.toThrow(
      /no package\.json found/,
    );
  });

  it("refuses an unparseable package.json", async () => {
    await expect(
      resolveFixture([{ name: "package.json", content: "{not json" }]),
    ).rejects.toThrow(/package\.json is not valid JSON/);
  });
});

// ---------------------------------------------------------------------------
// Criterion 3 — intake hardening. Every case refuses and nothing is written
// (the reader has no writer; see the execution-surface block at the end).
// ---------------------------------------------------------------------------

describe("intake hardening (criterion 3)", () => {
  it("refuses a path-traversing entry", async () => {
    expect(archiveEntryNameRefusal("../evil.js")).toMatch(/traverses/);
    expect(archiveEntryNameRefusal("a/../../evil.js")).toMatch(/traverses/);
    await expect(
      readZipEntries(storedZip([{ name: "../evil.js", content: "x" }])),
    ).rejects.toThrow(/traverses out of the archive root/);
  });

  it("refuses an absolute entry path", async () => {
    expect(archiveEntryNameRefusal("/etc/passwd")).toMatch(/absolute/);
    expect(archiveEntryNameRefusal("C:/windows/x")).toMatch(/absolute/);
    await expect(
      readZipEntries(storedZip([{ name: "/etc/passwd", content: "x" }])),
    ).rejects.toThrow(/is an absolute path/);
  });

  it("refuses a backslash-bearing entry name as ambiguous", async () => {
    expect(archiveEntryNameRefusal("a\\b")).toMatch(/backslash/);
  });

  it("refuses a SYMLINK entry", async () => {
    // A ZIP symlink is a normal entry whose unix mode says S_IFLNK; the flag
    // lives in the central directory's external attributes.
    const zip = Buffer.from(new Uint8Array(toArrayBuffer(createZipBuffer([{ name: "link", content: "../../etc/passwd" }]))));
    // Locate the central-directory record and stamp S_IFLNK into its external
    // attributes (offset +38), leaving every other byte alone.
    const centralSig = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(centralSig).toBeGreaterThan(0);
    zip.writeUInt32LE((0o120777) << 16 >>> 0, centralSig + 38);
    await expect(readZipEntries(toArrayBuffer(zip))).rejects.toThrow(
      /entry "link" is a symlink, which is not allowed/,
    );
  });

  it("refuses an archive declaring more entries than the cap", async () => {
    // Forge the EOCD's entry count — the cap is read before the walk, which is
    // the point: the refusal costs one comparison, not a traversal.
    const zip = Buffer.from(new Uint8Array(toArrayBuffer(createZipBuffer([{ name: "a", content: "x" }]))));
    const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    zip.writeUInt16LE(0xffff, eocd + 10);
    expect(0xffff).toBeGreaterThan(MAX_ARCHIVE_ENTRIES);
    await expect(readZipEntries(toArrayBuffer(zip))).rejects.toThrow(/over the .* limit/);
  });

  it("refuses an archive whose DECLARED uncompressed total is over the cap, before inflating", async () => {
    const zip = Buffer.from(new Uint8Array(toArrayBuffer(createZipBuffer([{ name: "a", content: "x" }]))));
    const centralSig = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    // Declare a huge uncompressed size (offset +24) over a one-byte payload —
    // the classic bomb shape.
    zip.writeUInt32LE(MAX_ARCHIVE_TOTAL_BYTES + 1, centralSig + 24);
    await expect(readZipEntries(toArrayBuffer(zip))).rejects.toThrow(/limit/);
  });

  it("refuses a package.json with no name or no version", async () => {
    await expect(
      resolveFixture([
        { name: "package.json", content: JSON.stringify({ version: "1.0.0", cinatra: { kind: "skill" } }) },
      ]),
    ).rejects.toThrow(/declares no name/);
    await expect(
      resolveFixture([
        { name: "package.json", content: JSON.stringify({ name: "@acme/x-skill", cinatra: { kind: "skill" } }) },
      ]),
    ).rejects.toThrow(/declares no version/);
  });

  it("refuses a name that disagrees with the archive's own top-level folder", async () => {
    const files = KIND_FIXTURES.skill.map((f) => ({ name: `not-the-name/${f.name}`, content: f.content }));
    await expect(resolveFixture(files)).rejects.toThrow(
      /declares the name "@acme\/thing-skill", but the archive's top-level folder is "not-the-name"/,
    );
  });

  it("computes the content digest over the delivered tree, and it matches the shared encoding", async () => {
    const r = await resolveFixture(KIND_FIXTURES.skill);
    const expected = await computeContentDigest(
      KIND_FIXTURES.skill.map((f) => ({ path: f.name, bytes: new TextEncoder().encode(f.content) })),
    );
    expect(r.contentDigest).toBe(expected);
    expect(r.contentDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives the same digest whether or not the package is wrapped in its own folder", async () => {
    const flat = await resolveFixture(KIND_FIXTURES.skill);
    const wrapped = await resolveFixture(
      KIND_FIXTURES.skill.map((f) => ({ name: `thing-skill/${f.name}`, content: f.content })),
    );
    expect(wrapped.contentDigest).toBe(flat.contentDigest);
  });
});

// ---------------------------------------------------------------------------
// Criterion 4 — cross-kind smuggling and kind-to-payload mismatch
// ---------------------------------------------------------------------------

describe("cross-kind smuggling (criterion 4)", () => {
  it("refuses an AGENT payload that declares itself a connector", async () => {
    await expect(
      resolveFixture([
        {
          name: "package.json",
          content: pkgJson({ name: "@acme/thing-connector", cinatra: { kind: "connector" } }),
        },
        { name: "cinatra/oas.json", content: OAS_FLOW },
      ]),
    ).rejects.toThrow(/declares kind "connector" but does not contain a package\.json "cinatra\.serverEntry"/);
  });

  it("refuses a CONNECTOR payload that declares itself a skill", async () => {
    await expect(
      resolveFixture([
        { name: "package.json", content: pkgJson({ name: "@acme/thing-skill", cinatra: { kind: "skill", serverEntry: "dist/server.js" } }) },
        { name: "dist/server.js", content: "export function register(){}" },
      ]),
    ).rejects.toThrow(/declares kind "skill" but does not contain a SKILL\.md/);
  });

  it("refuses a package declaring an entrypoint the archive does not contain", async () => {
    await expect(
      resolveFixture([
        { name: "package.json", content: pkgJson({ name: "@acme/thing-agent", cinatra: { kind: "agent", entrypoint: "cinatra/oas.json" } }) },
      ]),
    ).rejects.toThrow(/does not contain the entrypoint "cinatra\/oas\.json"/);
  });

  it("refuses an ARTIFACT package with no descriptor", async () => {
    await expect(
      resolveFixture([
        { name: "package.json", content: pkgJson({ name: "@acme/thing-artifact", cinatra: { kind: "artifact" } }) },
        { name: "README.md", content: "hi" },
      ]),
    ).rejects.toThrow(/declares kind "artifact" but does not contain an artifact descriptor/);
  });
});

// ---------------------------------------------------------------------------
// Criterion 5 — no package code is executed during preview or validation
// ---------------------------------------------------------------------------

describe("no package code is executed (criterion 5)", () => {
  it("resolves a package whose files would throw if they were ever run", async () => {
    // Every file here is a live grenade if evaluated. The reader treats all of
    // them as text.
    const r = await resolveFixture([
      {
        name: "package.json",
        content: pkgJson({
          name: "@acme/thing-connector",
          cinatra: { kind: "connector", uiSurface: "schema-config", serverEntry: "dist/server.js" },
        }),
      },
      { name: "dist/server.js", content: "process.exit(1); throw new Error('POISON RAN');" },
      { name: "index.js", content: "throw new Error('POISON RAN');" },
      { name: "postinstall.js", content: "require('child_process').execSync('touch /tmp/pwned');" },
    ]);
    expect(r.kind).toBe("connector");
    expect(r.payload.get("dist/server.js")).toContain("POISON RAN");
  });

  it("the reader module contains NO execution surface at all", () => {
    // A property of the module, checked against its own source: no dynamic
    // import, no eval, no Function constructor, no child_process, no fs. A
    // future edit that adds one fails here rather than in production.
    const source = readFileSync(path.resolve(__dirname, "../upload-archive.ts"), "utf8");
    const body = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
      .join("\n");
    expect(body).not.toMatch(/\beval\s*\(/);
    expect(body).not.toMatch(/new\s+Function\s*\(/);
    expect(body).not.toMatch(/\bimport\s*\(/);
    expect(body).not.toMatch(/\brequire\s*\(/);
    expect(body).not.toMatch(/child_process/);
    expect(body).not.toMatch(/node:fs/);
  });
});

// ---------------------------------------------------------------------------
// ONE predicate, every road (cinatra#3204 leg 2, criterion 6)
// ---------------------------------------------------------------------------

describe("the kind predicate is SHARED, not copied (criterion 6)", () => {
  it("resolves through the leaf package's list, so the repository road cannot drift", () => {
    // Identity, not equality. A second list that happened to agree today is
    // exactly the thing this assertion exists to forbid.
    expect(SUPPLIED_ARCHIVE_KINDS).toBe(SUPPLIED_PACKAGE_KINDS);
  });

  it("enforces the leaf package's caps, so a cap raised on one road is raised on both", () => {
    expect(MAX_ARCHIVE_ENTRIES).toBe(MAX_SUPPLIED_TREE_ENTRIES);
    expect(MAX_ARCHIVE_TOTAL_BYTES).toBe(MAX_SUPPLIED_TREE_BYTES);
  });

  it("refuses a REPOSITORY by its own noun, through the same resolution", async () => {
    // The shared resolver is the archive reader's own body; only the noun in the
    // refusal changes, so the repository road can say "repository" without a
    // second implementation of what is accepted.
    await expect(
      resolveSuppliedPackageTree(
        new Map([["README.md", new TextEncoder().encode("hi")]]),
        SUPPLIED_REPOSITORY_SUBJECT,
      ),
    ).rejects.toThrow(/Invalid repository: no package\.json found/);
  });
});
