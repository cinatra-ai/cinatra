// The declared HITL screen allow-list (cinatra#3470).
//
// An agent binding may declare `cinatra.fieldRenderers[].screen`; the host draws
// it. The allow-list in ../agent-hitl-screen-schema.mjs is the one gate on
// generation, the runtime collector and registration. Pinned here: every
// unknown layout, section type and key is refused by name, and each bound
// holds. The binding validator and the generator are pinned in
// agent-binding-screen-3470.test.mjs.

import { describe, it, expect } from "vitest";
import {
  validateHitlScreen,
  MAX_HITL_SCREEN_BYTES,
} from "../agent-hitl-screen-schema.mjs";

const CARD = {
  layout: "card",
  title: "Fixture title",
  sections: [
    { type: "note", text: "Fixture note" },
    { type: "fact", label: "Fixture fact", key: "factKey", qualifierKey: "kindKey" },
    { type: "words", key: "content", label: "Fixture words" },
    { type: "quote", key: "excerpt" },
  ],
  decisions: [
    { label: "Fixture no", answer: { approved: false } },
    { label: "Fixture yes", answer: { approved: true, mode: "now", count: 1 } },
  ],
  carry: ["itemId"],
  requires: ["itemId"],
};

const FIELD_CARD = {
  layout: "card",
  title: "Fixture question",
  sections: [{ type: "field", key: "answer", label: "Fixture label", multiline: false, placeholder: "Fixture hint" }],
};

function refused(screen) {
  const { screen: out, errors } = validateHitlScreen(screen);
  expect(out).toBeUndefined();
  expect(errors.length).toBeGreaterThan(0);
  return errors.join("\n");
}

describe("validateHitlScreen accepts the declared shapes", () => {
  for (const [title, screen] of [
    ["a card with decisions", CARD],
    ["a card with a field", FIELD_CARD],
    ["a card with a title only", { layout: "card", title: "Fixture" }],
    ["a kind layout", { layout: "kind" }],
  ]) {
    it(title, () => {
      const { screen: out, errors } = validateHitlScreen(screen);
      expect(errors).toEqual([]);
      expect(out).toEqual(screen);
      expect(out).not.toBe(screen);
    });
  }
});

