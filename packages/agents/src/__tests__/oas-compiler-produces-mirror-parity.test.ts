import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  compileOasAgentJson,
  compareAgentProducesMirror,
  __resetRegistryCacheForTests,
} from "../oas-compiler";

// ---------------------------------------------------------------------------
// THE PRODUCES MIRROR CANNOT DISAGREE WITH THE MANIFEST
// (Lifecycle D W7, cinatra#3095 — plan §3.4 wave 7 item 2, §6.2).
//
// THE NEGATIVE FIXTURE: a service description whose `metadata.cinatra.produces`
// says something different from its sibling package.json's `cinatra.produces`
// is REFUSED by the compiler. The mirror stays OPTIONAL — a service description
// that says nothing about production asserts nothing and still compiles — but a
// copy that contradicts the authority does not.
// ---------------------------------------------------------------------------

const PRODUCES_EXT = "@cinatra-ai/email-artifacts";
const PRODUCES_TYPE = "@cinatra-ai/email:body";

function buildOas(mirror: unknown): Record<string, unknown> {
  const cinatra: Record<string, unknown> = { type: "leaf" };
  if (mirror !== undefined) cinatra.produces = mirror;
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "mirror-flow",
    name: "Mirror Flow",
    metadata: { cinatra },
    inputs: [{ title: "topic", type: "string" }],
    outputs: [],
    start_node: { $component_ref: "startNode" },
    nodes: [{ $component_ref: "startNode" }, { $component_ref: "endNode" }],
    control_flow_connections: [
      {
        component_type: "ControlFlowEdge",
        name: "start-to-end",
        from_node: { $component_ref: "startNode" },
        to_node: { $component_ref: "endNode" },
      },
    ],
    $referenced_components: {
      startNode: {
        component_type: "StartNode",
        id: "startNode",
        name: "Start",
        inputs: [{ title: "topic", type: "string" }],
      },
      endNode: {
        component_type: "EndNode",
        id: "endNode",
        name: "End",
        outputs: [{ title: "draft", type: "string" }],
      },
    },
  };
}

let tempDir: string;

