import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  artifactOutputBindingSchema,
  collectArtifactBindingsFromOasDocument,
} from "../artifact-binding";

// ---------------------------------------------------------------------------
// Fan-out artifact-output binding grammar (cinatra#3034, plan item 0.27).
//
// A fan-out binding names an ARRAY output whose members are plain strings and
// materializes ONE artifact per member, its title read from the member's own
// first line behind a declared prefix. It carries no run-level `titleFrom`:
// there is no single title for a set, and a title is never invented.
// ---------------------------------------------------------------------------

const FAN_OUT = {
  extension: "@cinatra-ai/blog-idea-artifact",
  contentFrom: "ideas",
  declaredMime: "text/plain",
  fanOut: { mode: "member", titleFrom: "first-line", titlePrefix: "Title:" },
} as const;

function ideasEndNodeDoc(
  outputs: unknown[],
): Record<string, unknown> {
  return {
    component_type: "Flow",
    $referenced_components: {
      end: { component_type: "EndNode", id: "end", name: "End", outputs },
    },
  };
}

const PLAIN_STRING_IDEAS_OUTPUT = {
  title: "ideas",
  type: "array",
  json_schema: { items: { type: "string" } },
  default: [],
  cinatra: { artifact: FAN_OUT },
};

describe("artifactOutputBindingSchema — fan-out", () => {
  it("accepts a fan-out binding with no run-level titleFrom", () => {
    const parsed = artifactOutputBindingSchema.safeParse(FAN_OUT);
    expect(parsed.success).toBe(true);
  });

  it("rejects a fan-out binding that ALSO carries titleFrom (XOR)", () => {
    const parsed = artifactOutputBindingSchema.safeParse({
      ...FAN_OUT,
      titleFrom: "ideaBatchTitle",
    });
    expect(parsed.success).toBe(false);
  });

  it("still requires titleFrom on a scalar (non-fan-out) binding", () => {
    const parsed = artifactOutputBindingSchema.safeParse({
      extension: "@cinatra-ai/blog-post-artifact",
      contentFrom: "content",
      declaredMime: "text/markdown",
    });
    expect(parsed.success).toBe(false);
  });

  it("requires a non-empty titlePrefix — the first line is read behind a declared marker", () => {
    const parsed = artifactOutputBindingSchema.safeParse({
      ...FAN_OUT,
      fanOut: { mode: "member", titleFrom: "first-line", titlePrefix: "" },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown fan-out title source (strict)", () => {
    const parsed = artifactOutputBindingSchema.safeParse({
      ...FAN_OUT,
      fanOut: { mode: "member", titleFrom: "whole-member", titlePrefix: "Title:" },
    });
    expect(parsed.success).toBe(false);
  });
});

describe("collectArtifactBindingsFromOasDocument — fan-out member shape", () => {
  it("collects a fan-out binding over an array output whose members are declared plain strings", () => {
    const result = collectArtifactBindingsFromOasDocument(
      ideasEndNodeDoc([PLAIN_STRING_IDEAS_OUTPUT]),
      { produces: ["@cinatra-ai/blog-idea-artifact"] },
    );
    expect(result.errors).toEqual([]);
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]!.outputId).toBe("ideas");
    expect(result.bindings[0]!.binding.fanOut).toEqual({
      mode: "member",
      titleFrom: "first-line",
      titlePrefix: "Title:",
    });
  });

  it("refuses a bound output whose OWN name reads as a fanned-out member identity", () => {
    const result = collectArtifactBindingsFromOasDocument(
      ideasEndNodeDoc([
        PLAIN_STRING_IDEAS_OUTPUT,
        { title: "ideaTitle", type: "string" },
        {
          title: "ideas[0]",
          type: "string",
          cinatra: {
            artifact: {
              extension: "@cinatra-ai/blog-idea-artifact",
              contentFrom: "ideas[0]",
              titleFrom: "ideaTitle",
              declaredMime: "text/plain",
            },
          },
        },
      ]),
      { produces: ["@cinatra-ai/blog-idea-artifact"] },
    );
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]!.outputId).toBe("ideas");
    expect(result.errors.join("\n")).toContain("[index] is reserved");
  });

  it("errors when the fan-out output is not an array", () => {
    const result = collectArtifactBindingsFromOasDocument(
      ideasEndNodeDoc([
        { title: "ideas", type: "string", cinatra: { artifact: FAN_OUT } },
      ]),
      { produces: ["@cinatra-ai/blog-idea-artifact"] },
    );
    expect(result.bindings).toEqual([]);
    expect(result.errors.join("\n")).toContain("array");
  });

  it("errors when the bound list leaves its member level UNDECLARED", () => {
    const result = collectArtifactBindingsFromOasDocument(
      ideasEndNodeDoc([
        { title: "ideas", type: "array", cinatra: { artifact: FAN_OUT } },
      ]),
      { produces: ["@cinatra-ai/blog-idea-artifact"] },
    );
    expect(result.bindings).toEqual([]);
    expect(result.errors.join("\n")).toContain("member");
  });

  it("errors when the declared members are objects rather than plain strings", () => {
    const result = collectArtifactBindingsFromOasDocument(
      ideasEndNodeDoc([
        {
          title: "ideas",
          type: "array",
          json_schema: {
            items: { type: "object", properties: { title: { type: "string" } } },
          },
          cinatra: { artifact: FAN_OUT },
        },
      ]),
      { produces: ["@cinatra-ai/blog-idea-artifact"] },
    );
    expect(result.bindings).toEqual([]);
    expect(result.errors.join("\n")).toContain("plain string");
  });

  it("errors when contentFrom names a DIFFERENT output than the annotated one", () => {
    const result = collectArtifactBindingsFromOasDocument(
      ideasEndNodeDoc([
        { title: "notes", type: "string" },
        {
          title: "ideas",
          type: "array",
          json_schema: { items: { type: "string" } },
          cinatra: { artifact: { ...FAN_OUT, contentFrom: "notes" } },
        },
      ]),
      { produces: ["@cinatra-ai/blog-idea-artifact"] },
    );
    expect(result.bindings).toEqual([]);
    expect(result.errors.join("\n")).toContain("contentFrom");
  });
});

