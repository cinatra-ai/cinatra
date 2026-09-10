import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ROAD_LEDGER_OUTPUT_ID_PREFIX,
  defaultRoadLedgerOutputId,
  pickUpDefaultRoadOutputs,
  type DefaultRoadPickupDeps,
} from "../default-road-pickup";
import { DOCUMENT_FLOOR_BYTES } from "../output-detection-ladder";

// ---------------------------------------------------------------------------
// cinatra#3029 acceptance items 1-4 — THE DEFAULT ROAD.
//
// "the pickup runs once per emitted file and once per end-node output at or
//  above the document floor, applies the per-output ladder of section 3 —
//  binding, then the agent's declared kind, then the form's base, then the
//  binary base — writes through the one path with one ledger row per item under
//  a reserved id that cannot collide with a node id, dedupes identical bytes
//  within the run, emits the produced event and enqueues the meaning match"
//  (item 0.17)
//
// THIS SLICE STOPS SHORT OF FILES (item 0.22 is W6, #3030): end-node outputs only.
// ---------------------------------------------------------------------------

const above = (seed: string) => seed.repeat(Math.ceil((DOCUMENT_FLOOR_BYTES + 64) / seed.length));

const MARKDOWN = above("# A heading\n\n- a point\n- another point\n\nSee [the note](https://example.test).\n\n");
const STRUCTURED = { rows: Array.from({ length: 200 }, (_, i) => ({ i, name: `row-${i}` })) };

function deps(over?: Partial<DefaultRoadPickupDeps>): DefaultRoadPickupDeps {
  return {
    resolveTarget: async ({ mime }) => {
      const table: Record<string, string> = {
        "text/markdown": "@cinatra-ai/markdown-artifact",
        "application/json": "@cinatra-ai/json-artifact",
        "text/plain": "@cinatra-ai/text-artifact",
        "application/octet-stream": "@cinatra-ai/binary-artifact",
      };
      const extension = table[mime];
      if (!extension) return null;
      return {
        extension,
        objectTypeId: `${extension}:object`,
        acceptedFileMimeTypes: [mime],
      };
    },
    write: vi.fn(async (input) => ({
      ok: true as const,
      artifactId: `artifact-for-${input.outputId}`,
      representationRevisionId: `revision-for-${input.outputId}`,
      deduped: false,
    })),
    resolveOwnership: async () => ({
      ownerLevel: "organization" as const,
      ownerId: "org-1",
      projectId: null,
      visibility: "organization" as const,
    }),
    readRunTitleParts: async () => ({ agentName: "The fixture agent" }),
    ladder: {
      modelRungEnabled: () => false,
      askModel: async () => {
        throw new Error("the pickup called a model");
      },
    },
    ...over,
  };
}

const base = {
  runId: "run-1",
  orgId: "org-1",
  templateId: "tpl-1",
  packageVersion: "1.0.0",
  createdBy: "user-1",
  boundOutputIds: [] as string[],
  declaredKindExtension: null as string | null,
};