describe("validateHitlScreen refuses by name", () => {
  const rows = [
    ["an unknown layout", { layout: "page" }, /unknown layout "page"/],
    ["a missing layout", { title: "x" }, /unknown layout/],
    ["an unknown card key", { ...CARD, html: "<b>x</b>" }, /unknown key "html"/],
    ["an unknown key on a kind layout", { layout: "kind", title: "x" }, /unknown key "title"/],
    ["a missing title", { layout: "card" }, /title is required/],
    ["a blank title", { layout: "card", title: "   " }, /title must be non-blank text/],
    ["a title over 600 characters", { layout: "card", title: "x".repeat(601) }, /title must be non-blank text/],
    ["a title that is not text", { layout: "card", title: 7 }, /title must be non-blank text/],
    ["an unknown section type", { ...CARD, sections: [{ type: "html", text: "x" }] }, /unknown section type "html"/],
    ["a case-varied section type", { ...CARD, sections: [{ type: "Note", text: "x" }] }, /unknown section type "Note"/],
    ["an inherited section type", { ...CARD, sections: [{ type: "constructor" }] }, /unknown section type "constructor"/],
    ["a section that is not an object", { ...CARD, sections: ["note"] }, /unknown section type "note"/],
    ["an unknown section key", { ...CARD, sections: [{ type: "note", text: "x", href: "y" }] }, /unknown key "href"/],
    ["a fact without a key", { ...CARD, sections: [{ type: "fact", label: "x" }] }, /key is required/],
    ["a bad key", { ...CARD, sections: [{ type: "quote", key: "1abc" }] }, /key must be a key/],
    ["a key with a dash", { ...CARD, sections: [{ type: "quote", key: "a-b" }] }, /key must be a key/],
    ["a key over 64 characters", { ...CARD, sections: [{ type: "quote", key: "a".repeat(65) }] }, /key must be a key/],
    ["a qualifierKey with a dash", { ...CARD, sections: [{ type: "fact", label: "x", key: "k", qualifierKey: "q-k" }] }, /qualifierKey must be a key/],
    ["a non-boolean multiline", { ...FIELD_CARD, sections: [{ type: "field", key: "k", label: "x", multiline: "yes" }] }, /multiline must be a boolean/],
    ["a non-text placeholder", { ...FIELD_CARD, sections: [{ type: "field", key: "k", label: "x", placeholder: 3 }] }, /placeholder must be non-blank text/],
    ["sections that are not a list", { ...CARD, sections: {} }, /sections: must be a list/],
    ["seventeen sections", { ...CARD, sections: Array.from({ length: 17 }, () => ({ type: "note", text: "x" })) }, /sections: must be a list of at most 16/],
    ["no decisions in the list", { ...CARD, decisions: [] }, /decisions: must be a list of 1\.\.3/],
    ["four decisions", { ...CARD, decisions: [...CARD.decisions, ...CARD.decisions] }, /decisions: must be a list of 1\.\.3/],
    ["a decision without an answer", { ...CARD, decisions: [{ label: "x" }] }, /answer: must be an object/],
    ["a decision with an unknown key", { ...CARD, decisions: [{ label: "x", answer: { a: 1 }, style: "red" }] }, /unknown key "style"/],
    ["an empty answer", { ...CARD, decisions: [{ label: "x", answer: {} }] }, /must carry 1\.\.8 keys/],
    ["nine answer keys", { ...CARD, decisions: [{ label: "x", answer: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, true])) }] }, /must carry 1\.\.8 keys/],
    ["an answer over 600 characters", { ...CARD, decisions: [{ label: "x", answer: { note: "x".repeat(601) } }] }, /key "note" must be/],
    ["a nested answer", { ...CARD, decisions: [{ label: "x", answer: { nested: { a: 1 } } }] }, /key "nested" must be/],
    ["a NaN answer", { ...CARD, decisions: [{ label: "x", answer: { n: Number.NaN } }] }, /decisions\[0\]\.answer\.n is not a finite number/],
    ["an Infinity answer", { ...CARD, decisions: [{ label: "x", answer: { n: Infinity } }] }, /decisions\[0\]\.answer\.n is not a finite number/],
    ["decisions and a field together", { ...CARD, sections: FIELD_CARD.sections }, /decisions or fields, never both/],
    ["an empty carry list", { ...CARD, carry: [] }, /carry: must be a list of 1\.\.8 keys/],
    ["a carry list of nine", { ...CARD, carry: Array.from({ length: 9 }, (_, i) => `k${i}`) }, /carry: must be a list/],
    ["a requires list of nine", { ...CARD, requires: Array.from({ length: 9 }, (_, i) => `k${i}`) }, /requires: must be a list/],
    ["a bad requires key", { ...CARD, requires: ["a b"] }, /requires: must be a list/],
    ["a screen that is not an object", "card", /must be an object/],
    ["a list", [CARD], /must be an object/],
    ["null", null, /must be an object/],
  ];
  for (const [title, screen, message] of rows) {
    it(title, () => {
      expect(refused(screen)).toMatch(message);
    });
  }

  it("a BigInt value", () => {
    expect(refused({ layout: "card", title: "x", n: 1n })).toMatch(/must be plain JSON/);
  });

  it("a cyclic value", () => {
    const cyclic = { layout: "card", title: "x" };
    cyclic.self = cyclic;
    expect(refused(cyclic)).toMatch(/must be plain JSON/);
  });

  // Fail-closed on the RAW input, before any JSON round trip (pre-review 1,
  // finding 3): a round trip would drop an undefined key, call toJSON, and
  // read a class instance or an accessor as an ordinary object.
  it("an undefined value, which a round trip would drop", () => {
    expect(refused({ layout: "card", title: "x", unknown: undefined })).toMatch(
      /must be plain JSON \(screen\.unknown is undefined\)/,
    );
  });

  it("an undefined value deep in a section", () => {
    expect(refused({ ...CARD, sections: [{ type: "note", text: "x", href: undefined }] })).toMatch(
      /must be plain JSON \(screen\.sections\[0\]\.href is undefined\)/,
    );
  });

  it("a toJSON method that would stand in for the object", () => {
    expect(
      refused({
        toJSON() {
          return { layout: "card" };
        },
      }),
    ).toMatch(/must be plain JSON \(screen\.toJSON is a toJSON key\)/);
  });

  it("a toJSON key on an answer, even as text", () => {
    expect(refused({ ...CARD, decisions: [{ label: "x", answer: { toJSON: "x" } }] })).toMatch(
      /toJSON is a toJSON key/,
    );
  });

  it("a class instance", () => {
    class Screen {
      constructor() {
        this.layout = "card";
        this.title = "x";
      }
    }
    expect(refused(new Screen())).toMatch(/must be plain JSON \(screen is not a plain object\)/);
  });

  it("a class instance as a section", () => {
    class Note {
      constructor() {
        this.type = "note";
        this.text = "x";
      }
    }
    expect(refused({ ...CARD, sections: [new Note()] })).toMatch(/sections\[0\] is not a plain object/);
  });

  it("a Date value", () => {
    expect(refused({ layout: "card", title: new Date(0) })).toMatch(/screen\.title is not a plain object/);
  });

  it("a function value", () => {
    expect(refused({ layout: "card", title: "x", run: () => 1 })).toMatch(/screen\.run is a function/);
  });

  it("a symbol value and a symbol key", () => {
    expect(refused({ layout: "card", title: Symbol("x") })).toMatch(/screen\.title is a symbol/);
    expect(refused({ layout: "card", title: "x", [Symbol("k")]: 1 })).toMatch(/has a symbol key/);
  });

  it("an accessor", () => {
    const screen = { layout: "card" };
    Object.defineProperty(screen, "title", { get: () => "x", enumerable: true });
    expect(refused(screen)).toMatch(/screen\.title is an accessor/);
  });

  it("a hidden key", () => {
    const screen = { layout: "card", title: "x" };
    Object.defineProperty(screen, "hidden", { value: "y", enumerable: false });
    expect(refused(screen)).toMatch(/screen\.hidden is not enumerable/);
  });

  it("a sparse list and a list with an extra key", () => {
    const sparse = ["itemId"];
    sparse[2] = "x";
    expect(refused({ ...CARD, carry: sparse })).toMatch(/carry\[1\] is a hole/);
    const carry = ["itemId"];
    carry.extra = "x";
    expect(refused({ ...CARD, carry })).toMatch(/carry has a key that is not an index/);
  });

  it("a null-prototype object is plain JSON", () => {
    const screen = Object.assign(Object.create(null), { layout: "card", title: "Fixture" });
    const { screen: out, errors } = validateHitlScreen(screen);
    expect(errors).toEqual([]);
    expect(out).toEqual({ layout: "card", title: "Fixture" });
  });

  // A Proxy (pre-review 2, finding 1): the descriptor walk reads own data
  // properties, but serializing the raw object would run the proxy's get
  // trap, which the walk never saw. The proxy is refused where the runtime
  // can tell it apart, and only the walked plain copy is ever validated and
  // serialized, so no get trap on the raw input runs.
  function verdictProxy(counter) {
    return new Proxy(
      { layout: "card", title: "x" },
      {
        get(target, key, receiver) {
          counter.get += 1;
          if (key === "toJSON") return () => ({ layout: "kind" });
          return Reflect.get(target, key, receiver);
        },
      },
    );
  }

  function nestedProxyCard(counter) {
    const note = new Proxy(
      { type: "note", text: "Fixture note" },
      {
        get(target, key, receiver) {
          counter.get += 1;
          if (key === "text") return "Changed by the get trap";
          return Reflect.get(target, key, receiver);
        },
      },
    );
    return { layout: "card", title: "Fixture", sections: [note] };
  }

  // Runs fn as in a runtime that cannot tell a Proxy apart (a browser).
  function withoutProxyDetection(fn) {
    const original = process.getBuiltinModule;
    process.getBuiltinModule = undefined;
    try {
      return fn();
    } finally {
      process.getBuiltinModule = original;
    }
  }

  it("a Proxy with a virtual toJSON is refused as a proxy", () => {
    const counter = { get: 0 };
    expect(refused(verdictProxy(counter))).toMatch(/must be plain JSON \(screen is a proxy\)/);
    expect(counter.get).toBe(0);
  });

  it("a nested Proxy whose get trap changes a value is refused as a proxy", () => {
    const counter = { get: 0 };
    expect(refused(nestedProxyCard(counter))).toMatch(/screen\.sections\[0\] is a proxy/);
    expect(counter.get).toBe(0);
  });

  it("without proxy detection, a virtual toJSON never stands in for the walked card", () => {
    const counter = { get: 0 };
    const { screen: out, errors } = withoutProxyDetection(() => validateHitlScreen(verdictProxy(counter)));
    expect(errors).toEqual([]);
    expect(out).toEqual({ layout: "card", title: "x" });
    expect(counter.get).toBe(0);
  });

  it("without proxy detection, a get trap never changes a nested value", () => {
    const counter = { get: 0 };
    const { screen: out, errors } = withoutProxyDetection(() => validateHitlScreen(nestedProxyCard(counter)));
    expect(errors).toEqual([]);
    expect(out).toEqual({ layout: "card", title: "Fixture", sections: [{ type: "note", text: "Fixture note" }] });
    expect(counter.get).toBe(0);
  });

  it(`a screen over ${MAX_HITL_SCREEN_BYTES} bytes`, () => {
    const sections = Array.from({ length: 16 }, () => ({ type: "note", text: "\u00e9".repeat(300) }));
    expect(refused({ layout: "card", title: "x", sections })).toMatch(/<= 8192 bytes/);
  });
});
