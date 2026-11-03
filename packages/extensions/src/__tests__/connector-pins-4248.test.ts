// cinatra#4248: the three LinkedIn/Nango connector pins track their merged commits.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

type LockEntry = { packageName: string; resolvedSha: string };

function readLock(file: string): LockEntry[] {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, file), "utf8")).packages as LockEntry[];
}

function shaOf(entries: LockEntry[], packageName: string): string | undefined {
  return entries.find((p) => p.packageName === packageName)?.resolvedSha;
}

describe("connector pins for the Community Management change (cinatra#4248)", () => {
  it("pins nango-connector in the required lock to its merged commit", () => {
    expect(shaOf(readLock("cinatra-required-extensions.lock.json"), "@cinatra-ai/nango-connector")).toBe(
      "cb06457c0d28776df806fd20ea6a0b6fe20ae519",
    );
  });

  it("pins linkedin-connector in the dev lock to its merged commit", () => {
    expect(shaOf(readLock("cinatra-dev-extensions.lock.json"), "@cinatra-ai/linkedin-connector")).toBe(
      "43469ef082b3548e6b58285cbcfef3841d6244ff",
    );
  });

  it("pins linkedin-oauth-connector in the dev lock to its merged commit", () => {
    expect(shaOf(readLock("cinatra-dev-extensions.lock.json"), "@cinatra-ai/linkedin-oauth-connector")).toBe(
      "f0db670f829aad61d44a3da411e51ed6f1f2ceba",
    );
  });
});
