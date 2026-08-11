/**
 * upload-archive contract (cinatra#2643).
 *
 * Locks the upload form's archive acceptance:
 *   - Standardized package layout: package.json `cinatra.entrypoint`
 *     (cinatra/oas.json) names the OAS Flow document — with and without the
 *     single top-level <slug>/ folder the export wraps everything in.
 *   - Legacy flat layout: root agent.json still resolves (fallback).
 *   - Deflate-compressed entries inflate (real-world zip tools default to
 *     deflate; the previous reader decoded compressed bytes as text).
 *   - Malformed archives fail with a REAL reason (not a ZIP, unsupported
 *     method, missing entrypoint target, junk-only, wrong extension kind).
 *   - The canonical repack is readable by the SERVER's own reader
 *     (zip-helpers.readZipFiles) and carries agent.json + the sidecars
 *     importAgentTemplateCore stages — the client/server bridge.
 *
 * Fixtures are built with the REAL server-side writer (createZipBuffer) for
 * stored entries and a minimal local method-8 writer (node:zlib) for deflate
 * entries.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/upload-archive.test.ts
 */
import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { createZipBuffer, readZipFiles } from "../zip-helpers";
import {
  readZipEntries,
  resolveAgentArchive,
  buildCanonicalAgentZip,
  buildStoredZip,
  bytesToBase64,
} from "../upload-archive";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const OAS_FLOW = JSON.stringify({
  component_type: "Flow",
  agentspec_version: "26.1.0",
  name: "Round Trip Agent",
  description: "standardized-layout fixture",
});

const PACKAGE_JSON = JSON.stringify({
  name: "@cinatra-ai/round-trip-agent",
  version: "1.0.0",
  license: "MIT",
  cinatra: { kind: "agent", entrypoint: "cinatra/oas.json" },
});

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function storedZip(files: { name: string; content: string }[]): ArrayBuffer {
  return toArrayBuffer(createZipBuffer(files));
}

/** Minimal DEFLATE (method 8) ZIP writer — what real zip tools produce. */
function deflateZip(files: { name: string; content: string }[]): ArrayBuffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const data = Buffer.from(f.content, "utf8");
    const compressed = deflateRawSync(data);
    const h = Buffer.alloc(30 + name.length);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(8, 8); // method 8 = deflate
    h.writeUInt32LE(compressed.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(name.length, 26);
    name.copy(h, 30);
    const e = Buffer.alloc(46 + name.length);
    e.writeUInt32LE(0x02014b50, 0);
    e.writeUInt16LE(20, 4);
    e.writeUInt16LE(20, 6);
    e.writeUInt16LE(8, 10); // method 8 = deflate
    e.writeUInt32LE(compressed.length, 20);
    e.writeUInt32LE(data.length, 24);
    e.writeUInt16LE(name.length, 28);
    e.writeUInt32LE(offset, 42);
    name.copy(e, 46);
    central.push(e);
    chunks.push(h, compressed);
    offset += h.length + compressed.length;
  }
  const centralStart = offset;
  let centralSize = 0;
  for (const e of central) {
    chunks.push(e);
    centralSize += e.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  chunks.push(eocd);
  return toArrayBuffer(Buffer.concat(chunks));
}

async function resolve(buf: ArrayBuffer) {
  return resolveAgentArchive(await readZipEntries(buf));
}

// ---------------------------------------------------------------------------
// Standardized layout
// ---------------------------------------------------------------------------

