// Seed-determinism pins for the presence-conditional demo workflow seed
// (cinatra#151 Stage 6). Both universes are pinned:
//   - REQUIRED-ONLY (the 8 systemExtensions): every template/instance naming
//     an optional agent is SKIPPED cleanly (no dangling agent ref survives,
//     the kept set is deterministic, the seed stays green);
//   - FULL universe: the kept set is IDENTICAL to the complete fixture list
//     (byte-for-byte the same ids the seed wrote before the filter existed).
// The test consumes the SAME builder module scripts/seed.mjs seeds from, so
// the pins cannot drift from the real fixture data.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildWorkflowSeedTemplates,
  buildWorkflowSeedInstances,
} from "../seed-lib/workflow-fixtures.mjs";
import {
  collectAgentRefPackages,
  filterWorkflowSeedByPresence,
  readPresentExtensionPackages,
} from "../seed-lib/extension-presence.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const ORGS = {
  orgGroup: "org-acme-group",
  orgRobotics: "org-acme-robotics",
  orgCloud: "org-acme-cloud",
};
const dateFn = (n) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000);

function buildFixtures() {
  return {
    templates: buildWorkflowSeedTemplates(ORGS),
    instances: buildWorkflowSeedInstances({ ...ORGS, daysFromNow: dateFn, cascadeDay: dateFn }),
  };
}

/** The 8 systemExtensions — the required-only universe (read from the root
 * manifest so the pin tracks the real system set, never a stale copy). */
function requiredOnlyUniverse() {
  const rootPkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const system = rootPkg?.cinatra?.systemExtensions;
  expect(Array.isArray(system) && system.length > 0).toBe(true);
  return new Set(system);
}

/** Every agent package the fixture set references, for the full-universe pin. */
function allReferencedAgents(fixtures) {
  const all = new Set();
  collectAgentRefPackages(fixtures.templates, all);
  collectAgentRefPackages(fixtures.instances, all);
  return all;
}

describe("seed workflow fixtures — presence-conditional determinism", () => {
  it("FULL universe: kept set is IDENTICAL to the complete fixture list (no skips)", () => {
    const fixtures = buildFixtures();
    const present = allReferencedAgents(fixtures);
    const filtered = filterWorkflowSeedByPresence(fixtures, present);
    expect(filtered.skippedTemplates).toEqual([]);
    expect(filtered.skippedInstances).toEqual([]);
    expect(filtered.templates.map((t) => t.id)).toEqual(fixtures.templates.map((t) => t.id));
    expect(filtered.instances.map((i) => i.id)).toEqual(fixtures.instances.map((i) => i.id));
    // The complete fixture set is the v65 demo shape: 6 templates, 18 instances.
    expect(fixtures.templates).toHaveLength(6);
    expect(fixtures.instances).toHaveLength(18);
  });

  it("REQUIRED-ONLY universe: optional-agent fixtures are skipped cleanly, kept set has ZERO dangling refs", () => {
    const fixtures = buildFixtures();
    const present = requiredOnlyUniverse();
    const filtered = filterWorkflowSeedByPresence(fixtures, present);

    // No kept row may reference an absent package (the core obligation:
    // never seed a dangling agent ref).
    for (const t of filtered.templates) {
      const refs = [...collectAgentRefPackages(t)];
      expect(refs.filter((p) => !present.has(p)), t.id).toEqual([]);
    }
    for (const wf of filtered.instances) {
      const refs = [...collectAgentRefPackages(wf)];
      expect(refs.filter((p) => !present.has(p)), wf.id).toEqual([]);
      // A kept instance must never dangle on a skipped template.
      if (wf.sourceTemplateId) {
        expect(filtered.skippedTemplates.map((s) => s.id), wf.id).not.toContain(wf.sourceTemplateId);
      }
    }

    // Deterministic: same inputs, same outputs (order preserved).
    const again = filterWorkflowSeedByPresence(buildFixtures(), requiredOnlyUniverse());
    expect(again.templates.map((t) => t.id)).toEqual(filtered.templates.map((t) => t.id));
    expect(again.instances.map((i) => i.id)).toEqual(filtered.instances.map((i) => i.id));
    expect(again.skippedTemplates).toEqual(filtered.skippedTemplates);
    expect(again.skippedInstances).toEqual(filtered.skippedInstances);

    // The skips are EXACTLY the optional-agent fixtures (pin the ids so a
    // fixture rename/regrowth is a conscious change here, not silent drift).
    expect(filtered.skippedTemplates.map((s) => s.id).sort()).toEqual([
      "wftpl-seed-v65-beta-release",
      "wftpl-seed-v65-major-product-release",
      "wftpl-seed-v65-marketing-campaign-approval",
    ].sort());
    const missing = new Set(filtered.skippedTemplates.flatMap((s) => s.missing));
    expect([...missing].sort()).toEqual([
      "@cinatra-ai/blog-linkedin-writer-agent",
      "@cinatra-ai/blog-pipeline-agent",
      "@cinatra-ai/email-outreach-agent",
    ]);
    // Every skipped record names ONLY genuinely-absent packages.
    for (const s of [...filtered.skippedTemplates, ...filtered.skippedInstances]) {
      for (const p of s.missing) expect(present.has(p), p).toBe(false);
    }
    // Anti-vacuity in BOTH directions: some fixtures skipped, some kept.
    expect(filtered.skippedInstances.length).toBeGreaterThan(0);
    expect(filtered.templates.length).toBeGreaterThan(0);
    expect(filtered.instances.length).toBeGreaterThan(0);
  });

  it("the LIVE materialized universe yields a green, dangle-free seed set (full tree: zero skips)", () => {
    const present = readPresentExtensionPackages(path.join(REPO_ROOT, "extensions"));
    if (present.size === 0) {
      console.warn("[seed-workflow-presence.test] extensions/ tree absent — live-universe pin skipped");
      return;
    }
    const fixtures = buildFixtures();
    const filtered = filterWorkflowSeedByPresence(fixtures, present);
    for (const wf of [...filtered.templates, ...filtered.instances]) {
      const refs = [...collectAgentRefPackages(wf)];
      expect(refs.filter((p) => !present.has(p)), wf.id).toEqual([]);
    }
    // On the full dev universe every referenced agent is present.
    const referenced = allReferencedAgents(fixtures);
    if ([...referenced].every((p) => present.has(p))) {
      expect(filtered.templates).toHaveLength(fixtures.templates.length);
      expect(filtered.instances).toHaveLength(fixtures.instances.length);
    }
  });
});
