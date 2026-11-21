/**
 * cinatra#4264 (slice A0): the compiler takes the OAS source as bytes.
 *
 * The direct publisher reads the flow source once and packages exactly those
 * bytes. It hands the same bytes to the compiler, so the compiler must compile
 * them and must not open the source path a second time. Bytes that are not
 * valid UTF-8 refuse the compile instead of decoding to U+FFFD.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/oas-compiler-source-bytes-4264.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileOasAgentJson } from "../oas-compiler";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "oas-source-bytes-4264-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("compileOasAgentJson with oasSource bytes (cinatra#4264 A0)", () => {
  it("compiles the handed bytes and never opens the source path", async () => {
    // The path does not exist: a read of it would fail with "could not be read".
    const oasSourcePath = path.join(dir, "cinatra", "oas.json");
    const result = await compileOasAgentJson({
      packageName: "@cinatra-fixtures/source-bytes",
      oasSourcePath,
      oasSource: Buffer.from("{ not json", "utf8"),
    });
    expect(result.ok).toBe(false);
    const error = (result as { error: string }).error;
    expect(error).not.toMatch(/could not be read/);
    expect(error).toMatch(/malformed JSON/);
  });

  it("refuses bytes that are not valid UTF-8 (a raw 0x80 byte)", async () => {
    const bytes = Buffer.concat([
      Buffer.from('{"component_type":"Flow","name":"A', "utf8"),
      Buffer.from([0x80]),
      Buffer.from('"}', "utf8"),
    ]);
    const result = await compileOasAgentJson({
      packageName: "@cinatra-fixtures/source-bytes",
      oasSourcePath: path.join(dir, "cinatra", "oas.json"),
      oasSource: bytes,
    });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/not valid UTF-8/);
  });
});