describe("resolveAgentArchive — standardized package layout", () => {
  it("resolves the entrypoint from package.json cinatra.entrypoint at the root", async () => {
    const resolved = await resolve(
      storedZip([
        { name: "package.json", content: PACKAGE_JSON },
        { name: "cinatra/oas.json", content: OAS_FLOW },
        { name: "proposal_snapshot.raw.json", content: "{}" },
        { name: "EXPORT-META.json", content: "{}" },
      ]),
    );
    expect(resolved.layout).toBe("standard");
    expect(resolved.strippedPrefix).toBeNull();
    expect(JSON.parse(resolved.agentJson).name).toBe("Round Trip Agent");
    expect(resolved.packageJson).toBe(PACKAGE_JSON);
  });

  it("strips a single top-level <slug>/ folder (the export layout)", async () => {
    const resolved = await resolve(
      storedZip([
        { name: "round-trip-agent/package.json", content: PACKAGE_JSON },
        { name: "round-trip-agent/cinatra/oas.json", content: OAS_FLOW },
        { name: "round-trip-agent/proposal_snapshot.raw.json", content: "{}" },
        { name: "round-trip-agent/EXPORT-META.json", content: "{}" },
      ]),
    );
    expect(resolved.layout).toBe("standard");
    expect(resolved.strippedPrefix).toBe("round-trip-agent");
    expect(JSON.parse(resolved.agentJson).component_type).toBe("Flow");
  });

  it("ignores macOS zip junk when detecting the folder prefix", async () => {
    const resolved = await resolve(
      storedZip([
        { name: "slug/package.json", content: PACKAGE_JSON },
        { name: "slug/cinatra/oas.json", content: OAS_FLOW },
        { name: "__MACOSX/slug/._package.json", content: "junk" },
        { name: "slug/.DS_Store", content: "junk" },
      ]),
    );
    expect(resolved.layout).toBe("standard");
    expect(resolved.strippedPrefix).toBe("slug");
  });

  it("normalizes a ./-prefixed entrypoint", async () => {
    const pkg = JSON.stringify({
      name: "@cinatra-ai/x-agent",
      cinatra: { kind: "agent", entrypoint: "./cinatra/oas.json" },
    });
    const resolved = await resolve(
      storedZip([
        { name: "package.json", content: pkg },
        { name: "cinatra/oas.json", content: OAS_FLOW },
      ]),
    );
    expect(resolved.layout).toBe("standard");
  });

  it("resolves the CONVENTIONAL cinatra/oas.json path when package.json declares no entrypoint (marketplace read order)", async () => {
    const pkg = JSON.stringify({
      name: "@cinatra-ai/bundled-agent",
      version: "2.0.0",
      license: "Apache-2.0",
      cinatra: { kind: "agent" }, // bundled packages declare no entrypoint
    });
    const resolved = await resolve(
      storedZip([
        { name: "bundled-agent/package.json", content: pkg },
        { name: "bundled-agent/cinatra/oas.json", content: OAS_FLOW },
      ]),
    );
    expect(resolved.layout).toBe("standard");
    expect(resolved.strippedPrefix).toBe("bundled-agent");
  });

  it("resolves a bare cinatra/oas.json payload without package.json", async () => {
    const resolved = await resolve(
      storedZip([{ name: "cinatra/oas.json", content: OAS_FLOW }]),
    );
    expect(resolved.layout).toBe("standard");
    expect(resolved.packageJson).toBeNull();
  });

  it("collects the license sidecars importAgentTemplateCore stages", async () => {
    const resolved = await resolve(
      storedZip([
        { name: "package.json", content: PACKAGE_JSON },
        { name: "cinatra/oas.json", content: OAS_FLOW },
        { name: "LICENSE", content: "MIT License" },
        { name: "COPYING", content: "copies" },
      ]),
    );
    expect([...resolved.licenseFiles.keys()].sort()).toEqual(["COPYING", "LICENSE"]);
  });
});

// ---------------------------------------------------------------------------
// Legacy layout
// ---------------------------------------------------------------------------

describe("resolveAgentArchive — legacy flat layout", () => {
  it("falls back to a root agent.json", async () => {
    const resolved = await resolve(
      storedZip([
        { name: "agent.json", content: OAS_FLOW },
        { name: "manifest.json", content: '{"version":1}' },
      ]),
    );
    expect(resolved.layout).toBe("legacy");
    expect(resolved.manifestJson).toBe('{"version":1}');
  });

  it("falls back to agent.json when package.json has no cinatra.entrypoint", async () => {
    const pkg = JSON.stringify({ name: "@cinatra-ai/legacy-agent", version: "0.1.0" });
    const resolved = await resolve(
      storedZip([
        { name: "agent.json", content: OAS_FLOW },
        { name: "package.json", content: pkg },
      ]),
    );
    expect(resolved.layout).toBe("legacy");
    expect(resolved.packageJson).toBe(pkg);
  });

  it("accepts the legacy layout under a single folder prefix too", async () => {
    const resolved = await resolve(
      storedZip([{ name: "export/agent.json", content: OAS_FLOW }]),
    );
    expect(resolved.layout).toBe("legacy");
    expect(resolved.strippedPrefix).toBe("export");
  });
});

// ---------------------------------------------------------------------------
// Deflate support
// ---------------------------------------------------------------------------

describe("readZipEntries — deflate-compressed archives", () => {
  it("inflates method-8 entries (standardized layout end to end)", async () => {
    const resolved = await resolve(
      deflateZip([
        { name: "slug/package.json", content: PACKAGE_JSON },
        { name: "slug/cinatra/oas.json", content: OAS_FLOW },
      ]),
    );
    expect(resolved.layout).toBe("standard");
    expect(JSON.parse(resolved.agentJson).agentspec_version).toBe("26.1.0");
  });

  it("inflates method-8 legacy archives", async () => {
    const resolved = await resolve(
      deflateZip([{ name: "agent.json", content: OAS_FLOW }]),
    );
    expect(resolved.layout).toBe("legacy");
  });
});

// ---------------------------------------------------------------------------
// Malformed archives
// ---------------------------------------------------------------------------

