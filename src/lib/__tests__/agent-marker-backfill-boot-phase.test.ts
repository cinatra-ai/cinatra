import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// engineering #418 — REAL-SURFACE proof that the PROD-SAFE `agent-marker-backfill`
// boot phase self-heals an on-disk agents tree.
//
// This is NOT a helper unit test (that lives in packages/agents). It drives the
// ACTUAL prod boot path:
//   - the real `agentMarkerBackfillPhases()` phase definition,
//   - through the real `runBootPhase` runner under its declared `degraded` policy,
//   - which invokes the real `backfillPublishedMarkers` helper to WRITE real
//     `.cinatra-published.json` files onto a real temp `extensions/` tree.
// Then it re-implements the wayflow loader's marker gate
// (`agent_loader.py::_inspect_published_marker`) in JS and asserts every agent
// the loader previously refused to mount now passes the gate — i.e. the agents
// LOAD. The only seams mocked are the two production-supplied externals: the
// DB-backed install-dir resolver and the wayflow HTTP reload client.
// ---------------------------------------------------------------------------

let FIXTURE_ROOT = "";

// Seam 1: install-dir resolver (DB-backed in prod) → point at the fixture tree.
vi.mock("@cinatra-ai/agents/agent-install-path", () => ({
  resolveAgentInstallDir: () => FIXTURE_ROOT,
}));

// Seam 2: wayflow reload client (HTTP to the wayflow container in prod). No
// container locally — return a benign "starting" result; the phase must treat a
// non-ok reload as non-fatal and still complete `ok`.
const triggerWayflowReload = vi.fn(async () => ({
  ok: false as const,
  reason: "container_unreachable",
  detail: "no wayflow container in this verify harness",
}));
vi.mock("@cinatra-ai/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cinatra-ai/agents")>();
  return { ...actual, triggerWayflowReload };
});

import { agentMarkerBackfillPhases } from "@/lib/boot/phases/agent-marker-backfill";
import { runBootPhase } from "@/lib/boot/boot-phase";

const PUBLISHED = ".cinatra-published.json";
const IN_PROGRESS = ".cinatra-in-progress.json";
const REQUIRED_KEYS = ["packageName", "packageVersion", "oasSha256", "publishedAt"];

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Faithful JS port of agent_loader.py::_inspect_published_marker status. */
async function loaderMarkerStatus(slugDir: string): Promise<string> {
  const oasPath = join(slugDir, "cinatra", "oas.json");
  const markerPath = join(slugDir, PUBLISHED);
  if (!existsSync(markerPath)) return "missing";
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readFile(markerPath, "utf-8"));
  } catch {
    return "malformed";
  }
  if (typeof parsed !== "object" || parsed === null) return "malformed";
  for (const k of REQUIRED_KEYS) if (!(k in parsed)) return "malformed";
  if (typeof parsed.oasSha256 !== "string") return "malformed";
  const actual = sha256(await readFile(oasPath));
  if (parsed.oasSha256 !== actual) return "hash_mismatch";
  return "valid";
}

async function makeAgentDir(
  vendor: string,
  slug: string,
  oas: Record<string, unknown>,
): Promise<string> {
  const slugDir = join(FIXTURE_ROOT, vendor, slug);
  await mkdir(join(slugDir, "cinatra"), { recursive: true });
  await writeFile(join(slugDir, "cinatra", "oas.json"), JSON.stringify(oas, null, 2));
  return slugDir;
}

