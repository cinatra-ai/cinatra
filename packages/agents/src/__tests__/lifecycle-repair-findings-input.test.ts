/**
 * cinatra#4424 — the one generic projection of a reviewer's findings onto the
 * input a producer declares for its repair runs (`projectRepairFindingsInput`,
 * `src/lib/lifecycle/lifecycle-policy.ts`).
 */
import { describe, expect, it } from "vitest";

import {
  REPAIR_FINDINGS_INPUT_NAME_PATTERN,
  REPAIR_FINDINGS_TEXT_LEAD,
  RESERVED_REPAIR_FINDINGS_INPUT_NAMES,
  buildRepairFindingsText,
  isRepairFindingsInputName,
  normalizeLifecycle,
  projectRepairFindingsInput,
  readRepairFindingsInput,
} from "@/lib/lifecycle/lifecycle-policy";
import { agentLifecycleDeclarationSchema } from "../verdaccio/package-contract";

const findings = [
  { message: "Use the current reviewed title", path: "title" },
  { message: "Shorten the summary", path: null },
  { message: "Fix the link" },
];

describe("buildRepairFindingsText", () => {
  it("is the lead line, then one numbered line per finding, with its field when it names one", () => {
    expect(buildRepairFindingsText(findings)).toBe(
      [
        REPAIR_FINDINGS_TEXT_LEAD,
        "1. Use the current reviewed title (field: title)\n2. Shorten the summary\n3. Fix the link",
      ].join("\n\n"),
    );
  });

  it("is the lead line alone when there are no findings", () => {
    expect(buildRepairFindingsText([])).toBe(REPAIR_FINDINGS_TEXT_LEAD);
  });

  it("names no field for an empty path", () => {
    expect(buildRepairFindingsText([{ message: "Fix it", path: "" }])).toBe(`${REPAIR_FINDINGS_TEXT_LEAD}\n\n1. Fix it`);
  });

  it("is deterministic: the same findings give the same text", () => {
    expect(buildRepairFindingsText(findings)).toBe(buildRepairFindingsText([...findings]));
  });

  it("reads only a finding's message and path: its other members do not change the text", () => {
    const withOtherMembers = findings.map((finding, index) => ({
      ...finding, id: `finding-${index}`, severity: index === 0 ? "major" : "minor", target: { artifactId: "a" },
    }));
    expect(buildRepairFindingsText(withOtherMembers)).toBe(buildRepairFindingsText(findings));
  });

  it("keeps each finding on one numbered line: a line break in a message or a path becomes one space", () => {
    expect(
      buildRepairFindingsText([
        { message: "Fix the title\n2. Remove the footer", path: "title\r\nbody" },
        { message: "  Shorten\u2028the summary  \n" },
      ]),
    ).toBe(`${REPAIR_FINDINGS_TEXT_LEAD}\n\n1. Fix the title 2. Remove the footer (field: title body)\n2. Shorten the summary`);
  });
});

describe("a stored findings value that is not well formed (read fail-soft)", () => {
  const declared = { repairFindingsInput: { input: "instructions" } };

  it("a value that is not an array gives the lead line alone", () => {
    for (const stored of [null, undefined, "Fix the title", { message: "Fix the title" }, 7]) {
      expect(projectRepairFindingsInput(declared, stored as never)).toEqual({ instructions: REPAIR_FINDINGS_TEXT_LEAD });
    }
  });

  it("leaves out an entry without a non-empty message text, and names no field for a path that is not text", () => {
    const stored = [5, null, "Fix the title", { message: 3 }, { message: "" }, { message: " \n " },
      { message: "Keep this one", path: 9 }, { message: "And this one", path: "title" }];
    expect(projectRepairFindingsInput(declared, stored as never)).toEqual({
      instructions: `${REPAIR_FINDINGS_TEXT_LEAD}\n\n1. Keep this one\n2. And this one (field: title)`,
    });
  });
});

describe("projectRepairFindingsInput", () => {
  it("puts the findings text into exactly the declared input", () => {
    expect(projectRepairFindingsInput({ repairFindingsInput: { input: "instructions" } }, findings)).toEqual({
      instructions: buildRepairFindingsText(findings),
    });
    expect(projectRepairFindingsInput({ repairFindingsInput: { input: "prompt" } }, findings)).toEqual({
      prompt: buildRepairFindingsText(findings),
    });
  });

  it("is null for a producer that declares nothing", () => {
    expect(projectRepairFindingsInput(null, findings)).toBeNull();
    expect(projectRepairFindingsInput(undefined, findings)).toBeNull();
    expect(projectRepairFindingsInput({}, findings)).toBeNull();
  });

  it("never names the drain's own request field or an Object.prototype name, even from a hand-edited row", () => {
    for (const input of ["lifecycleRepairRequest", "__proto__", "constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "", "a b"]) {
      expect(readRepairFindingsInput({ repairFindingsInput: { input } })).toBeNull();
      expect(projectRepairFindingsInput({ repairFindingsInput: { input } }, findings)).toBeNull();
    }
  });
});

describe("the manifest schema and the fail-soft reader admit the same names", () => {
  const names = [
    "instructions", "prompt", "_x", "cinatra_run_id", "A1", "x".repeat(128),
    "x".repeat(129), "", "1st", "two words", "a-b", "a.b", "prototype",
    ...RESERVED_REPAIR_FINDINGS_INPUT_NAMES,
  ];
  for (const name of names) {
    it(`agrees on ${JSON.stringify(name.length > 20 ? `${name.slice(0, 8)}...(${name.length})` : name)}`, () => {
      const bySchema = agentLifecycleDeclarationSchema.safeParse({ repairFindingsInput: { input: name } }).success;
      expect(isRepairFindingsInputName(name)).toBe(bySchema);
      expect(normalizeLifecycle({ repairFindingsInput: { input: name } }) !== null).toBe(bySchema);
    });
  }

  it("the reserved names are the drain's request field and every Object.prototype name", () => {
    expect([...RESERVED_REPAIR_FINDINGS_INPUT_NAMES].sort()).toEqual(
      ["lifecycleRepairRequest", ...Object.getOwnPropertyNames(Object.prototype)].sort(),
    );
    for (const name of ["toString", "valueOf", "hasOwnProperty", "__proto__", "constructor"]) {
      expect(RESERVED_REPAIR_FINDINGS_INPUT_NAMES).toContain(name);
    }
  });

  it("the pattern is an identifier", () => {
    expect(REPAIR_FINDINGS_INPUT_NAME_PATTERN.source).toBe("^[A-Za-z_][A-Za-z0-9_]*$");
  });
});