beforeEach(() => {
  __resetRegistryCacheForTests();
  tempDir = mkdtempSync(path.join(tmpdir(), "oas-produces-mirror-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** The cinatra/ package layout: <root>/package.json + <root>/cinatra/oas.json. */
function writeFixture(opts: { mirror?: unknown; manifestProduces?: unknown }): string {
  const cinatraDir = path.join(tempDir, "cinatra");
  mkdirSync(cinatraDir, { recursive: true });
  const oasPath = path.join(cinatraDir, "oas.json");
  writeFileSync(oasPath, JSON.stringify(buildOas(opts.mirror), null, 2));
  writeFileSync(
    path.join(tempDir, "package.json"),
    JSON.stringify(
      {
        name: "@test/mirror-agent",
        version: "1.0.0",
        cinatra:
          opts.manifestProduces === undefined ? {} : { produces: opts.manifestProduces },
      },
      null,
      2,
    ),
  );
  return oasPath;
}

async function compile(oasPath: string) {
  return compileOasAgentJson({
    oasSourcePath: oasPath,
    packageName: "@test/mirror-agent",
    packageVersion: "1.0.0",
  } as Parameters<typeof compileOasAgentJson>[0]);
}

describe("the service-description produces mirror (cinatra#3095)", () => {
  it("REFUSES a mirror that names a different extension than the manifest", async () => {
    const oasPath = writeFixture({
      mirror: [{ extension: "@cinatra-ai/text-artifact" }],
      manifestProduces: [{ extension: PRODUCES_EXT, objectTypeId: PRODUCES_TYPE }],
    });
    const res = await compile(oasPath);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("produces-mirror validation failed");
    expect(res.error).toContain("@cinatra-ai/text-artifact");
    expect(res.error).toContain(PRODUCES_TYPE);
  });

  it("REFUSES a mirror that drops the manifest's typed id", async () => {
    const oasPath = writeFixture({
      mirror: [{ extension: PRODUCES_EXT }],
      manifestProduces: [{ extension: PRODUCES_EXT, objectTypeId: PRODUCES_TYPE }],
    });
    const res = await compile(oasPath);
    expect(res.ok).toBe(false);
  });

  it("REFUSES a mirror that claims production the manifest does not declare", async () => {
    const oasPath = writeFixture({
      mirror: [{ extension: PRODUCES_EXT }],
      manifestProduces: undefined,
    });
    const res = await compile(oasPath);
    expect(res.ok).toBe(false);
  });

  it("REFUSES a mirror the compiler cannot read", async () => {
    const oasPath = writeFixture({
      mirror: { extension: PRODUCES_EXT },
      manifestProduces: [{ extension: PRODUCES_EXT }],
    });
    const res = await compile(oasPath);
    expect(res.ok).toBe(false);
  });

  it("ACCEPTS a mirror equal to the manifest, entry for entry", async () => {
    const oasPath = writeFixture({
      mirror: [{ extension: PRODUCES_EXT, objectTypeId: PRODUCES_TYPE }],
      manifestProduces: [{ extension: PRODUCES_EXT, objectTypeId: PRODUCES_TYPE }],
    });
    const res = await compile(oasPath);
    expect(res.ok).toBe(true);
  });

  it("ACCEPTS an ABSENT mirror — the copy is optional, its disagreement is not", async () => {
    const oasPath = writeFixture({
      mirror: undefined,
      manifestProduces: [{ extension: PRODUCES_EXT, objectTypeId: PRODUCES_TYPE }],
    });
    const res = await compile(oasPath);
    expect(res.ok).toBe(true);
  });

  it("REFUSES a faithful mirror when the MANIFEST block is unreadable, naming the manifest", async () => {
    // The manifest carries an entry the tolerant parse must drop, so the
    // manifest's refs collapse to []. A mirror that faithfully copies the
    // readable half must NOT be reported as the disagreeing side.
    const oasPath = writeFixture({
      mirror: [{ extension: PRODUCES_EXT }],
      manifestProduces: [{ extension: PRODUCES_EXT }, { objectTypeId: PRODUCES_TYPE }],
    });
    const res = await compile(oasPath);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("package.json cinatra.produces could not be read whole");
  });

  it("ACCEPTS an empty mirror beside a manifest that declares nothing", async () => {
    const oasPath = writeFixture({ mirror: [], manifestProduces: undefined });
    const res = await compile(oasPath);
    expect(res.ok).toBe(true);
  });
});

describe("compareAgentProducesMirror (the pure rule)", () => {
  it("is order-insensitive", () => {
    const res = compareAgentProducesMirror(
      [{ extension: "@a/b" }, { extension: "@c/d", objectTypeId: "@c/d:x" }],
      [{ extension: "@c/d", objectTypeId: "@c/d:x" }, { extension: "@a/b" }],
    );
    expect(res.ok).toBe(true);
  });

  // ---- convergence round (cinatra#3095): the rule must compare the MANIFEST,
  // not a lossy projection of it, and must never name the wrong side. ----

  it("REFUSES a label collision that is not an actual agreement", () => {
    // `@a/b (c)` and `{extension:"@a/b", objectTypeId:"c"}` format to the SAME
    // human label. Equality is decided on the JSON tuple, so they differ.
    const res = compareAgentProducesMirror(
      [{ extension: "@a/b (c)" }],
      [{ extension: "@a/b", objectTypeId: "c" }],
    );
    expect(res.ok).toBe(false);
  });

  it("names the MANIFEST, not the mirror, when the manifest block is unreadable", () => {
    const res = compareAgentProducesMirror([{ extension: "@a/b" }], [], false);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("package.json cinatra.produces could not be read whole");
    expect(res.error).not.toContain("disagrees with the package manifest");
  });

  it("names both readings when they differ", () => {
    const res = compareAgentProducesMirror([{ extension: "@a/b" }], [{ extension: "@c/d" }]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("metadata.cinatra.produces");
    expect(res.error).toContain("package.json cinatra.produces");
  });
});
