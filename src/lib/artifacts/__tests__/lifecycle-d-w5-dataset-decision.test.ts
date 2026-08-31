// ---------------------------------------------------------------------------
// Wave 5 of the review plan, the dataset half, over the LIVE pinned tree.
//
// The wave decided the dataset kind on two axes and recorded the decision on its
// issue before its work: CARDINALITY — none: no dataset kind for the research
// agent, none for the scraper, and none shared between them; PLACEMENT — the
// generic structured-data base keeps both datasets, by the default road, so no
// dataset extension is built and nothing is folded into the generic one.
//
// This suite is the fence around that decision. It pins the three things the
// decision rests on and the one thing it promises:
//
//   the FACT      — neither dataset carries a declared member shape, which is
//                   why no fan-out binding can be declared over either and why a
//                   dataset kind would claim a schema it cannot hold;
//   the DECISION  — neither agent declares a dataset produces entry or an
//                   artifact dependency edge for one, and no dataset extension
//                   is pinned;
//   the LANDING   — a research-shaped dataset and a scraper-shaped dataset,
//                   serialized as the structured data they are, resolve to
//                   EXACTLY ONE home, the generic structured-data base, and to
//                   nothing else.
//
// A later wave that mints a dataset kind without re-opening the decision fails
// here, which is the point.
//
// It reads the REAL `extensions/` tree at the committed pins through the REAL
// registry bridge, so a re-pin that changes any of the above fails here too.
// ---------------------------------------------------------------------------
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { registerArtifactExtensions } from "@cinatra-ai/objects/register-artifact-extensions";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import { isPackageRequiredInProd } from "@cinatra-ai/extensions/required-in-prod";
import {
  resolveUploadArtifactTypeFromCandidates,
  selectRequiredArtifactUploadCandidates,
  type RegisteredArtifactType,
  type UploadArtifactTypeCandidate,
} from "../upload-artifact-type-map";

const EXT_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "extensions");

/** The generic structured-data base — the home both datasets keep. */
const STRUCTURED_DATA_TYPE = "@cinatra-ai/json-artifact:artifact";
const STRUCTURED_DATA_FORM = "application/json";

const RESEARCH_AGENT = "web-research-agent";
const SCRAPE_AGENT = "web-scrape-agent";

type AgentManifest = {
  cinatra?: {
    produces?: Array<{ extension?: string; objectTypeId?: string }>;
    dependencies?: Array<{ packageName?: string; kind?: string }>;
  };
};

type OasOutput = { title?: string; type?: string; json_schema?: Record<string, unknown> };

function agentManifest(slug: string): AgentManifest {
  return JSON.parse(
    readFileSync(path.join(EXT_ROOT, "cinatra-ai", slug, "package.json"), "utf8"),
  ) as AgentManifest;
}

function agentOutputs(slug: string): OasOutput[] {
  const oas = JSON.parse(
    readFileSync(path.join(EXT_ROOT, "cinatra-ai", slug, "cinatra", "oas.json"), "utf8"),
  ) as { outputs?: OasOutput[] };
  return oas.outputs ?? [];
}

function output(slug: string, title: string): OasOutput {
  const found = agentOutputs(slug).find((o) => o.title === title);
  if (found === undefined) throw new Error(`${slug} declares no output named ${title}`);
  return found;
}

/** The upload-resolution candidate set the host computes at runtime, built from
 *  the REAL bridge over the REAL pinned tree and the REAL required set. */
function liveRequiredCandidates(): UploadArtifactTypeCandidate[] {
  objectTypeRegistry._clearForTests();
  registerArtifactExtensions(EXT_ROOT);
  const types: RegisteredArtifactType[] = objectTypeRegistry.listArtifacts().map((def) => ({
    objectTypeId: def.type,
    definer: objectTypeRegistry.getRegisteringPackage(def.type),
    acceptMimes: def.isArtifact?.accepts?.file?.mimeTypes,
  }));
  return selectRequiredArtifactUploadCandidates(types, isPackageRequiredInProd);
}