// ---------------------------------------------------------------------------
// The SHIPPED declaration, read off the pinned tree — the loop the fourth proof
// round broke. At that head the pack bound one markdown batch document through
// `titleFrom: "ideaBatchTitle"`, the model's real answer carried neither key,
// and materialization refused with `titleFrom output "ideaBatchTitle" did not
// resolve to a non-empty string`. Here the collector reads the pack as it now
// ships, and a real-shaped answer resolves what the binding names.
// ---------------------------------------------------------------------------

const PINNED_IDEA_PACK = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "extensions",
  "cinatra-ai",
  "blog-idea-generator-agent",
);

describe("the shipped blog-idea-generator declaration", () => {
  const oas = JSON.parse(
    readFileSync(join(PINNED_IDEA_PACK, "cinatra", "oas.json"), "utf8"),
  ) as Record<string, unknown>;
  const manifest = JSON.parse(
    readFileSync(join(PINNED_IDEA_PACK, "package.json"), "utf8"),
  ) as { cinatra: { produces: Array<{ extension: string; objectTypeId?: string }> } };

  const collected = collectArtifactBindingsFromOasDocument(oas, {
    producesRefs: manifest.cinatra.produces,
  });

  it("collects, with no error, exactly one fan-out binding over the ideas", () => {
    expect(collected.errors).toEqual([]);
    expect(collected.bindings).toHaveLength(1);
    const only = collected.bindings[0]!;
    expect(only.outputId).toBe("ideas");
    expect(only.binding.contentFrom).toBe("ideas");
    expect(only.binding.declaredMime).toBe("text/plain");
    expect(only.binding.titleFrom).toBeUndefined();
    expect(only.binding.fanOut?.titlePrefix).toBe("Title:");
  });

  it("names outputs a real answer carries — the fourth round's two are gone", () => {
    // A real-shaped answer for this pack, in the shape its own prompt asks for.
    const answer: Record<string, unknown> = {
      ideas: [
        "Title: Five onboarding patterns that work\n\nWhy the first session decides.\n\nOutline:\nThe first five minutes\nPre-fill the first useful state\nMeasure activation",
        "Title: The hidden cost of a free tier\n\nThree questions before the green light.\n\nOutline:\nWhy it gets green-lit\nMarginal cost per free user\nWho absorbs the support",
      ],
      notes: "two clusters",
    };
    const binding = collected.bindings[0]!.binding;
    // Every output the binding names is present and usable in that answer.
    const members = answer[binding.contentFrom];
    expect(Array.isArray(members)).toBe(true);
    expect((members as unknown[]).every((m) => typeof m === "string")).toBe(true);
    for (const member of members as string[]) {
      const firstLine = member.split("\n", 1)[0]!;
      expect(firstLine.startsWith(binding.fanOut!.titlePrefix)).toBe(true);
      expect(firstLine.slice(binding.fanOut!.titlePrefix.length).trim().length).toBeGreaterThan(0);
    }
    // And the retired batch keys are named nowhere in the shipped flow.
    expect(JSON.stringify(oas)).not.toContain("ideaBatchTitle");
    expect(JSON.stringify(oas)).not.toContain("ideaBatchDocument");
  });
});