describe("malformed archives", () => {
  it("rejects a non-ZIP buffer with a real reason", async () => {
    await expect(readZipEntries(new TextEncoder().encode("not a zip").buffer as ArrayBuffer))
      .rejects.toThrow(/not a ZIP file/);
  });

  it("rejects unsupported compression methods by name", async () => {
    // Patch a stored fixture's method fields to 99 (central dir offset 10).
    const buf = Buffer.from(new Uint8Array(storedZip([{ name: "agent.json", content: OAS_FLOW }])));
    const sig = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    buf.writeUInt16LE(99, sig + 10);
    await expect(readZipEntries(toArrayBuffer(buf))).rejects.toThrow(/unsupported compression method 99/);
  });

  it("rejects an archive whose entrypoint target is missing", async () => {
    await expect(
      resolve(storedZip([{ name: "package.json", content: PACKAGE_JSON }])),
    ).rejects.toThrow(/entrypoint "cinatra\/oas\.json" \(from package\.json\) not found/);
  });

  it("rejects a non-agent extension package by kind", async () => {
    const pkg = JSON.stringify({
      name: "@cinatra-ai/some-connector",
      cinatra: { kind: "connector", entrypoint: "cinatra/oas.json" },
    });
    await expect(
      resolve(storedZip([
        { name: "package.json", content: pkg },
        { name: "cinatra/oas.json", content: OAS_FLOW },
      ])),
    ).rejects.toThrow(/"connector" extension package, not an agent package/);
  });

  it("rejects an archive with neither entrypoint nor agent.json", async () => {
    await expect(
      resolve(storedZip([{ name: "README.md", content: "hi" }])),
    ).rejects.toThrow(/no agent definition found/);
  });

  it("rejects an archive with multiple top-level folders and no root markers", async () => {
    await expect(
      resolve(storedZip([
        { name: "a/agent.json", content: OAS_FLOW },
        { name: "b/agent.json", content: OAS_FLOW },
      ])),
    ).rejects.toThrow(/no agent definition found/);
  });

  it("rejects a truncated archive with a real reason (no RangeError)", async () => {
    // Keep the EOCD readable but cut into an entry's data: build a valid zip,
    // then overwrite the first entry's central-directory size field to point
    // past the end of the buffer.
    const buf = Buffer.from(new Uint8Array(storedZip([{ name: "agent.json", content: OAS_FLOW }])));
    const sig = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    buf.writeUInt32LE(0x7fffffff, sig + 20); // compressedSize far beyond the buffer
    await expect(readZipEntries(toArrayBuffer(buf))).rejects.toThrow(/entry "agent\.json" is truncated/);
  });

  it("rejects a central directory whose local header offset points past the end", async () => {
    const buf = Buffer.from(new Uint8Array(storedZip([{ name: "agent.json", content: OAS_FLOW }])));
    const sig = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    buf.writeUInt32LE(0x7fffffff, sig + 42); // localHeaderOffset beyond the buffer
    await expect(readZipEntries(toArrayBuffer(buf))).rejects.toThrow(/truncated local header/);
  });

  it("rejects unparseable package.json", async () => {
    await expect(
      resolve(storedZip([
        { name: "package.json", content: "{nope" },
        { name: "cinatra/oas.json", content: OAS_FLOW },
      ])),
    ).rejects.toThrow(/package\.json is not valid JSON/);
  });
});

// ---------------------------------------------------------------------------
// Canonical repack — the client/server bridge
// ---------------------------------------------------------------------------

describe("buildCanonicalAgentZip", () => {
  it("produces a flat stored ZIP the SERVER reader parses (agent.json + sidecars)", async () => {
    const resolved = await resolve(
      deflateZip([
        { name: "slug/package.json", content: PACKAGE_JSON },
        { name: "slug/cinatra/oas.json", content: OAS_FLOW },
        { name: "slug/LICENSE", content: "MIT License" },
        { name: "slug/EXPORT-META.json", content: "{}" },
      ]),
    );
    const canonical = buildCanonicalAgentZip(resolved);
    // Parse with the real server-side reader (import-agent-core's).
    const serverView = readZipFiles(Buffer.from(canonical));
    expect(serverView.get("agent.json")).toBe(OAS_FLOW);
    expect(serverView.get("package.json")).toBe(PACKAGE_JSON);
    expect(serverView.get("LICENSE")).toBe("MIT License");
    // Non-import files are not carried into the canonical archive.
    expect(serverView.has("EXPORT-META.json")).toBe(false);
  });

  it("round-trips its own output through readZipEntries", async () => {
    const canonical = buildCanonicalAgentZip({
      agentJson: OAS_FLOW,
      manifestJson: '{"version":1}',
      packageJson: PACKAGE_JSON,
      licenseFiles: new Map([["LICENSE", "MIT License"]]),
      layout: "standard",
      strippedPrefix: null,
    });
    const entries = await readZipEntries(
      canonical.buffer.slice(canonical.byteOffset, canonical.byteOffset + canonical.byteLength) as ArrayBuffer,
    );
    expect([...entries.keys()].sort()).toEqual([
      "LICENSE",
      "agent.json",
      "manifest.json",
      "package.json",
    ]);
  });

  it("buildStoredZip output matches the server writer byte-for-byte semantics", () => {
    const files = [
      { name: "agent.json", content: OAS_FLOW },
      { name: "package.json", content: PACKAGE_JSON },
    ];
    const clientZip = buildStoredZip(files);
    const serverZip = createZipBuffer(files);
    expect(Buffer.from(clientZip).equals(serverZip)).toBe(true);
  });
});

describe("bytesToBase64", () => {
  it("encodes large buffers identically to Buffer.toString('base64')", () => {
    const bytes = new Uint8Array(70000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });
});
