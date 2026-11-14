import { describe, it, expect } from "vitest";
import {
  CapabilityPlanRecorder,
  HOST_PRIMITIVE_OWNER_PACKAGE,
  HOST_PRIMITIVE_RELEASE_VERSION,
  planPrimitiveRegistration,
  primitiveProvenanceStamp,
  readDeclaredOutward,
} from "../capability-plan";

// ---------------------------------------------------------------------------
// A tool's outward declaration on its planned entry (cinatra#3745).
//
// A registration may declare, with `outward`, that its tool acts outward on a
// person's behalf, and optionally name the two input fields that carry the
// stored item the call acts on and its revision. The capability plan reads that
// declaration ONCE, with one total reader, and carries it on the planned entry
// of every registration. A declaration can only add a tool to what the host
// holds: every present value the host cannot read as a subject reads as
// outward without a subject, and the reader never throws.
//
// These cases drive the real reader, the real `planPrimitiveRegistration` and
// the real `CapabilityPlanRecorder`; nothing is replaced.
// ---------------------------------------------------------------------------

const HOST = { packageName: HOST_PRIMITIVE_OWNER_PACKAGE, version: HOST_PRIMITIVE_RELEASE_VERSION };
const NAME = "example_outward_tool";
const SUBJECT_FIELDS = { artifactId: "itemId", representationRevisionId: "revisionId" } as const;

function baseConfig(): Record<string, unknown> {
  return { title: NAME, description: NAME };
}

function plan(config: unknown) {
  return planPrimitiveRegistration({ name: NAME, config, order: 0, host: HOST });
}

/** A copy of `source` whose `key` accessor throws when read. */
function withThrowingAccessor(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...source };
  Object.defineProperty(copy, key, {
    enumerable: true,
    get() {
      throw new Error(`the ${key} accessor throws`);
    },
  });
  return copy;
}

// Every present value the host reads as outward without a subject.
const OUTWARD_WITHOUT_SUBJECT: ReadonlyArray<readonly [string, unknown]> = [
  ["true", true],
  ["false", false],
  ["a string", "yes"],
  ["a number", 1],
  ["an array", []],
  ["a function", () => undefined],
  ["a subject missing one input name", { subject: { artifactId: "itemId" } }],
  ["a subject with an empty input name", { subject: { artifactId: "", representationRevisionId: "revisionId" } }],
  ["a subject with a non-string input name", { subject: { artifactId: 1, representationRevisionId: "revisionId" } }],
  ["a subject that is an array", { subject: ["itemId", "revisionId"] }],
  ["a declaration that is not a plain object", Object.assign(new Date(0), { subject: { ...SUBJECT_FIELDS } })],
  ["a subject that is not a plain object", { subject: Object.assign(new Date(0), { ...SUBJECT_FIELDS }) }],
];

// Configs whose `outward` accessor, `subject` accessor or input-name accessor throws.
const THROWING_ACCESSORS: ReadonlyArray<readonly [string, () => Record<string, unknown>]> = [
  ["outward", () => withThrowingAccessor(baseConfig(), "outward")],
  ["subject", () => ({ ...baseConfig(), outward: withThrowingAccessor({}, "subject") })],
  [
    "an input name",
    () => ({
      ...baseConfig(),
      outward: { subject: withThrowingAccessor({ representationRevisionId: "revisionId" }, "artifactId") },
    }),
  ],
];

