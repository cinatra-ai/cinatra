/**
 * Lifecycle D W6 — the adoption gate flips to blocking (plan (D) ratchet R3).
 *
 * The adoption gate is the publish-time produces-materialization contract
 * (Layer 2): a `cinatra.produces` entry that no materialization road resolves
 * "names nothing", and the gate counts it. Until this slice the gate only
 * WARNED, so a declaration that resolves nothing still published.
 *
 * This file pins the flipped state on three axes:
 *   1. the switch is "block", and the unmaterialized finding is a BLOCKER;
 *   2. an agent in the required set whose declared kind reaches no
 *      materialization road FAILS the gate — the red-first fixture;
 *   3. the fleet AS PINNED passes — every agent extension in the synced
 *      pinned tree is evaluated on the real manifests and real service
 *      descriptions, never on a stub.
 *
 * The third materialization road — the authoring emit — is named by the plan
 * beside the terminal binding and the mid-run materialize step; a publisher
 * that mints an edited revision through it has a resolving declaration and no
 * binding, so the gate must read it or the pinned fleet reddens on a package
 * that is correct.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, it, expect } from "vitest";

import {
  ARTIFACT_PRODUCES_ENFORCEMENT,
  evaluateProducesMaterializationContract,
} from "../verdaccio/package-contract";

const ARTIFACT = "@cinatra-ai/blog-post-artifact";

function boundOas(extension = ARTIFACT): Record<string, unknown> {
  return {
    $referenced_components: {
      end: {
        component_type: "EndNode",
        id: "end",
        outputs: [
          { title: "draft", type: "string" },
          { title: "title", type: "string" },
          {
            title: "artifact",
            type: "string",
            cinatra: {
              artifact: {
                extension,
                contentFrom: "draft",
                declaredMime: "text/markdown",
                titleFrom: "title",
              },
            },
          },
        ],
      },
    },
  };
}

/** A produces-declaring agent whose end node binds nothing. */
function unboundOas(): Record<string, unknown> {
  return {
    $referenced_components: {
      end: {
        component_type: "EndNode",
        id: "end",
        outputs: [{ title: "draft", type: "string" }],
      },
    },
  };
}

