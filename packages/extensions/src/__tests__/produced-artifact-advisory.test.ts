// cinatra#1059 — produced-artifact ADVISORY (soft cross-kind edge).
//
// The `produces` edge is advisory: missing produced-artifact extensions are
// surfaced NON-BLOCKING, never install-blocking, never auto-installed. These
// unit tests pin the two pure primitives:
//   - governingInstalledArtifactSet: scope/status row-pick (archived +
//     foreign-org rows must still count as MISSING);
//   - computeMissingProducedArtifacts: the graph-routed advisory itself.
import { describe, expect, it } from "vitest";
import {
  governingInstalledArtifactSet,
  computeMissingProducedArtifacts,
  type InstalledArtifactRowLike,
} from "../produced-artifact-advisory";

const AGENT = "@cinatra-ai/blog-draft-writer-agent";
const ART = "@cinatra-ai/blog-post-artifact";
const ORG = "org-1";

const row = (o: Partial<InstalledArtifactRowLike>): InstalledArtifactRowLike => ({
  packageName: ART,
  kind: "artifact",
  status: "active",
  organizationId: ORG,
  ...o,
});

describe("governingInstalledArtifactSet — scope/status row-pick", () => {
  it("org-owned active row governs → present", () => {
    expect(governingInstalledArtifactSet([row({})], ORG).has(ART)).toBe(true);
  });

  it("locked row governs → present", () => {
    expect(governingInstalledArtifactSet([row({ status: "locked" })], ORG).has(ART)).toBe(true);
  });

  it("ambient (null-org) active row governs any org → present", () => {
    expect(governingInstalledArtifactSet([row({ organizationId: null })], ORG).has(ART)).toBe(true);
  });

  it("ARCHIVED row does NOT govern → still missing", () => {
    expect(governingInstalledArtifactSet([row({ status: "archived" })], ORG).has(ART)).toBe(false);
  });

  it("FOREIGN-ORG-only live row does NOT govern this org → still missing", () => {
    expect(governingInstalledArtifactSet([row({ organizationId: "org-2" })], ORG).has(ART)).toBe(false);
  });

  it("org-owned row is preferred but an ambient row still satisfies", () => {
    const set = governingInstalledArtifactSet(
      [row({ organizationId: "org-2" }), row({ organizationId: null })],
      ORG,
    );
    expect(set.has(ART)).toBe(true);
  });

  it("non-artifact-kind rows are ignored", () => {
    expect(governingInstalledArtifactSet([row({ kind: "connector" })], ORG).has(ART)).toBe(false);
  });

  it("null orgId (unscoped install) still resolves an ambient row", () => {
    expect(governingInstalledArtifactSet([row({ organizationId: null })], null).has(ART)).toBe(true);
  });
});

describe("computeMissingProducedArtifacts — the advisory", () => {
  it("produces present but NOT installed → advisory names it", () => {
    expect(computeMissingProducedArtifacts(AGENT, [ART], new Set())).toEqual([ART]);
  });

  it("produces present AND installed → empty advisory", () => {
    expect(computeMissingProducedArtifacts(AGENT, [ART], new Set([ART]))).toEqual([]);
  });

  it("no produces declared → empty advisory", () => {
    expect(computeMissingProducedArtifacts(AGENT, [], new Set())).toEqual([]);
  });

  it("partial: only the uninstalled targets are surfaced", () => {
    const a = "@cinatra-ai/a-artifact";
    const b = "@cinatra-ai/b-artifact";
    expect(computeMissingProducedArtifacts(AGENT, [a, b], new Set([a]))).toEqual([b]);
  });

  it("de-duplicates repeated produces targets", () => {
    expect(computeMissingProducedArtifacts(AGENT, [ART, ART], new Set())).toEqual([ART]);
  });

  it("resolves ONLY via the installed set — the agent's own node never self-satisfies", () => {
    // The produced artifact is deliberately NOT a graph node; an
    // uninstalled-but-registry-known artifact still counts missing.
    expect(computeMissingProducedArtifacts(AGENT, [ART], new Set())).toEqual([ART]);
  });
});