describe("the fact the decision rests on: neither dataset has a member shape to name", () => {
  it("has the companion extension tree on disk (the pins are what this suite reads)", () => {
    expect(existsSync(EXT_ROOT)).toBe(true);
    expect(liveRequiredCandidates().length).toBeGreaterThan(0);
  });

  it("declares the research dataset as an array whose members have NO declared properties", () => {
    const rows = output(RESEARCH_AGENT, "enrichedRows");
    expect(rows.type).toBe("array");
    const items = (rows.json_schema?.items ?? {}) as Record<string, unknown>;
    // An object with no `properties` and no `required` is the whole member
    // declaration: the row shape is the caller's own output schema, supplied per
    // run. A binding cannot name a member field that no member declares.
    expect(items.properties).toBeUndefined();
    expect(items.required).toBeUndefined();
  });

  it("declares the scraped dataset as a bare array — not even an item type", () => {
    const items = output(SCRAPE_AGENT, "items");
    expect(items.type).toBe("array");
    expect(items.json_schema?.items).toBeUndefined();
  });

  it("takes the row shape from a per-run outputSchema INPUT on both agents", () => {
    // This is what makes the two datasets shapeless at declaration time, and
    // what makes them indistinguishable from each other at the type level.
    for (const slug of [RESEARCH_AGENT, SCRAPE_AGENT]) {
      const oas = JSON.parse(
        readFileSync(path.join(EXT_ROOT, "cinatra-ai", slug, "cinatra", "oas.json"), "utf8"),
      ) as { inputs?: Array<{ title?: string; type?: string }> };
      const schemaInput = (oas.inputs ?? []).find((i) => i.title === "outputSchema");
      expect(schemaInput).toBeDefined();
      expect(schemaInput?.type).toBe("object");
    }
  });
});

