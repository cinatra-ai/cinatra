// cinatra#1196 — resolveInstalledOasPathForRead: the shared multi-vendor
// runtime-mount OAS resolver. Resolution is SCOPE-DERIVED (`@vendor/slug` →
// `<mount>/<vendor>/<slug>/cinatra/oas.json`, the materializer/projection
// naming rule) — never a vendor-candidate enumeration, so a same-slug package
// under one vendor can never shadow another (#538 class). Fail-closed on
// unscoped/malformed/traversal names via the canonical parsePackageId
// splitter (#537).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mount = vi.hoisted(() => ({ dir: "" }));
const devSource = vi.hoisted(() => ({ dir: "" }));
vi.mock("../agent-runtime-mount", () => ({
  resolveAgentRuntimeMountDir: () => mount.dir,
  resolveDevExtensionSourceRoot: () => devSource.dir,
}));

import {
  probeInstalledOasPathForRead,
  resolveInstalledOasPathForRead,
} from "../installed-oas-path";

function writeOasUnder(root: string, vendor: string, slug: string, marker: string): string {
  const dir = join(root, vendor, slug, "cinatra");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "oas.json");
  writeFileSync(p, JSON.stringify({ component_type: "Flow", marker }));
  return p;
}

function writeOas(vendor: string, slug: string, marker: string): string {
  return writeOasUnder(mount.dir, vendor, slug, marker);
}

/** The git-native dev tree a stock `setup:dev` ingests: the SAME
 *  `<vendor>/<slug>/cinatra/oas.json` shape, under `<cwd>/extensions`. */
function writeDevOas(vendor: string, slug: string, marker: string): string {
  return writeOasUnder(devSource.dir, vendor, slug, marker);
}

/** Open the cinatra#2297 dev gate exactly as a `pnpm dev` process does. */
function stubDevRuntime(): void {
  vi.stubEnv("CINATRA_RUNTIME_MODE", "development");
  vi.stubEnv("NODE_ENV", "development");
}

