// Boot-phase tests for the deploy-owned OAS seed override (cinatra#3169).
//
// The deploy tooling that projects the pinned fleet's required-extension OAS
// seed already exports `CINATRA_REQUIRED_OAS_SEED_DIR` into the served process
// and documents it as "the application's own reconcile" input — but the boot
// phase passed NO seedDir, so the variable was inert and the reconcile always
// read the image-baked default. These tests pin the wire: the phase reads the
// variable, projects the interfaces it finds there, logs what it projected, and
// refuses a path outside the allowed root (fail-closed in production).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const mountHolder = vi.hoisted(() => ({ dir: "" }));

vi.mock("@cinatra-ai/agents/agent-runtime-mount", () => ({
  AGENT_RUNTIME_MOUNT_DIRNAME: ".agent-mount",
  resolveAgentRuntimeMountDir: () => mountHolder.dir,
}));

vi.mock("@cinatra-ai/agents", () => ({
  backfillPublishedMarkers: vi.fn(async () => {}),
  triggerWayflowReload: vi.fn(async () => ({ ok: true, report: { agents: 1 } })),
}));

import { requiredExtensionMaterializePhases } from "@/lib/boot/phases/required-extension-materialize";
import { REQUIRED_OAS_SEED_DIR_ENV } from "@/lib/required-extension-materialize";

const SEED_MARKER_FILENAME = ".cinatra-required-seed.json";
const SEED_MANIFEST_FILENAME = "manifest.json";

let root: string;
let seedDir: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  REQUIRED_OAS_SEED_DIR_ENV,
  "CINATRA_EXTENSION_DATA_ROOT",
  "CINATRA_RUNTIME_MODE",
  "CINATRA_DISABLE_REQUIRED_EXTENSION_MATERIALIZE",
];

function writeSeedSlug(vendor: string, slug: string, oas: object) {
  const slugDir = path.join(seedDir, vendor, slug);
  mkdirSync(path.join(slugDir, "cinatra"), { recursive: true });
  writeFileSync(path.join(slugDir, "cinatra", "oas.json"), JSON.stringify(oas) + "\n");
  writeFileSync(
    path.join(slugDir, SEED_MARKER_FILENAME),
    JSON.stringify({ vendor, slug, kind: "required-oas-seed" }) + "\n",
  );
  writeFileSync(
    path.join(seedDir, SEED_MANIFEST_FILENAME),
    JSON.stringify({ kind: "required-oas-seed-manifest", slugs: [{ vendor, slug }] }) + "\n",
  );
}

async function runPhase() {
  const phases = requiredExtensionMaterializePhases();
  expect(phases).toHaveLength(1);
  return await phases[0].run();
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "phase-3169-"));
  seedDir = path.join(root, "required-oas-seed");
  mkdirSync(seedDir, { recursive: true });
  mountHolder.dir = path.join(root, "mount");
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.CINATRA_EXTENSION_DATA_ROOT = path.join(root, "store");
  delete process.env.CINATRA_DISABLE_REQUIRED_EXTENSION_MATERIALIZE;
  process.env.CINATRA_RUNTIME_MODE = "production";
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("required-extension-materialize boot phase: seed-dir override", () => {
  it("projects the interfaces found in the directory the variable names", async () => {
    writeSeedSlug("cinatra-ai", "planner-agent", { openapi: "3.1.0", info: { title: "planner" } });
    process.env[REQUIRED_OAS_SEED_DIR_ENV] = seedDir;
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await runPhase();

    expect(
      existsSync(path.join(mountHolder.dir, "cinatra-ai", "planner-agent", "cinatra", "oas.json")),
    ).toBe(true);
    // It logs WHAT it projected, and from WHICH seed.
    const logged = info.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("materialized=1");
    expect(logged).toContain(seedDir);
    // ... and that the seed came from the variable, not the image default.
    expect(logged).toContain("(env)");
  });

  it("refuses a seed path outside the allowed root, fail-closed in production", async () => {
    const outside = path.join(root, "store", "seed"); // inside the durable user store
    process.env[REQUIRED_OAS_SEED_DIR_ENV] = outside;

    const failure = await runPhase().then(
      () => null,
      (err: unknown) => String(err),
    );

    expect(failure).toContain(REQUIRED_OAS_SEED_DIR_ENV);
    expect(failure).toContain(outside);
  });

  it("fails closed in production when the named seed directory has no manifest", async () => {
    process.env[REQUIRED_OAS_SEED_DIR_ENV] = seedDir; // created, but empty

    await expect(runPhase()).rejects.toThrow(new RegExp(seedDir));
  });

  it("in development a refused override is warned about and swallowed", async () => {
    process.env.CINATRA_RUNTIME_MODE = "development";
    process.env[REQUIRED_OAS_SEED_DIR_ENV] = "relative/seed";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(runPhase()).resolves.toBeDefined();

    const warned = warn.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(warned).toContain(REQUIRED_OAS_SEED_DIR_ENV);
  });

  it("reads the image-baked default when the variable is unset (production unchanged)", async () => {
    delete process.env[REQUIRED_OAS_SEED_DIR_ENV];

    await expect(runPhase()).rejects.toThrow(/\/app\/\.cinatra-required-oas-seed/);
  });
});