describe("the decision: no dataset kind, and no dataset extension", () => {
  it("declares NO produces entry on either agent — both datasets take the default road", () => {
    // Emptiness IS the decision for these two agents specifically: the dataset
    // is the only artifact-shaped output either of them has, so a produces entry
    // appearing here could only be a dataset kind. It is not a general rule
    // about agents.
    for (const slug of [RESEARCH_AGENT, SCRAPE_AGENT]) {
      const produces = agentManifest(slug).cinatra?.produces ?? [];
      expect(produces).toEqual([]);
    }
  });

  it("declares NO artifact dependency edge for a dataset on either agent", () => {
    // The consumer edges these two gain — the rows artifact and the schema
    // artifact each reads — are a later wave's work and are not asserted here.
    // What this pins is that no PRODUCER edge for a dataset kind appears.
    for (const slug of [RESEARCH_AGENT, SCRAPE_AGENT]) {
      const deps = agentManifest(slug).cinatra?.dependencies ?? [];
      const datasetEdges = deps.filter(
        (d) => d.kind === "artifact" && /dataset/i.test(d.packageName ?? ""),
      );
      expect(datasetEdges).toEqual([]);
    }
  });

  it("admits NO second required home for the structured-data form", () => {
    // THE NAME-INDEPENDENT FENCE. A dataset kind must hold a dataset, and a
    // dataset is `application/json`, so ANY pack minted for one — whatever it is
    // called — has to accept that form and would become a second required
    // claimant of it. Naming is not the test; claiming is. This also catches the
    // reverse mistake: a pack merely CALLED something else does not escape.
    const claimants = liveRequiredCandidates().filter((c) =>
      c.acceptMimes.some((m) => m.toLowerCase() === STRUCTURED_DATA_FORM),
    );
    expect(claimants.map((c) => c.objectTypeId)).toEqual([STRUCTURED_DATA_TYPE]);
  });

  it("keeps EVERY required upload home disjoint, so no pack can capture another's form", () => {
    // The fleet's standing packaging rule, pinned here because this wave's own
    // deliverable is the first pack whose content form is already spoken for:
    // an episode's data IS `application/json`. A binding-filed pack therefore
    // stays OUT of the required-in-prod set — required-in-prod is the upload
    // candidacy set, and a second claimant makes the host refuse to guess, which
    // would deny every ordinary json upload, not only this pack's.
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const cand of liveRequiredCandidates()) {
      for (const raw of cand.acceptMimes) {
        const mime = raw.trim().toLowerCase();
        const first = seen.get(mime);
        if (first !== undefined && first !== cand.objectTypeId) {
          collisions.push(`${mime}: ${first} + ${cand.objectTypeId}`);
        } else {
          seen.set(mime, cand.objectTypeId);
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  it("keeps the generic structured-data base complete, since both datasets rely on it", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(EXT_ROOT, "cinatra-ai", "json-artifact", "package.json"), "utf8"),
    ) as {
      exports?: Record<string, string>;
      cinatra: {
        artifact: {
          accepts: { file: { mimeTypes: string[] } };
          ui: { renderers: Record<string, { entry: string }> };
          objectTypes: Array<{ type: string; claim: string }>;
        };
      };
    };
    expect(pkg.cinatra.artifact.accepts.file.mimeTypes).toContain(STRUCTURED_DATA_FORM);
    expect(Object.keys(pkg.cinatra.artifact.ui.renderers).length).toBeGreaterThan(0);
    expect(pkg.cinatra.artifact.objectTypes.some((t) => t.type === STRUCTURED_DATA_TYPE)).toBe(true);
    // The packaging rule: the display is published through the package's own
    // `exports`, so the host resolves it without a hand-maintained alias.
    for (const renderer of Object.values(pkg.cinatra.artifact.ui.renderers)) {
      const key = `./${renderer.entry.replace(/^\.\//, "").replace(/\.(ts|tsx)$/, "")}`;
      expect(pkg.exports?.[key]).toBe(renderer.entry);
    }
  });
});

describe("the landing: both dataset shapes reach the structured-data base, and nothing else", () => {
  /** A research-agent-shaped dataset: rows extended per a caller's schema. */
  const RESEARCH_DATASET = {
    enrichedRows: [
      { company: "Example GmbH", domain: "example.com", employees: 42 },
      { company: "Beispiel AG", domain: "beispiel.de", employees: 7 },
    ],
    extractionNotes: "Two rows enriched from public pages.",
    failures: [],
    webChecks: [],
  };

  /** A scraper-shaped dataset: items shaped entirely by the caller's schema. */
  const SCRAPE_DATASET = {
    items: [
      { title: "A page", price: "12.00" },
      { title: "Another page", price: "9.50" },
    ],
    sourceUrls: ["https://example.com/a", "https://example.com/b"],
    extractionNotes: "Two items from two pages.",
    failures: [],
  };

  it("holds both datasets losslessly as the structured data they are", () => {
    // What this shows is narrow and is meant to be: both shapes survive as json
    // with nothing lost, which is why `application/json` is the form the
    // resolution below is asked about. The resolution itself turns on the FORM,
    // not on either dataset's contents — that is precisely the decision (the
    // rows are shapeless at declaration time), so no row shape is fed to it.
    for (const dataset of [RESEARCH_DATASET, SCRAPE_DATASET]) {
      const serialized = JSON.stringify(dataset);
      expect(serialized.length).toBeGreaterThan(0);
      expect(JSON.parse(serialized)).toEqual(dataset);
    }
  });

  it("resolves that form to the generic structured-data base", () => {
    expect(
      resolveUploadArtifactTypeFromCandidates(STRUCTURED_DATA_FORM, liveRequiredCandidates()),
    ).toEqual({ ok: true, objectTypeId: STRUCTURED_DATA_TYPE });
  });

  it("resolves it to EXACTLY ONE base — two claimants would be a packaging defect", () => {
    const claimants = liveRequiredCandidates().filter((c) =>
      (c.acceptMimes ?? []).includes(STRUCTURED_DATA_FORM),
    );
    expect(claimants.map((c) => c.objectTypeId)).toEqual([STRUCTURED_DATA_TYPE]);
  });

  it("routes neither dataset to a kind of its own", () => {
    const resolved = resolveUploadArtifactTypeFromCandidates(
      STRUCTURED_DATA_FORM,
      liveRequiredCandidates(),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(/dataset/i.test(resolved.objectTypeId)).toBe(false);
  });
});