describe("engineering #418 — agent-marker-backfill prod boot phase (real surface)", () => {
  beforeEach(async () => {
    FIXTURE_ROOT = await mkdtemp(join(tmpdir(), "eng418-markers-"));
    triggerWayflowReload.mockClear();
  });
  afterEach(() => vi.clearAllMocks());

  it("self-heals missing + stale markers so the wayflow loader mounts them, while never publishing an in-progress draft", async () => {
    // (a) MISSING marker — fresh install (the ossflywheel 5-of-6 case).
    const oasA = { openapi: "3.1.0", metadata: { cinatra: { packageName: "@cinatra-ai/author-agent", packageVersion: "1.2.0" } } };
    const dirA = await makeAgentDir("cinatra-ai", "author-agent", oasA);

    // (b) STALE marker — oas.json edited after the marker (re-install / OAS change).
    const oasB = { openapi: "3.1.0", metadata: { cinatra: { packageName: "@cinatra-ai/blog-agent", packageVersion: "2.0.0" } } };
    const dirB = await makeAgentDir("cinatra-ai", "blog-agent", oasB);
    await writeFile(
      join(dirB, PUBLISHED),
      JSON.stringify({
        packageName: "@cinatra-ai/blog-agent",
        packageVersion: "1.0.0",
        oasSha256: "deadbeef".repeat(8), // wrong hash → hash_mismatch
        publishedAt: "2020-01-01T00:00:00.000Z",
      }),
    );

    // (c) IN-PROGRESS draft — must NOT be promoted to published.
    const oasC = { openapi: "3.1.0", metadata: { cinatra: { packageName: "@cinatra-ai/draft-agent", packageVersion: "0.0.1" } } };
    const dirC = await makeAgentDir("cinatra-ai", "draft-agent", oasC);
    await writeFile(join(dirC, IN_PROGRESS), JSON.stringify({ draft: true }));

    // (d) ALREADY-VALID marker — must be left untouched (idempotent, no churn).
    const oasD = { openapi: "3.1.0", metadata: { cinatra: { packageName: "@cinatra-ai/good-agent", packageVersion: "3.1.0" } } };
    const dirD = await makeAgentDir("cinatra-ai", "good-agent", oasD);
    const validMarker = {
      packageName: "@cinatra-ai/good-agent",
      packageVersion: "3.1.0",
      oasSha256: sha256(await readFile(join(dirD, "cinatra", "oas.json"))),
      publishedAt: "2026-01-01T00:00:00.000Z",
    };
    await writeFile(join(dirD, PUBLISHED), JSON.stringify(validMarker));

    // PRE-CONDITION (reproduce the bug): loader refuses A and B; D ok; C draft.
    expect(await loaderMarkerStatus(dirA)).toBe("missing");
    expect(await loaderMarkerStatus(dirB)).toBe("hash_mismatch");
    expect(await loaderMarkerStatus(dirD)).toBe("valid");

    // ── RUN THE REAL PROD BOOT PHASE through the real runner ──────────────────
    const phase = agentMarkerBackfillPhases()[0];
    expect(phase.name).toBe("agent-marker-backfill");
    expect(phase.policy).toBe("degraded"); // prod-safe: log+continue, never aborts boot
    const result = await runBootPhase(phase);
    // Phase completed cleanly (the non-ok wayflow reload is swallowed).
    expect(result.status).toBe("ok");
    // It DID try to wake wayflow because it repaired markers.
    expect(triggerWayflowReload).toHaveBeenCalledTimes(1);

    // ── POST-CONDITION: the loader now MOUNTS the previously-failing agents ──
    expect(await loaderMarkerStatus(dirA)).toBe("valid"); // missing → written
    expect(await loaderMarkerStatus(dirB)).toBe("valid"); // stale → rewritten
    expect(await loaderMarkerStatus(dirD)).toBe("valid"); // untouched, still valid

    // The freshly-written marker for A carries the live oas.json hash + derived name.
    const markerA = JSON.parse(await readFile(join(dirA, PUBLISHED), "utf-8"));
    expect(markerA.oasSha256).toBe(sha256(await readFile(join(dirA, "cinatra", "oas.json"))));
    expect(markerA.packageName).toBe("@cinatra-ai/author-agent");

    // The in-progress draft was NOT published (no marker minted for it).
    expect(existsSync(join(dirC, PUBLISHED))).toBe(false);
    expect(await loaderMarkerStatus(dirC)).toBe("missing");

    // The already-valid marker D was not rewritten (byte-identical → idempotent).
    expect(JSON.parse(await readFile(join(dirD, PUBLISHED), "utf-8"))).toEqual(validMarker);
  });

  it("is idempotent + non-fatal on a second boot (re-install / restart): no further repairs, reload not re-triggered", async () => {
    const oas = { openapi: "3.1.0", metadata: { cinatra: { packageName: "@cinatra-ai/author-agent", packageVersion: "1.0.0" } } };
    const dir = await makeAgentDir("cinatra-ai", "author-agent", oas);
    expect(await loaderMarkerStatus(dir)).toBe("missing");

    // First boot heals it.
    await runBootPhase(agentMarkerBackfillPhases()[0]);
    expect(await loaderMarkerStatus(dir)).toBe("valid");
    const afterFirst = await readFile(join(dir, PUBLISHED), "utf-8");
    triggerWayflowReload.mockClear();

    // Second boot: everything already valid → nothing repaired → no reload.
    const second = await runBootPhase(agentMarkerBackfillPhases()[0]);
    expect(second.status).toBe("ok");
    expect(triggerWayflowReload).not.toHaveBeenCalled();
    expect(await readFile(join(dir, PUBLISHED), "utf-8")).toBe(afterFirst); // unchanged
  });

  it("an empty/absent agents tree is a clean no-op (degraded phase still ok)", async () => {
    // FIXTURE_ROOT exists but has no vendor dirs.
    const result = await runBootPhase(agentMarkerBackfillPhases()[0]);
    expect(result.status).toBe("ok");
    expect(triggerWayflowReload).not.toHaveBeenCalled();
    void stat; // referenced to keep import meaningful for future fixtures
  });
});