describe("the planned entry carries the outward declaration of its registration", () => {
  it("plans no declaration for a registration that declares nothing", () => {
    expect(plan(baseConfig()).declaredOutward).toBeNull();
    expect(plan({ ...baseConfig(), outward: undefined }).declaredOutward).toBeNull();
    expect(plan({ ...baseConfig(), outward: null }).declaredOutward).toBeNull();
    expect(readDeclaredOutward(undefined)).toBeNull();
    expect(readDeclaredOutward(null)).toBeNull();
    expect(readDeclaredOutward("config")).toBeNull();
    expect(readDeclaredOutward(baseConfig())).toBeNull();
  });

  it("plans an outward declaration without a subject for an empty declaration", () => {
    expect(plan({ ...baseConfig(), outward: {} }).declaredOutward).toEqual({ subject: null });
    expect(readDeclaredOutward({ ...baseConfig(), outward: {} })).toEqual({ subject: null });
  });

  it("plans the two named input fields as a copy the author's object cannot change later", () => {
    const subject: { artifactId: string; representationRevisionId: string } = { ...SUBJECT_FIELDS };
    const config = { ...baseConfig(), outward: { subject } };
    const planned = plan(config);
    expect(planned.declaredOutward).toEqual({ subject: { ...SUBJECT_FIELDS } });
    expect(planned.declaredOutward?.subject).not.toBe(subject);
    subject.artifactId = "otherItemId";
    subject.representationRevisionId = "otherRevisionId";
    expect(planned.declaredOutward).toEqual({ subject: { ...SUBJECT_FIELDS } });
  });

  it.each(OUTWARD_WITHOUT_SUBJECT)("plans %s as an outward declaration without a subject", (_label, value) => {
    expect(plan({ ...baseConfig(), outward: value }).declaredOutward).toEqual({ subject: null });
    expect(readDeclaredOutward({ ...baseConfig(), outward: value })).toEqual({ subject: null });
  });

  it.each(THROWING_ACCESSORS)(
    "plans a throwing accessor on %s as an outward declaration without a subject, and the recorder does not throw",
    (_label, makeConfig) => {
      expect(plan(makeConfig()).declaredOutward).toEqual({ subject: null });
      expect(() => readDeclaredOutward(makeConfig())).not.toThrow();
      const recorder = new CapabilityPlanRecorder({ host: HOST });
      let recorded: ReturnType<CapabilityPlanRecorder["record"]> | undefined;
      expect(() => {
        recorded = recorder.record(NAME, makeConfig());
      }).not.toThrow();
      expect(recorded?.declaredOutward).toEqual({ subject: null });
    },
  );

  it("carries the declaration on the entry of a registration whose identity cannot be resolved", () => {
    const stamp = primitiveProvenanceStamp({ ownerPackage: "", resolvedVersion: "1.0.0" });
    const declared = plan({ ...baseConfig(), ...stamp, outward: { subject: { ...SUBJECT_FIELDS } } });
    expect(declared.identityFailure).toBe("provenance_malformed");
    expect(declared.declaredOutward).toEqual({ subject: { ...SUBJECT_FIELDS } });
    const outward = plan({ ...baseConfig(), ...stamp, outward: {} });
    expect(outward.identityFailure).toBe("provenance_malformed");
    expect(outward.declaredOutward).toEqual({ subject: null });
    expect(plan({ ...baseConfig(), ...stamp }).declaredOutward).toBeNull();
  });

  it("carries the declaration on the entry of a registration that names the host as its owner", () => {
    const stamp = primitiveProvenanceStamp({ ownerPackage: HOST_PRIMITIVE_OWNER_PACKAGE, resolvedVersion: "1.0.0" });
    const declared = plan({ ...baseConfig(), ...stamp, outward: {} });
    expect(declared.identityFailure).toBe("host_owner_claimed");
    expect(declared.declaredOutward).toEqual({ subject: null });
    expect(plan({ ...baseConfig(), ...stamp }).declaredOutward).toBeNull();
  });
});

describe("the outward declaration leaves the delegated-chat declaration as it is", () => {
  const cases: ReadonlyArray<readonly [string, (base: Record<string, unknown>) => Record<string, unknown>]> = [
    ["no field", (base) => ({ ...base })],
    ["an undefined field", (base) => ({ ...base, outward: undefined })],
    ["a null field", (base) => ({ ...base, outward: null })],
    ["an empty declaration", (base) => ({ ...base, outward: {} })],
    ["a declaration with a subject", (base) => ({ ...base, outward: { subject: { ...SUBJECT_FIELDS } } })],
    ...OUTWARD_WITHOUT_SUBJECT.map(
      ([label, value]) => [label, (base: Record<string, unknown>) => ({ ...base, outward: value })] as const,
    ),
    ["a throwing accessor on outward", (base) => withThrowingAccessor(base, "outward")],
    ["a throwing accessor on subject", (base) => ({ ...base, outward: withThrowingAccessor({}, "subject") })],
    [
      "a throwing accessor on an input name",
      (base) => ({
        ...base,
        outward: { subject: withThrowingAccessor({ representationRevisionId: "revisionId" }, "artifactId") },
      }),
    ],
  ];

  const bases: ReadonlyArray<Record<string, unknown>> = [
    baseConfig(),
    { ...baseConfig(), delegatedChat: "read" },
    { ...baseConfig(), delegatedChat: "an unknown class" },
  ];

  it.each(cases)("plans the same delegated-chat class and malformed state with %s", (_label, withOutward) => {
    for (const base of bases) {
      const without = plan(base);
      const planned = plan(withOutward(base));
      expect(planned.declaredClass).toEqual(without.declaredClass);
      expect(planned.declarationMalformed).toBe(without.declarationMalformed);
    }
  });
});
