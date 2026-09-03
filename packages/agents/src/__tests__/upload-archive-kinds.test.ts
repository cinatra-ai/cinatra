/**
 * Kind-aware, hardened archive intake for the File road (cinatra#3204,
 * acceptance criteria 1-5 and 29).
 *
 * Before this change the File tab resolved AGENT archives only: the resolver
 * refused any declared `cinatra.kind` other than "agent" by name and left the
 * submit button dead. It also read whatever the archive contained — no entry
 * cap, no size cap, no path-traversal check, no symlink check — and produced no
 * statement about the bytes it had read.
 *
 * This suite is the contract for what replaced it:
 *
 *   - all FOUR live installable kinds resolve (agent, connector, artifact,
 *     skill), each proven with the payload shape its own published packages
 *     ship;
 *   - the refusal set is explicit and each refusal NAMES what it found and what
 *     is accepted;
 *   - intake is hardened BEFORE anything is read into the resolved tree;
 *   - the delivered tree carries a content digest (D2);
 *   - nothing in the archive is ever executed.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/upload-archive-kinds.test.ts
 */
import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { createZipBuffer } from "../zip-helpers";
import {
  DEFAULT_ARCHIVE_INTAKE_LIMITS,
  UPLOADABLE_EXTENSION_KINDS,
  readZipArchive,
  resolveUploadedExtensionArchive,
} from "../upload-archive";

// ---------------------------------------------------------------------------
// Fixtures — the payload shape each kind's published packages actually ship
// (read off the pinned extension trees: cinatra/oas.json for an agent,
// skills/<name>/SKILL.md for a skill, cinatra/config.json for a connector,
// a cinatra.artifact descriptor for an artifact).
// ---------------------------------------------------------------------------

const OAS_FLOW = JSON.stringify({
  component_type: "Flow",
  agentspec_version: "26.1.0",
  name: "Fixture Agent",
});

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function zip(files: { name: string; content: string }[]): ArrayBuffer {
  return toArrayBuffer(createZipBuffer(files));
}

async function resolve(files: { name: string; content: string }[]) {
  return resolveUploadedExtensionArchive(await readZipArchive(zip(files)));
}

const agentPkg = JSON.stringify({
  name: "@cinatra-ai/fixture-agent",
  version: "0.1.2",
  license: "Apache-2.0",
  cinatra: { apiVersion: "cinatra.ai/v1", kind: "agent", displayName: "Fixture Agent" },
});
const agentFiles = [
  { name: "package.json", content: agentPkg },
  { name: "cinatra/oas.json", content: OAS_FLOW },
];

const skillPkg = JSON.stringify({
  name: "@cinatra-ai/fixture-skill",
  version: "0.2.0",
  cinatra: { apiVersion: "cinatra.ai/v1", kind: "skill", skillRole: "injectable" },
});
const skillFiles = [
  { name: "package.json", content: skillPkg },
  { name: "skills/fixture/SKILL.md", content: "# Fixture skill\n" },
];

const connectorPkg = JSON.stringify({
  name: "@cinatra-ai/fixture-connector",
  version: "0.1.5",
  cinatra: { apiVersion: "cinatra.ai/v1", kind: "connector", uiSurface: "schema-config" },
});
const connectorFiles = [
  { name: "package.json", content: connectorPkg },
  { name: "cinatra/config.json", content: JSON.stringify({ scope: "workspace" }) },
  { name: "src/register.ts", content: "export function register() {}\n" },
];

const artifactPkg = JSON.stringify({
  name: "@cinatra-ai/fixture-artifact",
  version: "0.1.4",
  cinatra: {
    apiVersion: "cinatra.ai/v1",
    kind: "artifact",
    displayName: "Fixture",
    artifact: { accepts: ["text/markdown"] },
  },
});
const artifactFiles = [
  { name: "package.json", content: artifactPkg },
  { name: "src/index.ts", content: "export const x = 1;\n" },
];

// ---------------------------------------------------------------------------
// 1. Every live installable kind resolves
// ---------------------------------------------------------------------------

