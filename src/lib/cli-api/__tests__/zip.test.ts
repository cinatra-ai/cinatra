import { describe, expect, it } from "vitest";

import { createZipBuffer, readZipFiles } from "../zip";

describe("cli-api zip codec", () => {
  it("round-trips a store-only archive", () => {
    const buf = createZipBuffer([
      { name: "agent.json", content: '{"formatVersion":1}' },
      { name: "manifest.json", content: '{"version":1}' },
    ]);
    const files = readZipFiles(buf);
    expect(files.get("agent.json")).toBe('{"formatVersion":1}');
    expect(files.get("manifest.json")).toBe('{"version":1}');
  });

  it("preserves UTF-8 content exactly", () => {
    const content = '{"name":"Café — 日本語 — 🚀"}';
    const buf = createZipBuffer([{ name: "agent.json", content }]);
    expect(readZipFiles(buf).get("agent.json")).toBe(content);
  });

  it("returns empty for a too-short buffer without throwing", () => {
    expect(readZipFiles(Buffer.from([1, 2, 3])).size).toBe(0);
    expect(readZipFiles(Buffer.alloc(0)).size).toBe(0);
  });

  it("returns empty when no EOCD signature is present", () => {
    expect(readZipFiles(Buffer.alloc(64, 0xff)).size).toBe(0);
  });

  it("does not throw on a truncated central directory", () => {
    const full = createZipBuffer([
      { name: "agent.json", content: '{"formatVersion":1}' },
    ]);
    // Corrupt the central-directory offset region by truncating the tail just
    // past where the EOCD would normally let the reader walk into OOB territory.
    const truncated = full.subarray(0, Math.floor(full.length / 2));
    // Must not throw — returns whatever parsed cleanly (possibly nothing).
    expect(() => readZipFiles(truncated)).not.toThrow();
  });
});
