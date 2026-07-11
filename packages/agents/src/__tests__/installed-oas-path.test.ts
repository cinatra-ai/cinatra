// cinatra#1196 — resolveInstalledOasPathForRead: the shared multi-vendor
// runtime-mount OAS resolver. Resolution is SCOPE-DERIVED (`@vendor/slug` →
// `<mount>/<vendor>/<slug>/cinatra/oas.json`, the materializer/projection
// naming rule) — never a vendor-candidate enumeration, so a same-slug package
// under one vendor can never shadow another (#538 class). Fail-closed on
// unscoped/malformed/traversal names via the canonical parsePackageId
// splitter (#537).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mount = vi.hoisted(() => ({ dir: "" }));
vi.mock("../agent-runtime-mount", () => ({
  resolveAgentRuntimeMountDir: () => mount.dir,
}));

import { resolveInstalledOasPathForRead } from "../installed-oas-path";

function writeOas(vendor: string, slug: string, marker: string): string {
  const dir = join(mount.dir, vendor, slug, "cinatra");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "oas.json");
  writeFileSync(p, JSON.stringify({ component_type: "Flow", marker }));
  return p;
}

beforeEach(() => {
  mount.dir = mkdtempSync(join(tmpdir(), "installed-oas-path-"));
});

describe("resolveInstalledOasPathForRead (cinatra#1196)", () => {
  it("resolves a first-party @cinatra-ai package (no regression)", () => {
    const p = writeOas("cinatra-ai", "blog-pipeline-agent", "fp");
    expect(resolveInstalledOasPathForRead("@cinatra-ai/blog-pipeline-agent")).toBe(p);
  });

  it("resolves an operator/third-party-vendor package identically", () => {
    const p = writeOas("acme-operator", "custom-agent", "op");
    expect(resolveInstalledOasPathForRead("@acme-operator/custom-agent")).toBe(p);
  });

  it("SAME slug under two vendors: each name resolves its OWN oas.json (no cross-vendor shadowing)", () => {
    const fp = writeOas("cinatra-ai", "same-slug-agent", "first-party");
    const op = writeOas("acme-operator", "same-slug-agent", "operator");
    expect(resolveInstalledOasPathForRead("@cinatra-ai/same-slug-agent")).toBe(fp);
    expect(resolveInstalledOasPathForRead("@acme-operator/same-slug-agent")).toBe(op);
  });

  it("a vendor with NO installed copy returns null even when another vendor has the slug", () => {
    writeOas("cinatra-ai", "only-first-party", "fp");
    expect(resolveInstalledOasPathForRead("@ghost-vendor/only-first-party")).toBeNull();
  });

  it("returns null when the package dir exists but cinatra/oas.json is absent", () => {
    mkdirSync(join(mount.dir, "acme-operator", "empty-agent", "cinatra"), {
      recursive: true,
    });
    expect(resolveInstalledOasPathForRead("@acme-operator/empty-agent")).toBeNull();
  });

  it("unscoped names return null (never mount-projected)", () => {
    writeOas("cinatra-ai", "unscoped-agent", "fp");
    expect(resolveInstalledOasPathForRead("unscoped-agent")).toBeNull();
  });

  it.each([
    "@", // bare
    "@x", // no slash
    "@/name", // empty scope
    "@acme/", // empty name
    "@acme/a/b", // extra separator (traversal gap class)
    "@../escape", // traversal vendor
    "@acme/..", // traversal name
    "@acme/a\\b", // backslash separator
    "", // empty
  ])("malformed/traversal name %j fails closed to null", (name) => {
    expect(resolveInstalledOasPathForRead(name)).toBeNull();
  });
});
