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
// The MEMBER-FIELD fan-out (cinatra#3732): "the fan-out accepts a list of
// objects as members, files each member as one artifact of the declared type
// with the member as its body, and takes the title from a declared field of the
// member (the binding names the field)". A feed lister's episodes are the shape:
// one JSON object per member, each filed unchanged as its own JSON body.
// ---------------------------------------------------------------------------

const EPISODES_FAN_OUT = {
  extension: "@cinatra-ai/podcast-artifacts",
  contentFrom: "episodes",
  declaredMime: "application/json",
  fanOut: { mode: "member", titleFrom: "member-field", titleField: "title" },
} as const;

function episodesOutput(
  items: Record<string, unknown>,
  artifact: Record<string, unknown> = EPISODES_FAN_OUT,
): Record<string, unknown> {
  return {
    title: "episodes",
    type: "array",
    json_schema: { items },
    default: [],
    cinatra: { artifact },
  };
}

const EPISODE_ITEMS = {
  type: "object",
  properties: {
    title: { type: "string" },
    audioUrl: { type: "string" },
    publishedAt: { type: "string" },
  },
};

describe("artifactOutputBindingSchema — member-field fan-out", () => {
  it("accepts a member-field fan-out that names the member field its title comes from", () => {
    const parsed = artifactOutputBindingSchema.safeParse(EPISODES_FAN_OUT);
    expect(parsed.success).toBe(true);
  });

  it("refuses a member-field fan-out with an empty titleField or a first-line prefix beside it (strict)", () => {
    expect(
      artifactOutputBindingSchema.safeParse({
        ...EPISODES_FAN_OUT,
        fanOut: { mode: "member", titleFrom: "member-field", titleField: "" },
      }).success,
    ).toBe(false);
    expect(
      artifactOutputBindingSchema.safeParse({
        ...EPISODES_FAN_OUT,
        fanOut: {
          mode: "member",
          titleFrom: "member-field",
          titleField: "title",
          titlePrefix: "Title:",
        },
      }).success,
    ).toBe(false);
  });
});

describe("collectArtifactBindingsFromOasDocument — member-field fan-out", () => {
  it("collects, with no error, a member-field fan-out over declared object members with a string title field", () => {
    const result = collectArtifactBindingsFromOasDocument(
      ideasEndNodeDoc([episodesOutput(EPISODE_ITEMS)]),
      { produces: ["@cinatra-ai/podcast-artifacts"] },
    );
    expect(result.errors).toEqual([]);
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]!.outputId).toBe("episodes");
    expect(result.bindings[0]!.binding.fanOut).toEqual({
      mode: "member",
      titleFrom: "member-field",
      titleField: "title",
    });
  });

  it("errors when the named title field is not declared among the members' properties", () => {
    const result = collectArtifactBindingsFromOasDocument(
      ideasEndNodeDoc([
        episodesOutput({ type: "object", properties: { audioUrl: { type: "string" } } }),
      ]),
      { produces: ["@cinatra-ai/podcast-artifacts"] },
    );
    expect(result.bindings).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("outputs[episodes]");
    expect(result.errors[0]).toContain('"title" is not a declared property');
  });

  it("errors when the named title field is declared with a non-string type", () => {
    const result = collectArtifactBindingsFromOasDocument(
      ideasEndNodeDoc([
        episodesOutput({ type: "object", properties: { title: { type: "number" } } }),
      ]),
      { produces: ["@cinatra-ai/podcast-artifacts"] },
    );
    expect(result.bindings).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("outputs[episodes]");
    expect(result.errors[0]).toContain('must be declared type "string"');
  });

  it("errors when the members are not declared as objects under the member-field shape", () => {
    const result = collectArtifactBindingsFromOasDocument(
      ideasEndNodeDoc([episodesOutput({ type: "string" })]),
      { produces: ["@cinatra-ai/podcast-artifacts"] },
    );
    expect(result.bindings).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("outputs[episodes]");
    expect(result.errors[0]).toContain("requires declared object members");
  });

  it("errors when the MIME is not the static application/json", () => {
    const declaredText = collectArtifactBindingsFromOasDocument(
      ideasEndNodeDoc([
        episodesOutput(EPISODE_ITEMS, { ...EPISODES_FAN_OUT, declaredMime: "text/plain" }),
      ]),
      { produces: ["@cinatra-ai/podcast-artifacts"] },
    );
    expect(declaredText.bindings).toEqual([]);
    expect(declaredText.errors).toHaveLength(1);
    expect(declaredText.errors[0]).toContain("outputs[episodes]");
    expect(declaredText.errors[0]).toContain('static "application/json"');

    const runtimeMime = collectArtifactBindingsFromOasDocument(
      ideasEndNodeDoc([
        episodesOutput(EPISODE_ITEMS, {
          extension: EPISODES_FAN_OUT.extension,
          contentFrom: EPISODES_FAN_OUT.contentFrom,
          mimeFrom: "episodeMime",
          fanOut: EPISODES_FAN_OUT.fanOut,
        }),
        { title: "episodeMime", type: "string" },
      ]),
      { produces: ["@cinatra-ai/podcast-artifacts"] },
    );
    expect(runtimeMime.bindings).toEqual([]);
    expect(runtimeMime.errors).toHaveLength(1);
    expect(runtimeMime.errors[0]).toContain('static "application/json"');
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
    // The fan-out shape is a union of two title roads (cinatra#3732); the
    // shipped pack is on the first-line road, whose prefix is read below.
    const fanOut = only.binding.fanOut;
    expect(fanOut?.titleFrom).toBe("first-line");
    expect(fanOut?.titleFrom === "first-line" ? fanOut.titlePrefix : undefined).toBe("Title:");
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
    // Narrow the two-road fan-out union (cinatra#3732) to the first-line road
    // this pack ships on; any other road fails the case here.
    const fanOut = binding.fanOut!;
    if (fanOut.titleFrom !== "first-line") {
      throw new Error(`the shipped pack binds its ideas on the first-line road, not "${fanOut.titleFrom}"`);
    }
    // Every output the binding names is present and usable in that answer.
    const members = answer[binding.contentFrom!];
    expect(Array.isArray(members)).toBe(true);
    expect((members as unknown[]).every((m) => typeof m === "string")).toBe(true);
    for (const member of members as string[]) {
      const firstLine = member.split("\n", 1)[0]!;
      expect(firstLine.startsWith(fanOut.titlePrefix)).toBe(true);
      expect(firstLine.slice(fanOut.titlePrefix.length).trim().length).toBeGreaterThan(0);
    }
    // And the retired batch keys are named nowhere in the shipped flow.
    expect(JSON.stringify(oas)).not.toContain("ideaBatchTitle");
    expect(JSON.stringify(oas)).not.toContain("ideaBatchDocument");
  });
});