beforeEach(() => {
  mount.dir = mkdtempSync(join(tmpdir(), "installed-oas-path-"));
  devSource.dir = mkdtempSync(join(tmpdir(), "installed-oas-dev-source-"));
  // Hermetic: never inherit a developer shell's CINATRA_RUNTIME_MODE.
  vi.stubEnv("CINATRA_RUNTIME_MODE", "");
  vi.stubEnv("NODE_ENV", "test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveInstalledOasPathForRead (cinatra#1196)", () => {
  it("resolves a first-party @cinatra-ai package (no regression)", () => {
    const p = writeOas("cinatra-ai", "fixture-first-party-agent", "fp");
    expect(resolveInstalledOasPathForRead("@cinatra-ai/fixture-first-party-agent")).toBe(p);
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

// ── cinatra#2297 — the dev-gated SECOND read root ───────────────────────────
//
// A stock `make setup` → `pnpm setup:dev` install ingests its agents
// git-natively from `<cwd>/extensions` and NEVER writes the runtime mount, so
// the mount-only resolver returned null for every agent a fresh checkout has
// and the context trust root answered `oas_missing` for the whole interactive
// context-slot path. These cases pin BOTH halves: the dev-ingested agent now
// resolves, and production stays single-rooted and byte-identical.

describe("probeInstalledOasPathForRead — dev source root (cinatra#2297)", () => {
  it("REGRESSION: a dev-ingested agent (dev tree only, empty mount) resolves in dev", () => {
    // The exact shape of the bug: nothing in the mount, the agent present only
    // in the git-native dev tree. Mount-only resolution returns null here.
    const devPath = writeDevOas("cinatra-ai", "blog-draft-writer-agent", "dev");
    expect(
      resolveInstalledOasPathForRead("@cinatra-ai/blog-draft-writer-agent"),
    ).toBeNull();

    stubDevRuntime();
    const probe = probeInstalledOasPathForRead("@cinatra-ai/blog-draft-writer-agent");
    expect(probe.path).toBe(devPath);
    expect(probe.servedBy).toBe("dev-source");
  });

  it("resolves an operator/third-party vendor from the dev tree identically", () => {
    const devPath = writeDevOas("acme-operator", "custom-agent", "dev-op");
    stubDevRuntime();
    const probe = probeInstalledOasPathForRead("@acme-operator/custom-agent");
    expect(probe.path).toBe(devPath);
    expect(probe.servedBy).toBe("dev-source");
  });

  it("the runtime mount keeps PRECEDENCE over the dev tree in dev", () => {
    const mountPath = writeOas("cinatra-ai", "both-agent", "mount");
    writeDevOas("cinatra-ai", "both-agent", "dev");
    stubDevRuntime();
    const probe = probeInstalledOasPathForRead("@cinatra-ai/both-agent");
    expect(probe.path).toBe(mountPath);
    expect(probe.servedBy).toBe("runtime-mount");
  });

  it("a package in NEITHER root still misses, and reports both probed roots", () => {
    stubDevRuntime();
    const probe = probeInstalledOasPathForRead("@cinatra-ai/absent-agent");
    expect(probe.path).toBeNull();
    expect(probe.servedBy).toBeNull();
    expect(probe.roots).toEqual([
      { label: "runtime-mount", dir: mount.dir },
      { label: "dev-source", dir: devSource.dir },
    ]);
  });

  it("POSITIVE CONTROL: a well-formed name DOES resolve under the dev root", () => {
    // Anchors the negative cases below: the same fixture that a malformed name
    // must NOT reach is provably reachable by its legitimate name, so a null
    // there is the guard firing — not a missing fixture.
    const devPath = writeDevOas("acme", "escape", "dev");
    stubDevRuntime();
    expect(probeInstalledOasPathForRead("@acme/escape").path).toBe(devPath);
  });

  it.each([
    "@acme/a/b", // extra separator (traversal gap class)
    "@../escape", // traversal vendor
    "@acme/..", // traversal name
    "@acme/escape/../escape", // traversal that RESOLVES to the planted file
    "unscoped-agent", // unscoped
    "", // empty
  ])(
    "malformed/traversal name %j fails closed under the dev root too",
    (name) => {
      writeDevOas("acme", "escape", "dev");
      stubDevRuntime();
      expect(probeInstalledOasPathForRead(name).path).toBeNull();
    },
  );
});

describe("probeInstalledOasPathForRead — PRODUCTION posture (cinatra#2297 AC3)", () => {
  it("NODE_ENV=production never probes the dev tree, even with the dev runtime mode set", () => {
    writeDevOas("cinatra-ai", "prod-gated-agent", "dev");
    vi.stubEnv("CINATRA_RUNTIME_MODE", "development");
    vi.stubEnv("NODE_ENV", "production");
    const probe = probeInstalledOasPathForRead("@cinatra-ai/prod-gated-agent");
    expect(probe.path).toBeNull();
    expect(probe.roots).toEqual([{ label: "runtime-mount", dir: mount.dir }]);
  });

  it("a non-development CINATRA_RUNTIME_MODE never probes the dev tree — even with NODE_ENV=development", () => {
    // Exercises the runtime-mode half of the conjunction INDEPENDENTLY: with
    // NODE_ENV=development the NODE_ENV clause is satisfied, so only the
    // runtime mode can be holding the gate closed.
    writeDevOas("cinatra-ai", "mode-gated-agent", "dev");
    for (const mode of ["", "production", "test", "Development", "dev"]) {
      vi.stubEnv("CINATRA_RUNTIME_MODE", mode);
      vi.stubEnv("NODE_ENV", "development");
      const probe = probeInstalledOasPathForRead("@cinatra-ai/mode-gated-agent");
      expect(probe.path).toBeNull();
      expect(probe.roots).toEqual([{ label: "runtime-mount", dir: mount.dir }]);
    }
  });

  it("the production trust root still resolves EXACTLY the deploy-owned mount copy", () => {
    const mountPath = writeOas("cinatra-ai", "installed-agent", "mount");
    writeDevOas("cinatra-ai", "installed-agent", "dev");
    vi.stubEnv("CINATRA_RUNTIME_MODE", "production");
    vi.stubEnv("NODE_ENV", "production");
    const probe = probeInstalledOasPathForRead("@cinatra-ai/installed-agent");
    expect(probe.path).toBe(mountPath);
    expect(probe.servedBy).toBe("runtime-mount");
  });

  it("the mount-only resolver itself is UNCHANGED — it never sees the dev tree", () => {
    writeDevOas("cinatra-ai", "never-mount-agent", "dev");
    stubDevRuntime();
    expect(
      resolveInstalledOasPathForRead("@cinatra-ai/never-mount-agent"),
    ).toBeNull();
  });
});
