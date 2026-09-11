/**
 * THE RUN WIZARD'S LAUNCH GATE AND A BUNDLED SKILL DEPENDENCY (cinatra#3369).
 *
 * MEASURED on a development boot of this branch:
 * `/agents/cinatra-ai/list-curator-agent/new` answered 200 and drew the
 * application's own not-found boundary. Neither of the two
 * roads the issue names first was the defect — the scoped package name
 * reconstructs correctly (`@cinatra-ai/list-curator-agent`) and the template
 * lookup finds the published row. The refusal came from the launch gate, read
 * off the boot's own log at the `/new` request:
 *
 *   [gate] {"packageName":"@cinatra-ai/list-curator-agent","packageVersion":"0.2.0",
 *          "notRunnable":{"error":"Agent cannot run: @cinatra-ai/list-curator-agent
 *          requires List Curation Skill (@cinatra-ai/list-curation-skill), which is
 *          not installed. Install the missing extension from the marketplace first."}}
 *
 * `createAndTriggerRunCore` returns that refusal, and the wizard route's `new`
 * fast path turns a non-ok result into `notFound()` — the 200 plus the not-found
 * boundary the issue reports.
 *
 * WHY THE REFUSAL IS FALSE. The dependency arm's evidence for "not installed" is
 * "the catalog governs this package as `guardedOptional` AND it has no canonical
 * `installed_extension` row". For a SKILL that evidence does not hold: a skill's
 * liveness is not the canonical row. `isSkillExtensionLiveFailClosed`
 * (packages/skills/src/extension-skill-resolver.ts) ends on
 * `return true; // no lifecycle rows -> image-shipped floor (live by being on disk)`,
 * and this module's own header names that same rule as the floor it follows. On
 * the measured boot 19 of the 27 scanned skills carry no canonical row — the boot
 * seeder anchors one only for the `required` set — and `@cinatra-ai/list-curation-skill`
 * was registered live on that very boot (`1 SKILL.md registered`). So the gate
 * refused a run the skills resolver would have served.
 *
 * An explicitly ARCHIVED skill row is untouched: the archive still beats the
 * floor, exactly as it does for every other kind.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/list-curator-run-wizard-skill-dependency.test.ts
 */
import { describe, it, expect } from "vitest";
import { isInstallBlockingEdge } from "@cinatra-ai/extensions/dependency-closure";
import {
  resolveAgentRunAvailability,
  assertAgentPackageRunnable,
  type AgentCatalogRecord,
  type AgentCatalogView,
  type AgentEffectiveInstallStatus,
} from "../runtime-install-gate";

function edge(
  packageName: string,
  kind: AgentCatalogRecord["kind"],
  requirement: "required" | "optional",
) {
  return {
    packageName,
    kind,
    edgeType: "runtime",
    versionConstraint: { kind: "semver-range", range: "*" },
    requirement,
  } as NonNullable<AgentCatalogRecord["dependencies"]>[number];
}

/**
 * The list curator's catalog shape, copied from the generated catalog on the
 * measured boot (`src/lib/generated/extensions.server.ts`): version 0.2.0,
 * `guardedOptional`, a REQUIRED agent edge, two optional agent edges and a
 * REQUIRED **skill** edge.
 */
const LIST_CURATOR_CATALOG: AgentCatalogView = {
  "@cinatra-ai/list-curator-agent": {
    packageName: "@cinatra-ai/list-curator-agent",
    kind: "agent",
    version: "0.2.0",
    resolution: "guardedOptional",
    displayName: "List Curator Agent",
    dependencies: [
      edge("@cinatra-ai/web-scrape-agent", "agent", "required"),
      edge("@cinatra-ai/company-discovery-agent", "agent", "optional"),
      edge("@cinatra-ai/contact-discovery-agent", "agent", "optional"),
      edge("@cinatra-ai/list-curation-skill", "skill", "required"),
    ],
  } as AgentCatalogRecord,
  "@cinatra-ai/web-scrape-agent": {
    packageName: "@cinatra-ai/web-scrape-agent",
    kind: "agent",
    version: "0.1.2",
    resolution: "guardedOptional",
    displayName: "Web Scrape Agent",
    dependencies: [],
  } as AgentCatalogRecord,
  "@cinatra-ai/list-curation-skill": {
    packageName: "@cinatra-ai/list-curation-skill",
    kind: "skill",
    version: "0.1.0",
    resolution: "guardedOptional",
    displayName: "List Curation Skill",
    dependencies: [],
  } as AgentCatalogRecord,
};

/** The statuses MEASURED in `cinatra.installed_extension` on that boot: the
 *  agent and its required agent dependency active, the skill with NO row. */
const MEASURED_STATUSES: Record<string, AgentEffectiveInstallStatus> = {
  "@cinatra-ai/list-curator-agent": "active",
  "@cinatra-ai/web-scrape-agent": "active",
};

function availability(statuses: Record<string, AgentEffectiveInstallStatus>) {
  return resolveAgentRunAvailability({
    packageName: "@cinatra-ai/list-curator-agent",
    effectiveStatus: statuses["@cinatra-ai/list-curator-agent"],
    templateVersion: "0.2.0",
    catalog: LIST_CURATOR_CATALOG,
    statusOf: (name) => statuses[name],
    isBlockingEdge: isInstallBlockingEdge,
  });
}

describe("the launch gate and a bundled skill dependency (cinatra#3369)", () => {
  it("an installed agent whose required SKILL dependency has no canonical row is runnable", () => {
    expect(availability(MEASURED_STATUSES).state).toBe("runnable");
  });

  it("an ARCHIVED skill dependency still refuses (the archive beats the image-shipped floor)", () => {
    const verdict = availability({
      ...MEASURED_STATUSES,
      "@cinatra-ai/list-curation-skill": "archived",
    });
    expect(verdict.state).toBe("missing-required-dependency");
    if (verdict.state === "missing-required-dependency") {
      expect(verdict.missing).toEqual([
        {
          packageName: "@cinatra-ai/list-curation-skill",
          displayName: "List Curation Skill",
          kind: "skill",
          reason: "archived",
        },
      ]);
    }
  });

  it("a missing required AGENT dependency still refuses (the floor is skill-only)", () => {
    const verdict = availability({ "@cinatra-ai/list-curator-agent": "active" });
    expect(verdict.state).toBe("missing-required-dependency");
    if (verdict.state === "missing-required-dependency") {
      expect(verdict.missing.map((m) => m.packageName)).toEqual([
        "@cinatra-ai/web-scrape-agent",
      ]);
    }
  });

  it("the execution gate answers the wizard route with no refusal for that shape", async () => {
    const refusal = await assertAgentPackageRunnable(
      "@cinatra-ai/list-curator-agent",
      "@cinatra-ai/list-curator-agent",
      {
        packageVersion: "0.2.0",
        readCatalog: async () => LIST_CURATOR_CATALOG,
        readStatus: async (names) =>
          new Map(
            names
              .filter((n) => MEASURED_STATUSES[n] !== undefined)
              .map((n) => [n, MEASURED_STATUSES[n] as "active" | "archived"]),
          ),
        isBlockingEdge: isInstallBlockingEdge,
      },
    );
    expect(refusal).toBeNull();
  });
});