describe("the default road — the pickup over end-node outputs", () => {
  it("acceptance item 1: an undeclared end-node output above the floor becomes an artifact of the right base, with the deciding rung on its ledger row", async () => {
    const d = deps();
    const outcomes = await pickUpDefaultRoadOutputs(
      { ...base, endNodeOutputs: { report: MARKDOWN, cohort: STRUCTURED } },
      d,
    );
    expect(outcomes).toHaveLength(2);

    const report = outcomes.find((o) => o.outputId === "report")!;
    expect(report.ok).toBe(true);
    expect(report.mime).toBe("text/markdown");
    expect(report.extension).toBe("@cinatra-ai/markdown-artifact");
    expect(report.rung).toBe("structure");
    expect(report.artifactId).toBe("artifact-for-cinatra:end-node-output:report");

    const cohort = outcomes.find((o) => o.outputId === "cohort")!;
    expect(cohort.ok).toBe(true);
    expect(cohort.mime).toBe("application/json");
    expect(cohort.extension).toBe("@cinatra-ai/json-artifact");
    expect(cohort.rung).toBe("structure");

    // ONE ledger row per item, under a reserved id that cannot collide with a
    // node id, on the ONE write path, carrying the deciding rung.
    const write = d.write as ReturnType<typeof vi.fn>;
    expect(write).toHaveBeenCalledTimes(2);
    for (const [call] of write.mock.calls) {
      expect(call.outputId.startsWith(DEFAULT_ROAD_LEDGER_OUTPUT_ID_PREFIX)).toBe(true);
      expect(call.outputId).toContain(":");
      expect(call.path).toBe("default_road");
      expect(call.detection.rung).toMatch(/^(explicit|signature|structure|name|model|base)$/);
      expect(call.detection.reason.length).toBeGreaterThan(0);
    }
  });

  it("the reserved ledger id cannot collide with a node id or an end-node output name", () => {
    const id = defaultRoadLedgerOutputId("report");
    expect(id).toBe("cinatra:end-node-output:report");
    // An OAS node id / EndNode output name is a bare identifier — it can never
    // carry the reserved prefix's colon.
    expect(id).not.toBe("report");
    expect(id).toContain(":");
  });

  it("acceptance item 2: a datum below the floor takes no road", async () => {
    const d = deps();
    const outcomes = await pickUpDefaultRoadOutputs(
      { ...base, endNodeOutputs: { tally: 7, note: "short" } },
      d,
    );
    expect(outcomes.every((o) => o.skipped === "below_floor")).toBe(true);
    expect(outcomes.every((o) => o.ok === false)).toBe(true);
    expect(d.write).not.toHaveBeenCalled();
  });

  it("acceptance item 3: response text takes no road — only end-node outputs are read", async () => {
    const d = deps();
    const outcomes = await pickUpDefaultRoadOutputs(
      { ...base, endNodeOutputs: null },
      d,
    );
    expect(outcomes).toEqual([]);
    expect(d.write).not.toHaveBeenCalled();
  });

  it("acceptance item 4: undetectable bytes land under the binary base", async () => {
    const d = deps();
    // The one shape that carries BYTES through a JSON end-node output today: a
    // data URI. No media type on it, no signature in the bytes, no structure,
    // no name — every rung refuses, so the binary base takes it.
    const opaque = Buffer.alloc(DOCUMENT_FLOOR_BYTES + 32);
    for (let i = 0; i < opaque.length; i += 1) opaque[i] = i % 256;
    const outcomes = await pickUpDefaultRoadOutputs(
      { ...base, endNodeOutputs: { blob: `data:;base64,${opaque.toString("base64")}` } },
      d,
    );
    const blob = outcomes.find((o) => o.outputId === "blob")!;
    expect(blob.ok).toBe(true);
    expect(blob.mime).toBe("application/octet-stream");
    expect(blob.extension).toBe("@cinatra-ai/binary-artifact");
    expect(blob.rung).toBe("base");
  });


  it("a data URI that names its own media type takes the explicit rung", async () => {
    const d = deps();
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(DOCUMENT_FLOOR_BYTES),
    ]);
    const resolveTarget = async () => ({
      extension: "@cinatra-ai/image-artifact",
      objectTypeId: "@cinatra-ai/image-artifact:object",
      acceptedFileMimeTypes: ["image/png"],
    });
    const outcomes = await pickUpDefaultRoadOutputs(
      { ...base, endNodeOutputs: { shot: `data:image/png;base64,${png.toString("base64")}` } },
      deps({ resolveTarget, write: d.write }),
    );
    expect(outcomes[0].mime).toBe("image/png");
    expect(outcomes[0].rung).toBe("explicit");
    expect(outcomes[0].extension).toBe("@cinatra-ai/image-artifact");
  });

  it("an output a binding names takes the binding rung, not the default road", async () => {
    const d = deps();
    const outcomes = await pickUpDefaultRoadOutputs(
      { ...base, boundOutputIds: ["report"], endNodeOutputs: { report: MARKDOWN } },
      d,
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].skipped).toBe("bound");
    expect(d.write).not.toHaveBeenCalled();
  });

  it("the agent's declared kind wins when it accepts the form; the form's base wins when it does not", async () => {
    const resolveTarget = vi.fn(async ({ mime, declaredKindExtension }) => {
      if (declaredKindExtension === "@vendor/post-artifact" && mime === "text/markdown") {
        return {
          extension: "@vendor/post-artifact",
          objectTypeId: "@vendor/post-artifact:body",
          acceptedFileMimeTypes: ["text/markdown"],
        };
      }
      if (declaredKindExtension) return null;
      return {
        extension: "@cinatra-ai/markdown-artifact",
        objectTypeId: "@cinatra-ai/markdown-artifact:object",
        acceptedFileMimeTypes: ["text/markdown"],
      };
    });
    const accepting = await pickUpDefaultRoadOutputs(
      {
        ...base,
        declaredKindExtension: "@vendor/post-artifact",
        endNodeOutputs: { report: MARKDOWN },
      },
      deps({ resolveTarget }),
    );
    expect(accepting[0].extension).toBe("@vendor/post-artifact");

    const refusing = await pickUpDefaultRoadOutputs(
      {
        ...base,
        declaredKindExtension: "@vendor/spreadsheet-artifact",
        endNodeOutputs: { report: MARKDOWN },
      },
      deps({ resolveTarget }),
    );
    expect(refusing[0].extension).toBe("@cinatra-ai/markdown-artifact");
  });

  it("dedupes identical bytes within the run — one road per distinct output", async () => {
    const d = deps();
    const outcomes = await pickUpDefaultRoadOutputs(
      { ...base, endNodeOutputs: { first: MARKDOWN, second: MARKDOWN } },
      d,
    );
    expect(outcomes).toHaveLength(2);
    expect(outcomes.filter((o) => o.ok).length).toBe(1);
    const duplicate = outcomes.find((o) => o.skipped === "duplicate_bytes")!;
    expect(duplicate).toBeDefined();
    expect(d.write).toHaveBeenCalledTimes(1);
  });

  it("never throws: a refused write is a visible per-output outcome, not a run failure", async () => {
    const d = deps({
      write: vi.fn(async () => ({ ok: false as const, error: "the writer refused" })),
    });
    const outcomes = await pickUpDefaultRoadOutputs(
      { ...base, endNodeOutputs: { report: MARKDOWN } },
      d,
    );
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].error).toContain("the writer refused");
  });

  it("never throws: a throwing write path is a visible per-output outcome", async () => {
    const d = deps({
      write: vi.fn(async () => {
        throw new Error("the store is unreachable");
      }),
    });
    const outcomes = await pickUpDefaultRoadOutputs(
      { ...base, endNodeOutputs: { report: MARKDOWN } },
      d,
    );
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].error).toContain("the store is unreachable");
  });
});
