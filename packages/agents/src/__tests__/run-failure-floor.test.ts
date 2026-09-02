/**
 * The drawn floor for a failed run's declared artifact output.
 *
 * The ratified run-surface drawing fixes ONE reading for a target that did not
 * resolve: "a sanitized, telemetry-safe one-line diagnostic (package - slot -
 * reason, never a raw error or manifest value)". The drawn sentence is
 *
 *   review target unavailable [em dash] package "@acme/support", slot "detail",
 *   reason "requires-rebuild"
 *
 * so the reason is a STABLE TOKEN, never the producer's own error text. This
 * suite locks the composer, the parser and - the point of the whole change -
 * that no raw error string can reach the composed line.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run src/__tests__/run-failure-floor.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  composeRunFailureFloorMessage,
  formatRunFailureFloorLine,
  runFailureFloorForDisplay,
  runFailureFloorFromOutcomes,
} from "../run-failure-floor";

const DASH = "—";
const LQ = "“";
const RQ = "”";

describe("formatRunFailureFloorLine", () => {
  it("draws the drawing's sentence, character for character", () => {
    expect(
      formatRunFailureFloorLine({
        package: "@acme/support",
        slot: "detail",
        reason: "requires-rebuild",
      }),
    ).toBe(
      `review target unavailable ${DASH} package ${LQ}@acme/support${RQ}, ` +
        `slot ${LQ}detail${RQ}, reason ${LQ}requires-rebuild${RQ}`,
    );
  });
});

describe("runFailureFloorFromOutcomes", () => {
  it("reduces a failed declared output to package, slot, and a stable reason token", () => {
    expect(
      runFailureFloorFromOutcomes([
        {
          ok: false,
          outputId: "ideaBatch",
          extension: "@cinatra-ai/blog-idea-generator-agent",
          error: 'contentFrom output "ideaBatchDocument" did not resolve to a string',
        },
      ]),
    ).toEqual([
      {
        package: "@cinatra-ai/blog-idea-generator-agent",
        slot: "ideaBatch",
        reason: "output-not-produced",
      },
    ]);
  });

  it("classifies the three synthetic outcomes by their own positive markers", () => {
    const entries = runFailureFloorFromOutcomes([
      {
        ok: false,
        outputId: "(binding-resolution)",
        extension: null,
        error: "ECONNREFUSED",
        bindingResolution: "unavailable",
      },
      {
        ok: false,
        outputId: "(binding-validation)",
        extension: null,
        error: "binding has no extension",
      },
      {
        ok: false,
        outputId: "(materializer)",
        extension: null,
        error: "boom in the materializer",
      },
    ]);
    expect(entries.map((e) => e.reason)).toEqual([
      "binding-resolution-failed",
      "binding-invalid",
      "materializer-failed",
    ]);
    // A missing package is named as unknown, never left blank and never
    // back-filled from the raw error.
    expect(entries.every((e) => e.package === "unknown")).toBe(true);
  });

  it("never lets a producer's error text into any field of the triple", () => {
    const raw = 'contentFrom output "content" did not resolve to a string';
    const [entry] = runFailureFloorFromOutcomes([
      { ok: false, outputId: "draft", extension: "@acme/writer", error: raw },
    ]);
    expect(JSON.stringify(entry)).not.toContain("did not resolve");
  });

  it("bounds an over-long but well-formed token instead of drawing a wall of text", () => {
    const [entry] = runFailureFloorFromOutcomes([
      { ok: false, outputId: "ideaBatch", extension: `@acme/${"x".repeat(200)}`, error: "whatever" },
    ]);
    expect(entry.slot).toBe("ideaBatch");
    expect(entry.package.length).toBeLessThanOrEqual(64);
    expect(entry.package).not.toContain(LQ);
  });

  // A token is an IDENTIFIER by construction. Anything that is not one is not a
  // token at all - it is somebody's prose in a field that should have held an
  // id - so it reduces to `unknown` rather than being drawn. Without this the
  // module's promise ("never raw text in any field") holds only for well-formed
  // input, while its own public type accepts `unknown` on every field.
  it("reduces a field carrying prose or a quote to `unknown`, never drawing it", () => {
    const [entry] = runFailureFloorFromOutcomes([
      {
        ok: false,
        outputId: `sl${LQ}ot with\nnewlines`,
        extension: "producer failed because the token sk-not-a-package was refused",
        error: "whatever",
      },
    ]);
    expect(entry.slot).toBe("unknown");
    expect(entry.package).toBe("unknown");
    expect(JSON.stringify(entry)).not.toContain("sk-not-a-package");
    expect(JSON.stringify(entry)).not.toContain("newlines");
  });
});

describe("composeRunFailureFloorMessage", () => {
  it("composes one floor line per failed output and nothing else", () => {
    const message = composeRunFailureFloorMessage([
      {
        ok: false,
        outputId: "ideaBatch",
        extension: "@cinatra-ai/blog-idea-generator-agent",
        error: "raw one",
      },
      {
        ok: false,
        outputId: "summary",
        extension: "@cinatra-ai/blog-idea-generator-agent",
        error: "raw two",
      },
    ]);
    expect(message.split("\n")).toHaveLength(2);
    expect(message).toContain(`slot ${LQ}ideaBatch${RQ}`);
    expect(message).toContain(`slot ${LQ}summary${RQ}`);
    expect(message).not.toContain("raw one");
    expect(message).not.toContain("raw two");
  });

  it("stays bounded however many outputs failed", () => {
    const many = Array.from({ length: 400 }, (_, i) => ({
      ok: false as const,
      outputId: `slot-${i}`,
      extension: "@acme/pack",
      error: "x".repeat(500),
    }));
    expect(composeRunFailureFloorMessage(many).length).toBeLessThanOrEqual(2000);
  });
});

describe("runFailureFloorForDisplay", () => {
  it("reads back a message this composer wrote", () => {
    const message = composeRunFailureFloorMessage([
      {
        ok: false,
        outputId: "ideaBatch",
        extension: "@cinatra-ai/blog-idea-generator-agent",
        error: "raw",
      },
    ]);
    expect(runFailureFloorForDisplay(message)).toEqual([
      {
        package: "@cinatra-ai/blog-idea-generator-agent",
        slot: "ideaBatch",
        reason: "output-not-produced",
      },
    ]);
  });

  it("reduces a run row still carrying the OLD raw sentence to the same floor", () => {
    // Rows written before this change (and the exact sentence a failed idea
    // run persisted) must not draw their raw text either.
    const legacy =
      `artifact materialization failed ${DASH} the run declared artifact output(s) it did not produce ` +
      "(1 of 1 failed): ideaBatch [@cinatra-ai/blog-idea-generator-agent]: " +
      'contentFrom output "ideaBatchDocument" did not resolve to a string';
    const entries = runFailureFloorForDisplay(legacy);
    expect(entries).toEqual([
      {
        package: "@cinatra-ai/blog-idea-generator-agent",
        slot: "ideaBatch",
        reason: "output-not-produced",
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain("did not resolve");
  });

  it("still answers a floor for a raw sentence it cannot take apart", () => {
    const mangled = `artifact materialization failed ${DASH} something entirely unparsed`;
    const entries = runFailureFloorForDisplay(mangled);
    expect(entries).toEqual([
      { package: "unknown", slot: "unknown", reason: "output-not-produced" },
    ]);
    expect(JSON.stringify(entries)).not.toContain("entirely unparsed");
  });

  it("returns null for a failure that is not a materialization failure", () => {
    expect(runFailureFloorForDisplay("WayFlow task failed")).toBeNull();
    expect(
      runFailureFloorForDisplay("401 Incorrect API key provided: sk-proj-****."),
    ).toBeNull();
  });
});

describe("the floor never draws a producer's text as a token", () => {
  // The old sentence used "; " to separate OUTCOMES, but the raw reason it
  // embedded is unrestricted and may contain "; " itself. Splitting naively
  // turned the tail of somebody's error sentence into a second "outcome" whose
  // slot was that sentence - the exact leak the floor exists to prevent, on the
  // road that reduces a row written before the change.
  it("does not turn a semicolon inside a legacy raw reason into a drawn slot", () => {
    const legacy =
      "artifact materialization failed — the run declared artifact output(s) it did not " +
      "produce (1 of 1 failed): draft [@acme/writer]: write refused; " +
      "authorization token sk-not-a-slot was rejected";

    const entries = runFailureFloorForDisplay(legacy);
    expect(entries).not.toBeNull();
    const drawn = (entries ?? []).map(formatRunFailureFloorLine).join("\n");
    expect(drawn).not.toContain("sk-not-a-slot");
    expect(drawn).not.toContain("authorization");
    expect(drawn).not.toContain("write refused");
    expect(entries).toEqual([
      { package: "@acme/writer", slot: "draft", reason: "output-not-produced" },
    ]);
  });

  // Read-back is a trust boundary too: a row that merely RESEMBLES a floor line
  // must not have the text it carries drawn as a token. The honest answer is "not
  // a floor", which leaves that failure the reading its class already had.
  it("refuses to read a floor-shaped row whose quoted fields are not tokens", () => {
    const lookalike =
      `review target unavailable — package ${LQ}the provider said no such key exists${RQ}, ` +
      `slot ${LQ}detail${RQ}, reason ${LQ}output-not-produced${RQ}`;
    expect(runFailureFloorForDisplay(lookalike)).toBeNull();
  });
});
