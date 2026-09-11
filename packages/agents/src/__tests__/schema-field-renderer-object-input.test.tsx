// @vitest-environment jsdom
/**
 * cinatra#2484 — an `object`-typed Setup input must never be a free-text box
 * that accepts a bare string.
 *
 * Three legs, all covered here:
 *
 *  (a) VALIDATION regardless of schema — a `{type:"object"}` input with NO
 *      `json_schema.properties` (blog-draft-writer@0.1.2's `idea`) renders a
 *      JSON textarea. A plain sentence is refused with a VISIBLE message and
 *      never submitted; the grouped-form flush pushes the unparseable text back
 *      so the Zod layer rejects it independently.
 *  (b) STRUCTURED RENDERING when properties exist — the declared
 *      `{title, summary, outline}` shape (required: [title]) renders real
 *      sub-fields (the `outline` array uses the repo's existing
 *      one-value-per-line list input) and submits a real OBJECT.
 *  (c) ONE CONTROL when `x-object-text-property` is declared — the shape
 *      blog-draft-writer-agent ships. One visible editable control named after
 *      the FIELD ("Idea"), still emitting a real object. Leg (b) is what an
 *      object input renders as WITHOUT that hint, and it stays pinned for the
 *      extensions that want a real form.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/schema-field-renderer-object-input.test.tsx
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

// Same lucide stub as the sibling schema-field-renderer suites.
vi.mock("lucide-react", () => ({
  // The gate's control floor draws the arrow glyph after the word
  // (cinatra#3047 fix leg 8): the drawing's floor is "the primary
  // Continue, right-aligned over a hairline floor".
  ArrowRight: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "arrow-right", className }),
  LinkIcon: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "link", className }),
  MailIcon: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "mail", className }),
  ChevronDown: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "chevron-down", className }),
  ChevronUp: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "chevron-up", className }),
  Check: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "check", className }),
}));

import {
  SchemaFieldRenderer,
  OBJECT_INPUT_JSON_HINT,
  OBJECT_INPUT_NOT_AN_OBJECT_ERROR,
  OBJECT_INPUT_EMPTY_ERROR,
  parseJsonObjectInput,
  collectObjectSchemaErrors,
  objectTextPropertyRequiredError,
} from "../schema-field-renderer";

const BASE_CONTEXT = { connectedApps: [] as string[] };

/** blog-draft-writer@0.1.2 — object-typed, NO json_schema at all. */
const SCHEMALESS_OBJECT_SCHEMA = { type: "object", title: "idea" };

/**
 * The GENERIC structured-object shape: declared `properties`, and NO
 * single-text hint. This is what an object input renders as when the extension
 * wants a real form (one control per key).
 *
 * It is deliberately no longer named after blog-draft-writer. That agent's
 * `idea` now ships `x-object-text-property` and renders ONE control — see
 * `SHIPPED_IDEA_SCHEMA` and leg (c) below, which is the pin for its shape.
 */
const STRUCTURED_OBJECT_SCHEMA = {
  type: "object",
  title: "idea",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    outline: { type: "array", items: { type: "string" } },
  },
  required: ["title"],
};

/**
 * blog-draft-writer-agent's SHIPPED `idea` shape: the same sub-properties, plus
 * the hint that collapses them into ONE control. Kept byte-identical to the
 * compiled property the agent's `cinatra/oas.json` produces (pinned through the
 * real compiler in `single-idea-field-contract.test.ts`).
 */
const SHIPPED_IDEA_SCHEMA = {
  type: "object",
  title: "idea",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    outline: { type: "array", items: { type: "string" } },
  },
  required: ["title"],
  "x-object-text-property": "title",
  "x-multiline": true,
  "x-placeholder": "What should this post be about?",
};

