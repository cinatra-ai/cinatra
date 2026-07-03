// Recorded bundled-digests READER (cinatra#795) — fail-soft contract.
// Bundled activation must never depend on this file: absent → empty map
// (every dev boot); malformed document → warn + empty; an individually
// invalid entry → warn + dropped, the rest kept.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readRecordedBundledDigests } from "@/lib/bundled-digests";

const DIGEST = "ab".repeat(64); // 128-hex — store digest-segment grammar

describe("readRecordedBundledDigests", () => {
  let dir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bundled-digests-read-"));
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    warnSpy.mockRestore();
  });

  const writeDoc = (doc: unknown): string => {
    const p = join(dir, "digests.json");
    writeFileSync(p, typeof doc === "string" ? doc : JSON.stringify(doc));
    return p;
  };

  it("absent file → empty map, silent (normal on dev boots)", () => {
    const map = readRecordedBundledDigests(join(dir, "nope.json"));
    expect(map.size).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("valid document → entries keyed by package name", () => {
    const p = writeDoc({
      formatVersion: 1,
      packages: {
        "@cinatra-ai/x": { version: "1.0.0", kind: "connector", digest: DIGEST },
        "@cinatra-ai/y": { version: "0.1.0", kind: null, digest: DIGEST },
      },
    });
    const map = readRecordedBundledDigests(p);
    expect(map.get("@cinatra-ai/x")).toEqual({ version: "1.0.0", kind: "connector", digest: DIGEST });
    expect(map.get("@cinatra-ai/y")).toEqual({ version: "0.1.0", kind: null, digest: DIGEST });
  });

  it("malformed JSON → warn + empty map (never throws)", () => {
    const p = writeDoc("{ not json");
    expect(readRecordedBundledDigests(p).size).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("wrong formatVersion → warn + empty map", () => {
    const p = writeDoc({ formatVersion: 2, packages: { "@cinatra-ai/x": { version: "1", digest: DIGEST } } });
    expect(readRecordedBundledDigests(p).size).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("invalid entry (bad digest grammar / empty version) → dropped with warn, valid entries kept", () => {
    const p = writeDoc({
      formatVersion: 1,
      packages: {
        "@cinatra-ai/bad-digest": { version: "1.0.0", kind: "skill", digest: "not-hex" },
        "@cinatra-ai/short-digest": { version: "1.0.0", kind: "skill", digest: "abcd" },
        "@cinatra-ai/no-version": { version: "", kind: "skill", digest: DIGEST },
        "@cinatra-ai/good": { version: "1.0.0", kind: "skill", digest: DIGEST },
      },
    });
    const map = readRecordedBundledDigests(p);
    expect([...map.keys()]).toEqual(["@cinatra-ai/good"]);
    expect(warnSpy).toHaveBeenCalledTimes(3);
  });
});
