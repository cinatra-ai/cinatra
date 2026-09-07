/**
 * THE NPM-LAYOUT PACKER (cinatra#3204 leg 2).
 *
 * Leg 1's pipeline entry takes an npm-layout tarball; the repository road
 * receives a tree. This module is the join, so what it has to prove is narrow
 * and total: the layout is the one the store strips, deep paths are split across
 * the ustar fields rather than truncated, a path that fits neither field is
 * REFUSED, and the same tree always packs to the same bytes.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";

import { NPM_TARBALL_ROOT, buildNpmLayoutTarball } from "@/lib/supplied-package-tarball";

const bytes = (text: string) => new TextEncoder().encode(text);

/** Every entry name the archive declares, read straight off the tar headers. */
function headerNames(tarball: Uint8Array): string[] {
  const raw = gunzipSync(Buffer.from(tarball));
  const names: string[] = [];
  const decoder = new TextDecoder("utf-8");
  for (let offset = 0; offset + 512 <= raw.length; ) {
    const block = raw.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const readField = (start: number, length: number) => {
      const field = block.subarray(start, start + length);
      const end = field.indexOf(0);
      return decoder.decode(end < 0 ? field : field.subarray(0, end));
    };
    const name = readField(0, 100);
    const prefix = readField(345, 155);
    names.push(prefix === "" ? name : `${prefix}/${name}`);
    const size = parseInt(readField(124, 12).trim() || "0", 8);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

describe("buildNpmLayoutTarball", () => {
  it("puts every file under the single npm root the store strips", () => {
    const tarball = buildNpmLayoutTarball([
      ["package.json", bytes('{"name":"@acme/x"}')],
      ["cinatra/oas.json", bytes("{}")],
    ]);
    expect(headerNames(tarball)).toEqual([
      `${NPM_TARBALL_ROOT}/cinatra/oas.json`,
      `${NPM_TARBALL_ROOT}/package.json`,
    ]);
  });

  it("splits a deep path across the ustar prefix and name fields, losing nothing", async () => {
    const deep = `${"segment/".repeat(14)}file.md`;
    expect(deep.length).toBeGreaterThan(100);
    const tarball = buildNpmLayoutTarball([[deep, bytes("deep")]]);
    expect(headerNames(tarball)).toEqual([`${NPM_TARBALL_ROOT}/${deep}`]);

    // And node-tar — the library the store extracts with — agrees.
    const root = await mkdtemp(path.join(tmpdir(), "cinatra-tarball-"));
    try {
      const file = path.join(root, "p.tgz");
      const dest = path.join(root, "out");
      await mkdir(dest, { recursive: true });
      await writeFile(file, tarball);
      await tar.x({ file, cwd: dest, strip: 1 });
      let walk = dest;
      for (const segment of deep.split("/").slice(0, -1)) {
        expect((await readdir(walk)).length).toBe(1);
        walk = path.join(walk, segment);
      }
      expect(await readdir(walk)).toEqual(["file.md"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("REFUSES a path that fits neither field rather than truncating it", () => {
    const unsplittable = "x".repeat(120);
    expect(() => buildNpmLayoutTarball([[unsplittable, bytes("x")]])).toThrow(/too long for the tar header/);
  });

  it("REFUSES an empty entry path", () => {
    expect(() => buildNpmLayoutTarball([["", bytes("x")]])).toThrow(/empty path/);
  });

  it("packs the same tree to the same bytes, in any input order", () => {
    const a = buildNpmLayoutTarball([
      ["b.txt", bytes("b")],
      ["a.txt", bytes("a")],
    ]);
    const b = buildNpmLayoutTarball([
      ["a.txt", bytes("a")],
      ["b.txt", bytes("b")],
    ]);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // CONVERGENCE (round 1): header fields are BYTE fields, not character fields.
  // Writing them from `charCodeAt` masked to a byte mistranslated every
  // non-ASCII name, and U+012E masked to 0x2E — the ASCII dot — so a legitimate
  // repository path could be written into the archive as a TRAVERSING one.
  // -------------------------------------------------------------------------
  describe("non-ASCII paths", () => {
    it("writes a Unicode name as its own UTF-8 bytes, never as masked code units", () => {
      const tarball = buildNpmLayoutTarball([["caf\u00e9.txt", bytes("x")]]);
      expect(headerNames(tarball)).toEqual([`${NPM_TARBALL_ROOT}/caf\u00e9.txt`]);
    });

    it("never turns a Unicode directory name into a traversing one", () => {
      // U+012E & 0xff === 0x2e; two of them masked to "..".
      const packed = buildNpmLayoutTarball([["\u012e\u012e/escape.txt", bytes("x")]]);
      const names = headerNames(packed);
      expect(names).toEqual([`${NPM_TARBALL_ROOT}/\u012e\u012e/escape.txt`]);
      for (const name of names) {
        expect(name.split("/")).not.toContain("..");
      }
    });

    it("does not smuggle a NUL into a header by masking a code unit", () => {
      // U+0100 & 0xff === 0x00, which would terminate the field early.
      const tarball = buildNpmLayoutTarball([["\u0100.txt", bytes("x")]]);
      expect(headerNames(tarball)).toEqual([`${NPM_TARBALL_ROOT}/\u0100.txt`]);
    });

    it("measures the name and prefix fields in BYTES, so a multi-byte path round-trips", async () => {
      // 40 two-byte characters per segment: well under 100 CHARACTERS in the
      // last segment, well over 100 BYTES for the whole path.
      const segment = "\u00e9".repeat(40);
      const deep = `${segment}/${segment}/file.md`;
      expect(deep.length).toBeLessThan(200);
      expect(new TextEncoder().encode(deep).byteLength).toBeGreaterThan(100);
      const tarball = buildNpmLayoutTarball([[deep, bytes("deep")]]);
      expect(headerNames(tarball)).toEqual([`${NPM_TARBALL_ROOT}/${deep}`]);

      const dir = await mkdtemp(path.join(tmpdir(), "supplied-tarball-utf8-"));
      try {
        const archive = path.join(dir, "p.tgz");
        await writeFile(archive, Buffer.from(tarball));
        const out = path.join(dir, "out");
        await mkdir(out, { recursive: true });
        await tar.x({ file: archive, cwd: out, strip: 1 });
        const landed = await readdir(path.join(out, segment, segment));
        expect(landed).toEqual(["file.md"]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("refuses a path whose UTF-8 bytes fit no header field rather than truncating it", () => {
      const unsplittable = "\u00e9".repeat(80);
      expect(new TextEncoder().encode(unsplittable).byteLength).toBeGreaterThan(100);
      expect(() => buildNpmLayoutTarball([[unsplittable, bytes("x")]])).toThrow(/too long for the tar header/);
    });
  });

});