describe("lifecycle D W6 — ratchet R3, the adoption gate blocks", () => {
  it("the enforcement phase is block", () => {
    expect(ARTIFACT_PRODUCES_ENFORCEMENT).toBe("block");
  });

  it("an agent in the required set whose declared kind reaches nothing FAILS", () => {
    const findings = evaluateProducesMaterializationContract({
      produces: [ARTIFACT],
      oasDoc: unboundOas(),
    });
    expect(findings.map((f) => f.code)).toContain(
      "ARTIFACT-CONTRACT-PRODUCES-UNMATERIALIZED",
    );
    expect(findings.some((f) => f.severity === "blocker")).toBe(true);
  });

  it("a declared kind a terminal binding resolves PASSES", () => {
    expect(
      evaluateProducesMaterializationContract({
        produces: [ARTIFACT],
        oasDoc: boundOas(),
      }),
    ).toHaveLength(0);
  });

  it("a declared kind the authoring emit resolves PASSES", () => {
    expect(
      evaluateProducesMaterializationContract({
        produces: [ARTIFACT],
        oasDoc: unboundOas(),
        consumes: [{ primitive: "artifact_authoring_emit", requirement: "required" }],
      }),
    ).toHaveLength(0);
  });

  it("an OPTIONAL authoring-emit claim resolves nothing", () => {
    const findings = evaluateProducesMaterializationContract({
      produces: [ARTIFACT],
      oasDoc: unboundOas(),
      consumes: [{ primitive: "artifact_authoring_emit", requirement: "optional" }],
    });
    expect(findings.some((f) => f.severity === "blocker")).toBe(true);
  });

  // Convergence finding 1 — the emit road must not become a multi-entry escape
  // hatch. The claim names a capability, not a target: on a two-entry
  // declaration it cannot say WHICH entry it reaches, so it resolves neither.
  it("a required authoring-emit claim resolves NOTHING for a multi-entry declaration", () => {
    const findings = evaluateProducesMaterializationContract({
      produces: [ARTIFACT, "@cinatra-ai/blog-idea-artifact"],
      oasDoc: unboundOas(),
      consumes: [{ primitive: "artifact_authoring_emit", requirement: "required" }],
    });
    expect(
      findings.filter((f) => f.code === "ARTIFACT-CONTRACT-PRODUCES-UNMATERIALIZED"),
    ).toHaveLength(2);
    expect(findings.every((f) => f.severity === "blocker")).toBe(true);
  });

  // …and a multi-entry declaration whose entries each carry their own road
  // still passes: the restriction narrows the emit road, it does not punish
  // declaring more than one kind.
  it("a multi-entry declaration with a per-entry binding still passes", () => {
    const oas = boundOas() as {
      $referenced_components: { end: { outputs: Array<Record<string, unknown>> } };
    };
    oas.$referenced_components.end.outputs.push({
      title: "idea",
      type: "string",
      cinatra: {
        artifact: {
          extension: "@cinatra-ai/blog-idea-artifact",
          contentFrom: "draft",
          declaredMime: "text/markdown",
          titleFrom: "title",
        },
      },
    });
    expect(
      evaluateProducesMaterializationContract({
        produces: [ARTIFACT, "@cinatra-ai/blog-idea-artifact"],
        oasDoc: oas as unknown as Record<string, unknown>,
      }),
    ).toHaveLength(0);
  });

  it("an agent that declares nothing states nothing and passes", () => {
    expect(
      evaluateProducesMaterializationContract({ produces: [], oasDoc: unboundOas() }),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The fleet AS PINNED — the real surface.
// ---------------------------------------------------------------------------

const extensionsRoot = path.resolve(__dirname, "../../../../extensions/cinatra-ai");

type PinnedAgent = {
  packageName: string;
  produces: string[];
  consumes: Array<{ primitive: string; requirement: string }>;
  oasDoc: Record<string, unknown>;
};

function readPinnedProducers(): PinnedAgent[] {
  const out: PinnedAgent[] = [];
  if (!fs.existsSync(extensionsRoot)) return out;
  for (const slug of fs.readdirSync(extensionsRoot).sort()) {
    const pkgPath = path.join(extensionsRoot, slug, "package.json");
    const oasPath = path.join(extensionsRoot, slug, "cinatra", "oas.json");
    if (!fs.existsSync(pkgPath) || !fs.existsSync(oasPath)) continue;
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const cinatra = (pkg.cinatra ?? {}) as Record<string, unknown>;
    const produces = Array.isArray(cinatra.produces)
      ? (cinatra.produces as Array<{ extension?: unknown }>)
          .map((e) => e?.extension)
          .filter((e): e is string => typeof e === "string")
      : [];
    if (produces.length === 0) continue;
    const consumes = Array.isArray(cinatra.consumes)
      ? (cinatra.consumes as Array<{ primitive?: unknown; requirement?: unknown }>)
          .filter(
            (c): c is { primitive: string; requirement: string } =>
              typeof c?.primitive === "string" && typeof c?.requirement === "string",
          )
      : [];
    out.push({
      packageName: String(pkg.name ?? slug),
      produces,
      consumes,
      oasDoc: JSON.parse(fs.readFileSync(oasPath, "utf8")) as Record<string, unknown>,
    });
  }
  return out;
}

describe("lifecycle D W6 — the fleet as pinned passes the blocking gate", () => {
  const producers = readPinnedProducers();

  // Convergence finding 4 — a producing package that LOSES its declaration, or
  // a tree that was never synced, would silently drop out of the read and leave
  // the assertion below true over an empty set. The known pinned producers are
  // named, so a hollowed read fails instead of passing.
  const EXPECTED_PINNED_PRODUCERS = [
    "@cinatra-ai/blog-draft-writer-agent",
    "@cinatra-ai/blog-idea-generator-agent",
    "@cinatra-ai/blog-pipeline-agent",
    "@cinatra-ai/email-drafting-agent",
    "@cinatra-ai/email-follow-up-agent",
    "@cinatra-ai/media-transcript-agent",
  ];

  it("the pinned tree is materialized (run the dev-extension sync before this suite)", () => {
    expect(fs.existsSync(extensionsRoot)).toBe(true);
    expect(producers.length).toBeGreaterThan(0);
  });

  it("every known pinned producer is actually read (the read is not hollow)", () => {
    const read = new Set(producers.map((p) => p.packageName));
    expect(EXPECTED_PINNED_PRODUCERS.filter((n) => !read.has(n))).toEqual([]);
  });

  // The publish agent is a KNOWN NON-producer, and its name is absent from the
  // list above for that reason alone: its flow writes the published address back
  // onto the artifact it was handed and persists no revision, so its pinned head
  // declares an EXPLICITLY EMPTY produces set in both its manifest and its flow
  // document. Merely dropping a name would let an unsynced tree or a silently
  // deleted declaration look exactly like an honest empty one, so the emptiness
  // is read here directly, in both files, and the hollow-read guard keeps its
  // teeth over the producing set.
  const EXPECTED_EXPLICIT_NON_PRODUCERS = ["@cinatra-ai/blog-linkedin-publish-agent"];

  it("a known non-producer declares its emptiness explicitly, in both files", () => {
    for (const packageName of EXPECTED_EXPLICIT_NON_PRODUCERS) {
      const slug = packageName.replace(/^@cinatra-ai\//, "");
      const pkg = JSON.parse(
        fs.readFileSync(path.join(extensionsRoot, slug, "package.json"), "utf8"),
      ) as { name?: string; cinatra?: { produces?: unknown } };
      const oas = JSON.parse(
        fs.readFileSync(path.join(extensionsRoot, slug, "cinatra", "oas.json"), "utf8"),
      ) as { metadata?: { cinatra?: { produces?: unknown } } };
      expect(pkg.name).toBe(packageName);
      expect(pkg.cinatra?.produces).toEqual([]);
      expect(oas.metadata?.cinatra?.produces).toEqual([]);
    }
  });

  it("no pinned producer carries a declaration the gate refuses", () => {
    const refused = producers
      .map((a) => ({
        packageName: a.packageName,
        findings: evaluateProducesMaterializationContract({
          produces: a.produces,
          oasDoc: a.oasDoc,
          consumes: a.consumes,
        }),
      }))
      .filter((r) => r.findings.length > 0)
      .map((r) => `${r.packageName}: ${r.findings.map((f) => f.code).join(", ")}`);
    expect(refused).toEqual([]);
  });
});
