// The four recurrence readings of the components drawing are MOUNTED, not
// awaiting a mount.
//
// conformance/app-components.json declares four surfaces of the scheduling
// step's recurrence selectors: scheduling-step-quarterly,
// scheduling-step-yearly, scheduling-step-configured-monthly and
// scheduling-step-configured-quarterly. Their drivers
// (tests/e2e/design/conformance/scheduling-recurrence-driver.ts) were bound
// behind `awaitingMount()` while the conformance harness mounted none of them,
// so the design suite SKIPPED all four. This file reds if any of them goes back
// to that state:
//
//   - each driver is bound in SURFACE_DRIVERS directly, not behind the guard;
//   - the harness page renders the mount, and the mount carries each surface id
//     over the shipped RecurrenceFrequencySelectors;
//   - the testid contract covers each surface (its files exist on this branch);
//   - the shrink-only allowlist absorbs none of them;
//   - the pin-drift map attributes the mount to the app-components pin.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const CONF_DIR = path.join(REPO_ROOT, "tests", "e2e", "design", "conformance");
const HARNESS_DIR = path.join(REPO_ROOT, "src", "app", "design-fixtures", "conformance");
const MOUNT_REL = "src/app/design-fixtures/conformance/scheduling-recurrence-fixtures.tsx";

const read = (p) => readFileSync(p, "utf8");
const readJson = (p) => JSON.parse(read(p));
const contractSource = read(path.join(CONF_DIR, "contract.ts"));

const RECURRENCE_SURFACES = [
  "scheduling-step-quarterly",
  "scheduling-step-yearly",
  "scheduling-step-configured-monthly",
  "scheduling-step-configured-quarterly",
];

describe("the recurrence readings are bound to a mounted harness surface", () => {
  it.each(RECURRENCE_SURFACES)("%s is declared by the pinned app-components manifest", (id) => {
    const declared = readJson(path.join(CONF_DIR, "manifests", "app-components.json")).surfaces.map((s) => s.id);
    expect(declared).toContain(id);
  });

  it.each(RECURRENCE_SURFACES)("%s has its driver bound directly, not behind awaitingMount", (id) => {
    expect(
      contractSource.includes(`"${id}": recurrenceSelectorsDriver("${id}"),`),
      `contract.ts does not bind "${id}" to recurrenceSelectorsDriver directly`,
    ).toBe(true);
    expect(
      contractSource.includes(`awaitingMount("${id}"`),
      `contract.ts still wraps "${id}" in awaitingMount(): the design suite would skip it`,
    ).toBe(false);
  });

  it("no longer names a recurrence reason to skip", () => {
    expect(contractSource.includes("AWAITING_RECURRENCE_SELECTORS")).toBe(false);
  });

  it("renders the mount on the conformance harness page", () => {
    const page = read(path.join(HARNESS_DIR, "page.tsx"));
    expect(page).toContain('import { SchedulingRecurrenceConformanceFixtures } from "./scheduling-recurrence-fixtures";');
    expect(page).toContain("<SchedulingRecurrenceConformanceFixtures />");
  });

  it.each(RECURRENCE_SURFACES)("the mount carries %s over the shipped selectors", (id) => {
    const mountPath = path.join(REPO_ROOT, MOUNT_REL);
    expect(existsSync(mountPath), `${MOUNT_REL} is missing`).toBe(true);
    const mount = read(mountPath);
    expect(mount).toContain(`data-surface-id="${id}" data-variant="populated"`);
    expect(mount).toContain("<RecurrenceFrequencySelectors");
    expect(mount).toContain('from "@cinatra-ai/agents/schedule-proposal-card"');
  });

  it.each(RECURRENCE_SURFACES)("the testid contract covers %s", (id) => {
    const contract = readJson(path.join(CONF_DIR, "testid-contract.json"));
    expect(contract.surfaces[id], `testid-contract.json has no entry for "${id}"`).toBeDefined();
  });

  it("adds no allowlist entry for any of them", () => {
    const allowlist = readJson(path.join(CONF_DIR, "allowlist.json")).allow;
    const absorbed = allowlist.map((entry) => entry.surface).filter((surface) => RECURRENCE_SURFACES.includes(surface));
    expect(absorbed).toEqual([]);
  });

  it("attributes the mount to the app-components pin in the pin-drift map", () => {
    const map = readJson(path.join(REPO_ROOT, "scripts", "ci", "design-pin-drift.paths.json"));
    expect(map.pins["app-components"]).toContain(MOUNT_REL);
  });
});