function renderObjectField(
  schema: Record<string, unknown>,
  overrides: Partial<{
    onChange: (next: unknown) => void;
    registerFlush: (fn: () => Promise<void>) => void;
    hideSubmit: boolean;
    value: unknown;
  }> = {},
) {
  return render(
    <SchemaFieldRenderer
      fieldName="idea"
      schema={schema}
      value={overrides.value ?? undefined}
      onChange={overrides.onChange ?? (() => {})}
      required
      context={BASE_CONTEXT}
      hideSubmit={overrides.hideSubmit}
      registerFlush={overrides.registerFlush}
    />,
  );
}

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Leg (a) — validation regardless of schema
// ---------------------------------------------------------------------------
describe("object-typed input WITHOUT json_schema (cinatra#2484 leg a)", () => {
  it("does NOT render a bare single-line text input", () => {
    const { container } = renderObjectField(SCHEMALESS_OBJECT_SCHEMA);
    // The pre-fix defect: `type="text"` <input>, which happily took a sentence.
    expect(container.querySelector('input[type="text"]')).toBeNull();
    expect(container.querySelector("textarea")).not.toBeNull();
    expect(screen.getByText(OBJECT_INPUT_JSON_HINT)).toBeTruthy();
  });

  it("shows a visible rejection message for a plain string and never submits it", async () => {
    const onChange = vi.fn();
    const { container } = renderObjectField(SCHEMALESS_OBJECT_SCHEMA, { onChange });
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, {
      target: { value: "human purpose in an age of agentic ai" },
    });

    // The message is visible…
    await waitFor(() => {
      expect(
        container.querySelectorAll(`p.text-destructive`).length,
      ).toBeGreaterThan(0);
    });
    expect(
      Array.from(container.querySelectorAll("p")).some(
        (p) =>
          p.className.includes("destructive") &&
          p.textContent === OBJECT_INPUT_NOT_AN_OBJECT_ERROR,
      ),
    ).toBe(true);

    // …and Continue refuses to submit it.
    const continueButton = screen.getByRole("button", { name: /continue/i });
    expect((continueButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(continueButton);
    await waitFor(() => expect(onChange).not.toHaveBeenCalled());
  });

  it("the rejection message is DISTINCT from the always-visible guidance hint", async () => {
    // Both paragraphs render together; identical copy reads as a rendering
    // glitch rather than as an error the user can act on.
    expect(OBJECT_INPUT_NOT_AN_OBJECT_ERROR).not.toBe(OBJECT_INPUT_JSON_HINT);
    const { container } = renderObjectField(SCHEMALESS_OBJECT_SCHEMA);
    fireEvent.change(container.querySelector("textarea")!, {
      target: { value: "not json" },
    });
    await waitFor(() => {
      const texts = Array.from(container.querySelectorAll("p")).map((p) => p.textContent);
      expect(texts).toContain(OBJECT_INPUT_JSON_HINT);
      expect(texts).toContain(OBJECT_INPUT_NOT_AN_OBJECT_ERROR);
      // No duplicated sentence.
      expect(new Set(texts).size).toBe(texts.length);
    });
  });

  it("submits a REAL object when the text parses to a JSON object", async () => {
    const onChange = vi.fn();
    const { container } = renderObjectField(SCHEMALESS_OBJECT_SCHEMA, { onChange });

    fireEvent.change(container.querySelector("textarea")!, {
      target: { value: '{"title":"Human purpose","summary":"…"}' },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange.mock.calls[0][0]).toEqual({
      title: "Human purpose",
      summary: "…",
    });
  });

  it("refuses a JSON scalar / array — only an object satisfies an object input", async () => {
    const onChange = vi.fn();
    const { container } = renderObjectField(SCHEMALESS_OBJECT_SCHEMA, { onChange });
    for (const notAnObject of ['"just a quoted string"', "[1,2,3]", "42"]) {
      fireEvent.change(container.querySelector("textarea")!, {
        target: { value: notAnObject },
      });
      fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    }
    await waitFor(() => expect(onChange).not.toHaveBeenCalled());
  });

  it("grouped-form flush pushes the UNPARSEABLE text back so the schema layer rejects it too", async () => {
    const onChange = vi.fn();
    let flush: (() => Promise<void>) | undefined;
    const { container } = renderObjectField(SCHEMALESS_OBJECT_SCHEMA, {
      onChange,
      hideSubmit: true,
      registerFlush: (fn) => { flush = fn; },
    });

    fireEvent.change(container.querySelector("textarea")!, {
      target: { value: "human purpose in an age of agentic ai" },
    });
    await waitFor(() => expect(flush).toBeTypeOf("function"));
    await flush!();

    // A bare string reaches form state, where jsonSchemaToZod's object branch
    // rejects it — the flush must never fabricate an object out of prose.
    expect(onChange).toHaveBeenCalledWith("human purpose in an age of agentic ai");
  });

  it("grouped-form flush pushes the parsed OBJECT when the text is valid", async () => {
    const onChange = vi.fn();
    let flush: (() => Promise<void>) | undefined;
    const { container } = renderObjectField(SCHEMALESS_OBJECT_SCHEMA, {
      onChange,
      hideSubmit: true,
      registerFlush: (fn) => { flush = fn; },
    });

    fireEvent.change(container.querySelector("textarea")!, {
      target: { value: '{"title":"t"}' },
    });
    await waitFor(() => expect(flush).toBeTypeOf("function"));
    await flush!();

    expect(onChange).toHaveBeenCalledWith({ title: "t" });
  });

  it("prefills from the field's OWN value — the panels unwrap the envelope at the call site", () => {
    // The renderer used to be handed `{...currentValues}` — every input of the
    // run — and had to guess which slot was its own. Guessing is unsound (a run
    // input and a sub-property that merely share a name are unrelated), so the
    // unwrap moved to the CALLER (`setupFieldRendererValue`). Here `value` is
    // this field's own object and prefills verbatim.
    const { container } = renderObjectField(SCHEMALESS_OBJECT_SCHEMA, {
      value: { tone: "informative", length: "medium" },
    });
    expect(
      JSON.parse((container.querySelector("textarea") as HTMLTextAreaElement).value),
    ).toEqual({ tone: "informative", length: "medium" });
  });

  // -------------------------------------------------------------------------
  // An EMPTY box: rejected for a REQUIRED field, OMITTED for an optional one.
  // Both faces are pinned — the empty-object guard must not make an optional
  // object input impossible to skip (CodeRabbit, PR #2510).
  // -------------------------------------------------------------------------
  it("a REQUIRED object field refuses an empty box and never submits it", async () => {
    const onChange = vi.fn();
    render(
      <SchemaFieldRenderer
        fieldName="idea"
        schema={SCHEMALESS_OBJECT_SCHEMA}
        value={undefined}
        onChange={onChange}
        required
        context={BASE_CONTEXT}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(screen.getByText(OBJECT_INPUT_EMPTY_ERROR)).toBeTruthy());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("an OPTIONAL object field submits an empty box as OMITTED, not as an error", async () => {
    // `required={false}` is the surface DECLARING the field skippable (the
    // grouped Setup form passes it for every field). Leaving it blank must
    // advance — submitting `undefined`, so the key is simply absent from the
    // payload — rather than trapping the user on an input they need not fill.
    const onChange = vi.fn();
    render(
      <SchemaFieldRenderer
        fieldName="idea"
        schema={SCHEMALESS_OBJECT_SCHEMA}
        value={undefined}
        onChange={onChange}
        required={false}
        context={BASE_CONTEXT}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledWith(undefined);
    expect(screen.queryByText(OBJECT_INPUT_EMPTY_ERROR)).toBeNull();
  });

  it("the OPTIONAL empty flush pushes undefined so the field is absent from the payload", async () => {
    const onChange = vi.fn();
    let flush: (() => Promise<void>) | undefined;
    render(
      <SchemaFieldRenderer
        fieldName="idea"
        schema={SCHEMALESS_OBJECT_SCHEMA}
        value={undefined}
        onChange={onChange}
        required={false}
        context={BASE_CONTEXT}
        hideSubmit
        registerFlush={(fn) => { flush = fn; }}
      />,
    );
    await waitFor(() => expect(flush).toBeTypeOf("function"));
    await flush!();
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("an UNDECLARED requiredness fails closed — the empty box is still refused", async () => {
    // Absence of the prop is not a declaration of optionality. The per-field
    // Setup panels render the gate's single field WITHOUT `required`, and the
    // setup interrupt loop only ever prompts for REQUIRED fields
    // (`pendingFields = requiredFields.filter(...)`), so reading that silence as
    // "optional" would let a blank box submit `undefined` for a genuinely
    // required input — which the setup-resume path cannot serialize.
    const onChange = vi.fn();
    render(
      <SchemaFieldRenderer
        fieldName="idea"
        schema={SCHEMALESS_OBJECT_SCHEMA}
        value={undefined}
        onChange={onChange}
        context={BASE_CONTEXT}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(screen.getByText(OBJECT_INPUT_EMPTY_ERROR)).toBeTruthy());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("parseJsonObjectInput is the single accept/refuse decision", () => {
    expect(parseJsonObjectInput('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonObjectInput("plain sentence")).toEqual({
      ok: false,
      message: OBJECT_INPUT_NOT_AN_OBJECT_ERROR,
    });
    expect(parseJsonObjectInput("[]").ok).toBe(false);
    expect(parseJsonObjectInput("null").ok).toBe(false);
    expect(parseJsonObjectInput("   ")).toEqual({ ok: false, message: "Required" });
  });
});

// ---------------------------------------------------------------------------
// Leg (b) — structured rendering from json_schema.properties
// ---------------------------------------------------------------------------
describe("object-typed input WITH json_schema.properties (cinatra#2484 leg b)", () => {
  it("renders one sub-field per declared property, required-first (NO single-text hint)", () => {
    renderObjectField(STRUCTURED_OBJECT_SCHEMA);
    expect(screen.getByLabelText(/title \*/i)).toBeTruthy();
    expect(screen.getByLabelText(/summary/i)).toBeTruthy();
    expect(screen.getByLabelText(/outline/i)).toBeTruthy();
  });

  it("renders an array sub-property with the repo's one-value-per-line list input", () => {
    const { container } = renderObjectField(STRUCTURED_OBJECT_SCHEMA);
    const outline = container.querySelector("#field-outline") as HTMLElement;
    expect(outline.tagName.toLowerCase()).toBe("textarea");
    expect(screen.getByText(/One value per line/i)).toBeTruthy();
  });

  it("submits a REAL object assembled from the sub-fields", async () => {
    const onChange = vi.fn();
    const { container } = renderObjectField(STRUCTURED_OBJECT_SCHEMA, { onChange });

    fireEvent.change(container.querySelector("#field-title")!, {
      target: { value: "Human purpose in an age of agentic AI" },
    });
    fireEvent.change(container.querySelector("#field-summary")!, {
      target: { value: "What people are for when agents do the work." },
    });
    fireEvent.change(container.querySelector("#field-outline")!, {
      target: { value: "Why now\nWhat changes\nWhat to do" },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange.mock.calls[0][0]).toEqual({
      title: "Human purpose in an age of agentic AI",
      summary: "What people are for when agents do the work.",
      outline: ["Why now", "What changes", "What to do"],
    });
  });

  it("omits blank OPTIONAL sub-values instead of sending empty strings", async () => {
    const onChange = vi.fn();
    const { container } = renderObjectField(STRUCTURED_OBJECT_SCHEMA, { onChange });
    fireEvent.change(container.querySelector("#field-title")!, {
      target: { value: "Only a title" },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange.mock.calls[0][0]).toEqual({ title: "Only a title" });
  });

  it("blocks submit and names the missing REQUIRED sub-field", async () => {
    const onChange = vi.fn();
    const { container } = renderObjectField(STRUCTURED_OBJECT_SCHEMA, { onChange });
    fireEvent.change(container.querySelector("#field-summary")!, {
      target: { value: "summary only, no title" },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() =>
      expect(screen.getByText(/Fill in the required field: title\./i)).toBeTruthy(),
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("grouped-form flush emits the assembled object (not a string)", async () => {
    const onChange = vi.fn();
    let flush: (() => Promise<void>) | undefined;
    const { container } = renderObjectField(STRUCTURED_OBJECT_SCHEMA, {
      onChange,
      hideSubmit: true,
      registerFlush: (fn) => { flush = fn; },
    });
    fireEvent.change(container.querySelector("#field-title")!, {
      target: { value: "t" },
    });
    await waitFor(() => expect(flush).toBeTypeOf("function"));
    await flush!();
    expect(onChange).toHaveBeenCalledWith({ title: "t" });
  });

  // codex round 1: a NESTED schema-less object renders its own JSON box, whose
  // flush deliberately pushes the raw unparseable text so a grouped Zod layer
  // can reject it. The per-field Setup surface has no Zod layer, and the
  // server's type gate only inspects the TOP-LEVEL input — so the assembly step
  // must enforce the same rule one level down, or the child's visible error
  // would be purely decorative.
  it("refuses to submit an object whose NESTED object sub-field holds raw text", async () => {
    const onChange = vi.fn();
    const NESTED = {
      type: "object",
      title: "idea",
      properties: {
        title: { type: "string" },
        details: { type: "object" }, // nested, schema-less
      },
      required: ["title"],
    };
    const { container } = renderObjectField(NESTED, { onChange });
    fireEvent.change(container.querySelector("#field-title")!, {
      target: { value: "a title" },
    });
    fireEvent.change(container.querySelector("#field-details")!, {
      target: { value: "bare text, not an object" },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() =>
      expect(screen.getByText(/expects a JSON\s+object: details\./i)).toBeTruthy(),
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("accepts the same object once the nested sub-field holds real JSON", async () => {
    const onChange = vi.fn();
    const NESTED = {
      type: "object",
      title: "idea",
      properties: {
        title: { type: "string" },
        details: { type: "object" },
      },
      required: ["title"],
    };
    const { container } = renderObjectField(NESTED, { onChange });
    fireEvent.change(container.querySelector("#field-title")!, {
      target: { value: "a title" },
    });
    fireEvent.change(container.querySelector("#field-details")!, {
      target: { value: '{"depth":"deep"}' },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange.mock.calls[0][0]).toEqual({
      title: "a title",
      details: { depth: "deep" },
    });
  });

  it("seeds sub-fields ONLY from keys this object declares", () => {
    const { container } = renderObjectField(STRUCTURED_OBJECT_SCHEMA, {
      value: { title: "seeded", tone: "informative", length: "medium" },
    });
    expect((container.querySelector("#field-title") as HTMLInputElement).value).toBe("seeded");
    expect((container.querySelector("#field-summary") as HTMLInputElement).value).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Codex round 1 — seeding, and validation that recurses
// ---------------------------------------------------------------------------
describe("object-typed input seeding + compositional validation (cinatra#2484, codex round 1)", () => {
  it("seeds sub-fields from the field's OWN object", () => {
    const { container } = renderObjectField(STRUCTURED_OBJECT_SCHEMA, {
      value: { title: "the real sub-value", summary: "s" },
    });
    expect((container.querySelector("#field-title") as HTMLInputElement).value).toBe(
      "the real sub-value",
    );
    expect((container.querySelector("#field-summary") as HTMLInputElement).value).toBe("s");
  });

  it("renders an ALREADY-OBJECT value as JSON instead of an empty box", () => {
    // Seeding only from strings silently discarded a stored object: the field
    // came back blank and re-submitting wiped the run's own saved input.
    const { container } = renderObjectField(SCHEMALESS_OBJECT_SCHEMA, {
      value: { title: "kept" },
    });
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(JSON.parse(textarea.value)).toEqual({ title: "kept" });
  });

  it("refuses to submit when a NESTED structured object is missing its own required child", async () => {
    // The nested field assembles `{}` when its required child is blank. `{}` is
    // a plain object, so a top-level "is it an object?" check waved it through.
    const onChange = vi.fn();
    const NESTED = {
      type: "object",
      title: "idea",
      properties: {
        title: { type: "string" },
        details: {
          type: "object",
          properties: { depth: { type: "string" } },
          required: ["depth"],
        },
      },
      required: ["title", "details"],
    };
    const { container } = renderObjectField(NESTED, { onChange });
    fireEvent.change(container.querySelector("#field-title")!, {
      target: { value: "a title" },
    });
    // `details.depth` deliberately left blank.
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() =>
      expect(
        screen.getAllByText(/expects? a JSON object|Fill in the required/i).length,
      ).toBeGreaterThan(0),
    );
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("collectObjectSchemaErrors (cinatra#2484, codex round 1)", () => {
  const SCHEMA = {
    type: "object",
    properties: {
      title: { type: "string" },
      details: {
        type: "object",
        properties: { depth: { type: "string" } },
        required: ["depth"],
      },
    },
    required: ["title"],
  };

  it("accepts a complete object", () => {
    expect(
      collectObjectSchemaErrors(SCHEMA, { title: "t", details: { depth: "d" } }),
    ).toEqual([]);
  });

  it("reports a non-object at the top", () => {
    expect(collectObjectSchemaErrors(SCHEMA, "a bare sentence")).toEqual([
      { path: "", kind: "not-an-object" },
    ]);
  });

  it("reports a blank required key", () => {
    expect(collectObjectSchemaErrors(SCHEMA, { title: "  " })).toEqual([
      { path: "title", kind: "missing" },
    ]);
  });

  it("recurses into a declared sub-object's OWN required keys", () => {
    expect(
      collectObjectSchemaErrors(SCHEMA, { title: "t", details: {} }),
    ).toEqual([{ path: "details.depth", kind: "missing" }]);
  });

  it("reports a nested non-object", () => {
    expect(
      collectObjectSchemaErrors(SCHEMA, { title: "t", details: "bare text" }),
    ).toEqual([{ path: "details", kind: "not-an-object" }]);
  });

  it("treats an ABSENT optional sub-object as fine", () => {
    expect(collectObjectSchemaErrors(SCHEMA, { title: "t" })).toEqual([]);
  });
});

describe("collectObjectSchemaErrors traverses ARRAYS of objects (cinatra#2484, codex round 2)", () => {
  // `{type:"array", items:{type:"object"}}` is a declared object schema like any
  // other. Skipping it left `{sections: ["bare text"]}` accepted — this issue's
  // defect one container deeper.
  const ARRAY_SCHEMA = {
    type: "object",
    properties: {
      sections: {
        type: "array",
        items: {
          type: "object",
          properties: { heading: { type: "string" } },
          required: ["heading"],
        },
      },
    },
  };

  it("rejects a bare string inside an array of objects", () => {
    expect(collectObjectSchemaErrors(ARRAY_SCHEMA, { sections: ["bare text"] })).toEqual([
      { path: "sections.0", kind: "not-an-object" },
    ]);
  });

  it("reports a missing required key inside an array entry, by index", () => {
    expect(
      collectObjectSchemaErrors(ARRAY_SCHEMA, { sections: [{ heading: "h" }, {}] }),
    ).toEqual([{ path: "sections.1.heading", kind: "missing" }]);
  });

  it("accepts a well-formed array of objects", () => {
    expect(
      collectObjectSchemaErrors(ARRAY_SCHEMA, { sections: [{ heading: "a" }, { heading: "b" }] }),
    ).toEqual([]);
  });
});

describe("object sub-field error copy + x-hidden (cinatra#2484, codex round 3)", () => {
  const NESTED = {
    type: "object",
    title: "idea",
    properties: {
      title: { type: "string" },
      details: {
        type: "object",
        properties: { depth: { type: "string" } },
        required: ["depth"],
      },
    },
    // `details` is REQUIRED here on purpose (PR #2510 review round): a sub-object
    // the schema declares OPTIONAL and the user leaves blank is now OMITTED
    // rather than validated, so only a required one can be "incomplete" — which
    // is the copy this suite exists to pin.
    required: ["title", "details"],
  };

  it("an INCOMPLETE sub-object is not mislabelled 'not a JSON object'", async () => {
    // `details` is a perfectly well-formed object that is merely missing its own
    // required `depth`. Telling the user it "is not a JSON object" points them
    // at something that is not wrong.
    const onChange = vi.fn();
    const { container } = renderObjectField(NESTED, { onChange });
    fireEvent.change(container.querySelector("#field-title")!, { target: { value: "t" } });
    fireEvent.change(container.querySelector("#field-depth")!, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => {
      const texts = Array.from(container.querySelectorAll("p")).map((p) => p.textContent ?? "");
      expect(texts.some((t) => /Complete the required field/i.test(t))).toBe(true);
      expect(texts.some((t) => t === OBJECT_INPUT_NOT_AN_OBJECT_ERROR)).toBe(false);
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a NON-object sub-value still reports 'not a JSON object'", async () => {
    const onChange = vi.fn();
    const SCHEMALESS_NESTED = {
      type: "object",
      title: "idea",
      properties: {
        title: { type: "string" },
        details: { type: "object" },
      },
      required: ["title"],
    };
    const { container } = renderObjectField(SCHEMALESS_NESTED, { onChange });
    fireEvent.change(container.querySelector("#field-title")!, { target: { value: "t" } });
    fireEvent.change(container.querySelector("#field-details")!, {
      target: { value: "bare text" },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => {
      const texts = Array.from(container.querySelectorAll("p")).map((p) => p.textContent ?? "");
      expect(texts.some((t) => /expects? a JSON\s*object/i.test(t))).toBe(true);
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a required x-hidden sub-property does NOT deadlock the form", async () => {
    // x-hidden renders no input, so validating its requiredness would block the
    // form permanently on a field the user can never fill.
    const onChange = vi.fn();
    const HIDDEN = {
      type: "object",
      title: "idea",
      properties: {
        title: { type: "string" },
        internalId: { type: "string", "x-hidden": true },
      },
      required: ["title", "internalId"],
    };
    const { container } = renderObjectField(HIDDEN, { onChange });
    expect(container.querySelector("#field-internalId")).toBeNull();
    fireEvent.change(container.querySelector("#field-title")!, { target: { value: "t" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange.mock.calls[0][0]).toEqual({ title: "t" });
  });
});

// ---------------------------------------------------------------------------
// PR #2510 review round — a parent-driven `value` update must reach the
// rendered sub-fields, and an OPTIONAL object must be skippable.
// ---------------------------------------------------------------------------
describe("StructuredObjectField re-syncs when the PARENT changes `value`", () => {
  function renderStructured(value: unknown, onChange = vi.fn()) {
    const utils = render(
      <SchemaFieldRenderer
        fieldName="idea"
        schema={STRUCTURED_OBJECT_SCHEMA}
        value={value}
        onChange={onChange}
        required
        context={BASE_CONTEXT}
      />,
    );
    const rerenderWith = (next: unknown) =>
      utils.rerender(
        <SchemaFieldRenderer
          fieldName="idea"
          schema={STRUCTURED_OBJECT_SCHEMA}
          value={next}
          onChange={onChange}
          required
          context={BASE_CONTEXT}
        />,
      );
    return { ...utils, rerenderWith, onChange };
  }

  it("an AI-assist style update to `value` reaches the rendered sub-fields", async () => {
    // `draft` used to be seeded by the useState initializer ALONE. Both panels
    // pass `{ ...currentValues, ...bufferedHitlValue }` through
    // setupFieldRendererValue, and handleApply merges assist suggestions into
    // bufferedHitlValue — so for an object field the suggestion reached `value`
    // and stopped there, leaving the sub-fields showing the old draft.
    const { container, rerenderWith } = renderStructured({ title: "first" });
    expect((container.querySelector("#field-title") as HTMLInputElement).value).toBe("first");

    rerenderWith({ title: "assisted", summary: "a suggested summary" });

    await waitFor(() =>
      expect((container.querySelector("#field-title") as HTMLInputElement).value).toBe("assisted"),
    );
    expect((container.querySelector("#field-summary") as HTMLInputElement).value).toBe(
      "a suggested summary",
    );
  });

  it("the re-synced draft is what gets SUBMITTED, not the stale initial one", async () => {
    const onChange = vi.fn();
    const { rerenderWith } = renderStructured({ title: "first" }, onChange);
    rerenderWith({ title: "assisted" });
    await waitFor(() => expect(screen.getByRole("button", { name: /continue/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange.mock.calls[0][0]).toEqual({ title: "assisted" });
  });

  it("an edit to a sub-field the update does not MENTION survives the merge", async () => {
    // An object has independent slots and a suggestion mentions only some of
    // them. Replacing the draft wholesale would delete the sub-field the user is
    // half-way through typing merely because the suggestion said nothing about
    // it — the panel-side apply handler merges for exactly this reason.
    const { container, rerenderWith } = renderStructured({ title: "first" });
    fireEvent.change(container.querySelector("#field-summary")!, {
      target: { value: "half-typed" },
    });

    rerenderWith({ title: "assisted" }); // mentions `title` only

    await waitFor(() =>
      expect((container.querySelector("#field-title") as HTMLInputElement).value).toBe("assisted"),
    );
    expect((container.querySelector("#field-summary") as HTMLInputElement).value).toBe("half-typed");
  });

  it("a parent-driven update drops the markers computed against the REPLACED value", async () => {
    // The "Required" marks describe the value the parent just replaced. Leaving
    // them up marks a field the user can see is now filled.
    const { container, rerenderWith } = renderStructured(undefined);
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(screen.getByText(/Fill in the required/i)).toBeTruthy());

    rerenderWith({ title: "assisted" });

    await waitFor(() => expect(screen.queryByText(/Fill in the required/i)).toBeNull());
    expect((container.querySelector("#field-title") as HTMLInputElement).value).toBe("assisted");
  });

  it("an in-progress sub-field edit survives a parent re-render that does not change `value`", async () => {
    // The panels rebuild `value` inline every render, so a fresh object with the
    // SAME contents arrives constantly. Syncing on identity would wipe the
    // half-typed sub-field on each of them.
    const { container, rerenderWith } = renderStructured({ title: "seeded" });
    fireEvent.change(container.querySelector("#field-summary")!, {
      target: { value: "half-typed" },
    });
    rerenderWith({ title: "seeded" }); // equal contents, new object identity
    await waitFor(() =>
      expect((container.querySelector("#field-title") as HTMLInputElement).value).toBe("seeded"),
    );
    expect((container.querySelector("#field-summary") as HTMLInputElement).value).toBe("half-typed");
  });
});

describe("an OPTIONAL structured object can be skipped entirely (PR #2510 review round)", () => {
  /** Optional at the top, with a required sub-key — the shape that used to trap. */
  const OPTIONAL_WITH_REQUIRED_CHILD = {
    type: "object",
    title: "idea",
    properties: {
      title: { type: "string" },
      summary: { type: "string" },
    },
    required: ["title"],
  };

  function renderOptional(onChange: (next: unknown) => void, required: boolean) {
    return render(
      <SchemaFieldRenderer
        fieldName="idea"
        schema={OPTIONAL_WITH_REQUIRED_CHILD}
        value={undefined}
        onChange={onChange}
        required={required}
        context={BASE_CONTEXT}
      />,
    );
  }

  it("an untouched OPTIONAL object submits as OMITTED instead of demanding its required sub-field", async () => {
    const onChange = vi.fn();
    renderOptional(onChange, false);
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledWith(undefined);
    expect(screen.queryByText(/Fill in the required/i)).toBeNull();
  });

  it("a sub-field typed and then CLEARED omits the same way an untouched one does", async () => {
    const onChange = vi.fn();
    const { container } = renderOptional(onChange, false);
    fireEvent.change(container.querySelector("#field-title")!, { target: { value: "x" } });
    fireEvent.change(container.querySelector("#field-title")!, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("an untouched NESTED object does not make an optional parent unskippable", async () => {
    // The nested field's own sub-flushes push `""` for each declared string, so
    // an untouched `details` assembles to `{depth: ""}` — a non-blank value to
    // any shallow check, which used to pin the optional parent open.
    const onChange = vi.fn();
    render(
      <SchemaFieldRenderer
        fieldName="idea"
        schema={{
          type: "object",
          title: "idea",
          properties: {
            details: {
              type: "object",
              properties: { depth: { type: "string" } },
              required: ["depth"],
            },
          },
          required: ["details"],
        }}
        value={undefined}
        onChange={onChange}
        required={false}
        context={BASE_CONTEXT}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("a PARTIALLY filled optional object is still validated — omit it or complete it", async () => {
    const onChange = vi.fn();
    const { container } = renderOptional(onChange, false);
    fireEvent.change(container.querySelector("#field-summary")!, {
      target: { value: "only the optional half" },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(screen.getByText(/Fill in the required/i)).toBeTruthy());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a REQUIRED object still blocks on its missing required sub-field", async () => {
    const onChange = vi.fn();
    renderOptional(onChange, true);
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(screen.getByText(/Fill in the required/i)).toBeTruthy());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("the grouped-form flush of an untouched OPTIONAL object pushes undefined", async () => {
    const onChange = vi.fn();
    let flush: (() => Promise<void>) | undefined;
    render(
      <SchemaFieldRenderer
        fieldName="idea"
        schema={OPTIONAL_WITH_REQUIRED_CHILD}
        value={undefined}
        onChange={onChange}
        required={false}
        context={BASE_CONTEXT}
        hideSubmit
        registerFlush={(fn) => { flush = fn; }}
      />,
    );
    await waitFor(() => expect(flush).toBeTypeOf("function"));
    await flush!();
    expect(onChange).toHaveBeenCalledWith(undefined);
  });
});

// ---------------------------------------------------------------------------
// Leg (c) — ONE control from `x-object-text-property`
//
// The owner-specified presentation for blog-draft-writer-agent's `idea`: one
// visible editable control named after the FIELD. The three sub-controls that
// leg (b) renders must be absent, and what leaves the control is still a real
// OBJECT — the cinatra#2484 invariant is not relaxed to get one box back.
// ---------------------------------------------------------------------------
describe("object-typed input WITH x-object-text-property — ONE Idea control", () => {
  it("renders exactly ONE visible editable control, labelled Idea", () => {
    const { container } = renderObjectField(SHIPPED_IDEA_SCHEMA);

    const controls = container.querySelectorAll("input, textarea, select");
    expect(controls.length).toBe(1);

    const control = controls[0] as HTMLTextAreaElement;
    expect(control.id).toBe("field-idea");
    expect(control.disabled).toBe(false);
    expect(control.readOnly).toBe(false);
    expect(screen.getByLabelText(/^idea\s*\*?$/i)).toBe(control);

    // The three sub-controls leg (b) draws are GONE.
    expect(container.querySelector("#field-title")).toBeNull();
    expect(container.querySelector("#field-summary")).toBeNull();
    expect(container.querySelector("#field-outline")).toBeNull();
    expect(screen.queryByText(/One value per line/i)).toBeNull();
  });

  it("carries the authored placeholder onto that one control", () => {
    const { container } = renderObjectField(SHIPPED_IDEA_SCHEMA);
    expect(
      (container.querySelector("#field-idea") as HTMLTextAreaElement).placeholder,
    ).toBe("What should this post be about?");
  });

  it("submits the MINIMUM VALID OBJECT — never a bare string", async () => {
    const onChange = vi.fn();
    const { container } = renderObjectField(SHIPPED_IDEA_SCHEMA, { onChange });
    fireEvent.change(container.querySelector("#field-idea")!, {
      target: { value: "  human purpose in an age of agentic AI  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange.mock.calls[0][0]).toEqual({
      title: "human purpose in an age of agentic AI",
    });
    expect(typeof onChange.mock.calls[0][0]).toBe("object");
  });

  it("refuses an EMPTY submission with a visible error that names Idea", async () => {
    const onChange = vi.fn();
    renderObjectField(SHIPPED_IDEA_SCHEMA, { onChange });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() =>
      expect(screen.getByText(objectTextPropertyRequiredError("Idea"))).toBeTruthy(),
    );
    // The message NAMES the field the user can see, not a sub-key it hides.
    expect(objectTextPropertyRequiredError("Idea")).toMatch(/\bIdea\b/);
    expect(objectTextPropertyRequiredError("Idea")).not.toMatch(/\btitle\b/);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clears the empty-submission error as soon as the user types", async () => {
    const { container } = renderObjectField(SHIPPED_IDEA_SCHEMA);
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() =>
      expect(screen.getByText(objectTextPropertyRequiredError("Idea"))).toBeTruthy(),
    );
    fireEvent.change(container.querySelector("#field-idea")!, {
      target: { value: "a" },
    });
    await waitFor(() =>
      expect(screen.queryByText(objectTextPropertyRequiredError("Idea"))).toBeNull(),
    );
  });

  it("grouped-form flush pushes the object; an empty box pushes one WITHOUT the key", async () => {
    const onChange = vi.fn();
    let flush: (() => Promise<void>) | undefined;
    const { container } = renderObjectField(SHIPPED_IDEA_SCHEMA, {
      onChange,
      hideSubmit: true,
      registerFlush: (fn) => { flush = fn; },
    });
    await waitFor(() => expect(flush).toBeTypeOf("function"));

    // Empty: the Zod layer must see `title` missing and refuse independently.
    await flush!();
    expect(onChange).toHaveBeenLastCalledWith({});
    await waitFor(() =>
      expect(screen.getByText(objectTextPropertyRequiredError("Idea"))).toBeTruthy(),
    );

    fireEvent.change(container.querySelector("#field-idea")!, {
      target: { value: "a real idea" },
    });
    await flush!();
    expect(onChange).toHaveBeenLastCalledWith({ title: "a real idea" });
  });

  it("SEEDS from the object's own text property and keeps the companions on submit", async () => {
    const onChange = vi.fn();
    const { container } = renderObjectField(SHIPPED_IDEA_SCHEMA, {
      onChange,
      value: {
        title: "seeded from an upstream producer",
        summary: "a pitch the producer wrote",
        outline: ["one", "two"],
      },
    });
    const control = container.querySelector("#field-idea") as HTMLTextAreaElement;
    expect(control.value).toBe("seeded from an upstream producer");
    // The companions are not shown, and editing the one field must not delete
    // them — that would silently discard the upstream producer's work.
    fireEvent.change(control, { target: { value: "an edited idea" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange.mock.calls[0][0]).toEqual({
      summary: "a pitch the producer wrote",
      outline: ["one", "two"],
      title: "an edited idea",
    });
  });

  it("seeds a STRING value verbatim rather than blanking the box", () => {
    const { container } = renderObjectField(SHIPPED_IDEA_SCHEMA, {
      value: "text a previous rendering stored",
    });
    expect((container.querySelector("#field-idea") as HTMLTextAreaElement).value).toBe(
      "text a previous rendering stored",
    );
  });

  it("a DECLARED-OPTIONAL empty field submits undefined instead of trapping the user", async () => {
    const onChange = vi.fn();
    render(
      <SchemaFieldRenderer
        fieldName="idea"
        schema={SHIPPED_IDEA_SCHEMA}
        value={undefined}
        onChange={onChange}
        required={false}
        context={BASE_CONTEXT}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(undefined));
  });

  it("an UNUSABLE hint degrades to the structured form rather than a wrong control", () => {
    const { container } = renderObjectField({
      ...STRUCTURED_OBJECT_SCHEMA,
      "x-object-text-property": "outline", // declared, but an array
    });
    expect(container.querySelector("#field-title")).not.toBeNull();
    expect(container.querySelector("#field-summary")).not.toBeNull();
  });
});