describe("the File road accepts every live installable kind", () => {
  it("names exactly the four live kinds — workflow is not among them", () => {
    expect([...UPLOADABLE_EXTENSION_KINDS]).toEqual(["agent", "connector", "artifact", "skill"]);
  });

  it("resolves an AGENT package and carries its OAS payload", async () => {
    const resolved = await resolve(agentFiles);
    expect(resolved.kind).toBe("agent");
    expect(resolved.packageName).toBe("@cinatra-ai/fixture-agent");
    expect(resolved.packageVersion).toBe("0.1.2");
    expect(resolved.agentJson).toBe(OAS_FLOW);
  });

  it("resolves a CONNECTOR package — the refusal this replaces is gone", async () => {
    const resolved = await resolve(connectorFiles);
    expect(resolved.kind).toBe("connector");
    expect(resolved.packageName).toBe("@cinatra-ai/fixture-connector");
    expect(resolved.agentJson).toBeNull();
  });

  it("resolves an ARTIFACT package", async () => {
    const resolved = await resolve(artifactFiles);
    expect(resolved.kind).toBe("artifact");
    expect(resolved.packageVersion).toBe("0.1.4");
  });

  it("resolves a SKILL package", async () => {
    const resolved = await resolve(skillFiles);
    expect(resolved.kind).toBe("skill");
    expect([...resolved.files.keys()]).toContain("skills/fixture/SKILL.md");
  });

  it("tolerates the single top-level folder the export wraps everything in, for every kind", async () => {
    for (const files of [agentFiles, connectorFiles, artifactFiles, skillFiles]) {
      const wrapped = files.map((f) => ({ name: `pkg/${f.name}`, content: f.content }));
      const resolved = await resolve(wrapped);
      expect(resolved.strippedPrefix).toBe("pkg");
      // The delivered tree is the STRIPPED one — the wrapper folder is
      // packaging, not content, and must not reach the store or the digest.
      expect([...resolved.files.keys()].every((n) => !n.startsWith("pkg/"))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The refusal set — each names what was found and what is accepted
// ---------------------------------------------------------------------------

describe("the refusal set names what was found and what is accepted", () => {
  it("refuses an archive that declares NO kind", async () => {
    await expect(
      resolve([
        { name: "package.json", content: JSON.stringify({ name: "@v/thing", version: "1.0.0" }) },
        { name: "README.md", content: "hi" },
      ]),
    ).rejects.toThrow(/declares no `cinatra\.kind`[\s\S]*agent, connector, artifact, skill/);
  });

  it("refuses an UNKNOWN kind by name", async () => {
    await expect(
      resolve([
        {
          name: "package.json",
          content: JSON.stringify({ name: "@v/thing", version: "1.0.0", cinatra: { kind: "widget" } }),
        },
      ]),
    ).rejects.toThrow(/"widget"[\s\S]*not an installable extension kind[\s\S]*agent, connector, artifact, skill/);
  });

  it("refuses WORKFLOW with the reason it is not installable", async () => {
    await expect(
      resolve([
        {
          name: "package.json",
          content: JSON.stringify({
            name: "@v/thing-workflow",
            version: "1.0.0",
            cinatra: { kind: "workflow" },
          }),
        },
      ]),
    ).rejects.toThrow(/"workflow"[\s\S]*retired[\s\S]*no installable handler/);
  });

  it("refuses an archive with no package.json at all", async () => {
    await expect(resolve([{ name: "README.md", content: "hi" }])).rejects.toThrow(
      /no package\.json/,
    );
  });

  it("refuses a package.json that is not valid JSON", async () => {
    await expect(
      resolve([{ name: "package.json", content: "{ not json" }]),
    ).rejects.toThrow(/package\.json is not valid JSON/);
  });

  it("refuses a missing name and a missing version separately", async () => {
    await expect(
      resolve([
        { name: "package.json", content: JSON.stringify({ version: "1.0.0", cinatra: { kind: "skill" } }) },
      ]),
    ).rejects.toThrow(/missing a "name"/);
    await expect(
      resolve([
        { name: "package.json", content: JSON.stringify({ name: "@v/x-skill", cinatra: { kind: "skill" } }) },
      ]),
    ).rejects.toThrow(/missing a valid "version"/);
  });
});

// ---------------------------------------------------------------------------
// 3. Cross-kind smuggling and name-to-kind mismatch
// ---------------------------------------------------------------------------

describe("a payload of one kind cannot be smuggled in under another kind's name", () => {
  it("refuses a package DECLARING skill that ships an agent payload and no skill", async () => {
    await expect(
      resolve([
        {
          name: "package.json",
          content: JSON.stringify({
            name: "@cinatra-ai/smuggled-skill",
            version: "1.0.0",
            cinatra: { kind: "skill" },
          }),
        },
        { name: "cinatra/oas.json", content: OAS_FLOW },
      ]),
    ).rejects.toThrow(/declares `cinatra\.kind: "skill"` but carries no skill payload/);
  });

  it("refuses a package DECLARING connector with no cinatra/config.json", async () => {
    await expect(
      resolve([
        {
          name: "package.json",
          content: JSON.stringify({
            name: "@cinatra-ai/hollow-connector",
            version: "1.0.0",
            cinatra: { kind: "connector" },
          }),
        },
        { name: "src/index.ts", content: "export const x = 1;\n" },
      ]),
    ).rejects.toThrow(/declares `cinatra\.kind: "connector"` but carries no connector payload/);
  });

  it("refuses a package DECLARING agent with no agent definition", async () => {
    await expect(
      resolve([
        {
          name: "package.json",
          content: JSON.stringify({
            name: "@cinatra-ai/hollow-agent",
            version: "1.0.0",
            cinatra: { kind: "agent" },
          }),
        },
        { name: "skills/x/SKILL.md", content: "# x\n" },
      ]),
    ).rejects.toThrow(/declares `cinatra\.kind: "agent"` but carries no agent payload/);
  });

  it("refuses an ARTIFACT carrying a cinatra.oas payload — it must never be agent-mountable", async () => {
    await expect(
      resolve([
        {
          name: "package.json",
          content: JSON.stringify({
            name: "@cinatra-ai/sneaky-artifact",
            version: "1.0.0",
            cinatra: { kind: "artifact", artifact: { accepts: [] }, oas: { paths: {} } },
          }),
        },
      ]),
    ).rejects.toThrow(/must not carry a `cinatra\.oas` payload/);
  });

  it("refuses an ARTIFACT with no cinatra.artifact descriptor", async () => {
    await expect(
      resolve([
        {
          name: "package.json",
          content: JSON.stringify({
            name: "@cinatra-ai/bare-artifact",
            version: "1.0.0",
            cinatra: { kind: "artifact" },
          }),
        },
      ]),
    ).rejects.toThrow(/carries no artifact payload/);
  });

  it("refuses a name whose kind suffix contradicts the declared kind", async () => {
    await expect(
      resolve([
        {
          name: "package.json",
          content: JSON.stringify({
            name: "@cinatra-ai/looks-like-a-connector",
            version: "1.0.0",
            cinatra: { kind: "artifact", artifact: { accepts: [] } },
          }),
        },
      ]),
    ).rejects.toThrow(/name "@cinatra-ai\/looks-like-a-connector" ends in "-connector"[\s\S]*declares `cinatra\.kind: "artifact"`/);
  });

  it("accepts a name carrying NO kind suffix — that rule belongs to the kind's own validator", async () => {
    const resolved = await resolve([
      {
        name: "package.json",
        content: JSON.stringify({
          name: "@cinatra-ai/plain-name",
          version: "1.0.0",
          cinatra: { kind: "skill" },
        }),
      },
      { name: "skills/plain/SKILL.md", content: "# plain\n" },
    ]);
    expect(resolved.kind).toBe("skill");
  });
});

// ---------------------------------------------------------------------------
// 4. Hardened intake — each refusal leaves nothing resolved
// ---------------------------------------------------------------------------

/** ZIP writer that can stamp external attributes (for the symlink fixture). */
function zipWithAttrs(
  files: { name: string; content: string; externalAttrs?: number }[],
): ArrayBuffer {
  const te = new TextEncoder();
  const encoded = files.map((f) => ({
    name: te.encode(f.name),
    data: te.encode(f.content),
    attrs: f.externalAttrs ?? 0,
  }));
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let offset = 0;
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const byte of b) c = (c >>> 8) ^ crcTable[(c ^ byte) & 0xff];
    return (c ^ 0xffffffff) >>> 0;
  };
  for (const { name, data } of encoded) {
    offsets.push(offset);
    const h = new Uint8Array(30 + name.length);
    const v = new DataView(h.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint32(14, crc32(data), true);
    v.setUint32(18, data.length, true);
    v.setUint32(22, data.length, true);
    v.setUint16(26, name.length, true);
    h.set(name, 30);
    chunks.push(h, data);
    offset += h.length + data.length;
  }
  const centralStart = offset;
  encoded.forEach(({ name, data, attrs }, i) => {
    const e = new Uint8Array(46 + name.length);
    const v = new DataView(e.buffer);
    v.setUint32(0, 0x02014b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 20, true);
    v.setUint32(16, crc32(data), true);
    v.setUint32(20, data.length, true);
    v.setUint32(24, data.length, true);
    v.setUint16(28, name.length, true);
    v.setUint32(38, attrs >>> 0, true);
    v.setUint32(42, offsets[i], true);
    e.set(name, 46);
    chunks.push(e);
    offset += e.length;
  });
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, encoded.length, true);
  ev.setUint16(10, encoded.length, true);
  ev.setUint32(12, offset - centralStart, true);
  ev.setUint32(16, centralStart, true);
  chunks.push(eocd);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const c of chunks) {
    out.set(c, cursor);
    cursor += c.length;
  }
  return out.buffer as ArrayBuffer;
}

describe("intake is hardened before anything is resolved", () => {
  it("rejects a path-traversal entry by name", async () => {
    await expect(
      readZipArchive(zip([{ name: "../escape.json", content: "{}" }])),
    ).rejects.toThrow(/entry "\.\.\/escape\.json" escapes the package root/);
  });

  it("rejects a traversal segment in the middle of a path", async () => {
    await expect(
      readZipArchive(zip([{ name: "a/../../escape.json", content: "{}" }])),
    ).rejects.toThrow(/escapes the package root/);
  });

  it("rejects an absolute path and a Windows drive path", async () => {
    await expect(readZipArchive(zip([{ name: "/etc/passwd", content: "x" }]))).rejects.toThrow(
      /is an absolute path/,
    );
    await expect(readZipArchive(zip([{ name: "C:\\evil", content: "x" }]))).rejects.toThrow(
      /is an absolute path/,
    );
  });

  it("rejects a backslash separator, which normalizes differently per platform", async () => {
    await expect(readZipArchive(zip([{ name: "a\\b.json", content: "{}" }]))).rejects.toThrow(
      /backslash/,
    );
  });

  it("rejects a NUL byte in an entry name", async () => {
    await expect(readZipArchive(zip([{ name: "a\u0000b", content: "x" }]))).rejects.toThrow(
      /control character/,
    );
  });

  it("rejects a SYMLINK entry", async () => {
    // 0xA1FF0000 = unix mode 0o120777 (S_IFLNK | 0777) in the high 16 bits.
    const buf = zipWithAttrs([
      { name: "package.json", content: agentPkg },
      { name: "link", content: "../../../etc/passwd", externalAttrs: 0xa1ff0000 },
    ]);
    await expect(readZipArchive(buf)).rejects.toThrow(
      /entry "link" is a symbolic link/,
    );
  });

  it("rejects an archive declaring more entries than the cap", async () => {
    await expect(
      readZipArchive(zip([{ name: "a.txt", content: "x" }]), { maxEntries: 0 }),
    ).rejects.toThrow(/declares 1 entries, more than the 0 accepted/);
  });

  it("rejects an entry larger than the per-entry cap BEFORE decompressing it", async () => {
    await expect(
      readZipArchive(zip([{ name: "big.txt", content: "0123456789" }]), {
        maxEntryUncompressedBytes: 4,
      }),
    ).rejects.toThrow(/entry "big\.txt" unpacks to 10 bytes, more than the 4 accepted/);
  });

  it("rejects a tree whose total unpacked size exceeds the cap", async () => {
    await expect(
      readZipArchive(
        zip([
          { name: "a.txt", content: "0123456789" },
          { name: "b.txt", content: "0123456789" },
        ]),
        { maxTotalUncompressedBytes: 12 },
      ),
    ).rejects.toThrow(/unpacks to 20 bytes in total, more than the 12 accepted/);
  });

  it("publishes the caps it enforces, so the form can state them", () => {
    expect(DEFAULT_ARCHIVE_INTAKE_LIMITS.maxEntries).toBeGreaterThan(0);
    expect(DEFAULT_ARCHIVE_INTAKE_LIMITS.maxTotalUncompressedBytes).toBeGreaterThan(0);
    expect(DEFAULT_ARCHIVE_INTAKE_LIMITS.maxEntryUncompressedBytes).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 5. The delivered tree carries a digest, and nothing is executed
// ---------------------------------------------------------------------------

describe("the delivered tree is digested and never executed", () => {
  it("carries a canonical content digest over the resolved tree", async () => {
    const resolved = await resolve(skillFiles);
    expect(resolved.contentDigest).toMatch(/^sha256-[0-9a-f]{64}$/);
  });

  it("digests the STRIPPED tree, so the same package wrapped in a folder digests identically", async () => {
    const flat = await resolve(skillFiles);
    const wrapped = await resolve(
      skillFiles.map((f) => ({ name: `pkg/${f.name}`, content: f.content })),
    );
    expect(wrapped.contentDigest).toBe(flat.contentDigest);
  });

  it("changes the digest when one byte of the payload changes", async () => {
    const a = await resolve(skillFiles);
    const b = await resolve([
      skillFiles[0],
      { name: "skills/fixture/SKILL.md", content: "# Fixture skill!\n" },
    ]);
    expect(a.contentDigest).not.toBe(b.contentDigest);
  });

  it("executes no package code during resolution", async () => {
    const marker = "__cinatra_3204_upload_intake_executed__";
    delete (globalThis as Record<string, unknown>)[marker];
    await resolve([
      {
        name: "package.json",
        content: JSON.stringify({
          name: "@cinatra-ai/hostile-skill",
          version: "1.0.0",
          cinatra: { kind: "skill" },
        }),
      },
      { name: "skills/hostile/SKILL.md", content: "# hostile\n" },
      { name: "index.js", content: `globalThis[${JSON.stringify(marker)}] = true;\n` },
      {
        name: "postinstall.js",
        content: `globalThis[${JSON.stringify(marker)}] = true;\n`,
      },
    ]);
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 9. THE DECLARED SIZE IS NOT THE MEASURED SIZE (convergence round, cinatra#3204)
//
// The caps in section 8 are read from the central directory, and the central
// directory is written by whoever built the archive. So the intake must not
// stop at the declaration: an entry that CLAIMS one unpacked byte and inflates
// to hundreds of megabytes is the ordinary shape of a compression bomb, and a
// stored entry can claim a small unpacked size beside a huge stored payload.
// These build such archives by hand — `createZipBuffer` cannot lie — and pin
// that each is refused, and refused without materializing the payload.
// ---------------------------------------------------------------------------

type RawEntry = {
  name: string;
  method: number;
  data: Buffer;
  declaredUncompressed: number;
};

/** A ZIP built field by field, so the central directory can disagree with the
 *  bytes. The reader never verifies CRCs, so they are left zero. */
function handBuiltZip(entries: RawEntry[]): ArrayBuffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(entry.method, 8);
    lfh.writeUInt32LE(entry.data.length, 18);
    lfh.writeUInt32LE(entry.declaredUncompressed, 22);
    lfh.writeUInt16LE(nameBytes.length, 26);
    locals.push(lfh, nameBytes, entry.data);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(entry.method, 10);
    cdh.writeUInt32LE(entry.data.length, 20);
    cdh.writeUInt32LE(entry.declaredUncompressed, 24);
    cdh.writeUInt16LE(nameBytes.length, 28);
    cdh.writeUInt32LE(offset, 42);
    centrals.push(cdh, nameBytes);

    offset += lfh.length + nameBytes.length + entry.data.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  const buf = Buffer.concat([...locals, central, eocd]);
  return toArrayBuffer(buf);
}

describe("the intake measures what arrives, it does not believe the declaration", () => {
  it("refuses a DEFLATE entry that inflates past its declared unpacked size", async () => {
    // 8 MB of zeroes deflates to a few kilobytes; the archive declares one byte.
    const payload = deflateRawSync(Buffer.alloc(8 * 1024 * 1024, 0));
    const archive = handBuiltZip([
      { name: "package.json", method: 8, data: payload, declaredUncompressed: 1 },
    ]);
    await expect(readZipArchive(archive)).rejects.toThrow(/package\.json/);
  });

  it("refuses that entry on the BUDGET when the declaration is not the binding limit", async () => {
    // The same bomb against caps small enough that the budget, not the
    // declaration mismatch, is what stops it — the stream is abandoned rather
    // than read to the end and measured afterwards.
    const payload = deflateRawSync(Buffer.alloc(4 * 1024 * 1024, 0));
    const archive = handBuiltZip([
      { name: "big.bin", method: 8, data: payload, declaredUncompressed: 64 * 1024 },
    ]);
    await expect(
      readZipArchive(archive, {
        maxEntryUncompressedBytes: 64 * 1024,
        maxTotalUncompressedBytes: 64 * 1024,
      }),
    ).rejects.toThrow(/still accepted/);
  });

  it("refuses a STORED entry whose declared sizes disagree", async () => {
    const archive = handBuiltZip([
      {
        name: "package.json",
        method: 0,
        data: Buffer.alloc(4096, 0x41),
        declaredUncompressed: 1,
      },
    ]);
    await expect(readZipArchive(archive)).rejects.toThrow(/stored uncompressed but declares/);
  });

  it("still reads an HONEST deflate entry", async () => {
    const content = Buffer.from("# Fixture skill\n", "utf8");
    const archive = handBuiltZip([
      {
        name: "skills/fixture/SKILL.md",
        method: 8,
        data: deflateRawSync(content),
        declaredUncompressed: content.length,
      },
    ]);
    const entries = await readZipArchive(archive);
    expect(new TextDecoder().decode(entries.get("skills/fixture/SKILL.md")!)).toBe(
      "# Fixture skill\n",
    );
  });
});
