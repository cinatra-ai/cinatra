// Rolling dev-lock bump PR body composer (cinatra#2986 gap 2).
//
// The contract these tests pin is a SAFETY contract, not a formatting one: the
// automation may PRESERVE a human acknowledgement, and may never PRODUCE one.
// So the assertions are about what the composer must NEVER emit at least as
// much as about what it must emit.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  composeBumpPrBody,
  fingerprintSkillLinkedPins,
  extractAckBlock,
} from "../dev-lock-bump-pr-body.mjs";

const CLI_PATH = fileURLToPath(new URL("../dev-lock-bump-pr-body.mjs", import.meta.url));

// FIXTURE NAMING: every `@cinatra-ai/example-*` package below is FICTIONAL,
// deliberately. The skills gate intersects declared watch surfaces against the
// raw diff TEXT, so naming a really-watched package in a fixture would flag this
// very PR and ask a person for a judgment about a string in a test file. Keep
// these names unreal.
/** The three acknowledgement forms the skills gate accepts. */
const ACK_TOKENS = ["Skills-PR:", "Skills-reviewed:", "Skills-unaffected:"];

const PIN_CHANGES = [
  "- `@cinatra-ai/example-watched-agent`: fff78d38a756 -> 0b144b511801",
  "- `@cinatra-ai/example-unwatched-connector`: a56a47e0d4e8 -> 0a3afabe74c9",
].join("\n");

const SKILL_LINKED = [
  { packageName: "@cinatra-ai/example-watched-agent", resolvedSha: "0b144b511801e6ad1b7c0f0b2e6a2f2b4b8c1d2e" },
  { packageName: "@cinatra-ai/example-watched-publisher", resolvedSha: "ce0ecede78c9a1b2c3d4e5f60718293a4b5c6d7e" },
];

/** Wrap human ack text in the marker pair carrying `fp`. */
function markedBlock(fp, inner) {
  return `<!-- cinatra:skills-ack v1 fingerprint=${fp} -->\n${inner}\n<!-- /cinatra:skills-ack -->`;
}

/** The gate's pinned skills universe: its repo pins + every declared surface. */
const UNIVERSE = {
  pins: ["cinatra-ai/example-skill@" + "1".repeat(40)],
  surfaces: [
    "packages:@cinatra-ai/example-watched-agent@example-skill/SKILL.md",
    "primitives:example_watched_primitive@example-skill/SKILL.md",
  ],
};

describe("fingerprintSkillLinkedPins", () => {
  it("is stable under input ORDER (f)", () => {
    const forward = fingerprintSkillLinkedPins(SKILL_LINKED);
    const reversed = fingerprintSkillLinkedPins([...SKILL_LINKED].reverse());
    expect(forward).toBe(reversed);
    expect(forward).toMatch(/^[0-9a-f]{64}$/);
  });

  it("MOVES when a covered package's pin moves", () => {
    const moved = [
      { ...SKILL_LINKED[0], resolvedSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      SKILL_LINKED[1],
    ];
    expect(fingerprintSkillLinkedPins(moved)).not.toBe(fingerprintSkillLinkedPins(SKILL_LINKED));
  });

  it("MOVES when the covered set gains or loses a package", () => {
    expect(fingerprintSkillLinkedPins([SKILL_LINKED[0]])).not.toBe(fingerprintSkillLinkedPins(SKILL_LINKED));
    expect(fingerprintSkillLinkedPins([])).not.toBe(fingerprintSkillLinkedPins(SKILL_LINKED));
  });

  it("is defined for the EMPTY set (a no-skill-linked bump still has a fingerprint)", () => {
    expect(fingerprintSkillLinkedPins([])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("MOVES when a de-listed watched package enters the set", () => {
    const withRemoval = [...SKILL_LINKED, { packageName: "@cinatra-ai/example-gone", resolvedSha: "(removed)" }];
    expect(fingerprintSkillLinkedPins(withRemoval)).not.toBe(fingerprintSkillLinkedPins(SKILL_LINKED));
  });

  it("MOVES when the gate's pinned skills universe is re-pinned", () => {
    const repinned = { ...UNIVERSE, pins: ["cinatra-ai/example-skill@" + "2".repeat(40)] };
    expect(fingerprintSkillLinkedPins(SKILL_LINKED, repinned)).not.toBe(
      fingerprintSkillLinkedPins(SKILL_LINKED, UNIVERSE),
    );
  });

  it("MOVES when a skill's DECLARED surfaces change, in any watch class", () => {
    const grown = { ...UNIVERSE, surfaces: [...UNIVERSE.surfaces, "paths:packages/agents/src/x.ts@example-skill/SKILL.md"] };
    expect(fingerprintSkillLinkedPins(SKILL_LINKED, grown)).not.toBe(fingerprintSkillLinkedPins(SKILL_LINKED, UNIVERSE));
  });

  it("is order-independent across BOTH families", () => {
    const shuffled = {
      pins: [...UNIVERSE.pins].reverse(),
      surfaces: [...UNIVERSE.surfaces].reverse(),
    };
    expect(fingerprintSkillLinkedPins([...SKILL_LINKED].reverse(), shuffled)).toBe(
      fingerprintSkillLinkedPins(SKILL_LINKED, UNIVERSE),
    );
  });
});

describe("composeBumpPrBody", () => {
  it("(a) no block + no skill-linked pins -> marker pair still placed, judgment framed as conditional", () => {
    const body = composeBumpPrBody({ oldBody: "", pinChanges: PIN_CHANGES, skillLinked: [] });
    expect(body).toContain("## Pin changes");
    expect(body).toContain("@cinatra-ai/example-unwatched-connector");
    // No pin above asks for a skill-linked judgment...
    expect(body).toMatch(/asks for no judgment on that watch class/i);
    // ...but the gate can still fail on an unrelated residual watch (declared
    // primitives/routes/paths), so a person needs somewhere durable to write
    // one if it does — the pair and the conditional instructions are placed.
    expect(body).toContain("<!-- cinatra:skills-ack v1 fingerprint=");
    expect(body).toContain("<!-- /cinatra:skills-ack -->");
    expect(body).toMatch(/if it does, a person must record that judgment here/i);
    for (const token of ACK_TOKENS) expect(body).not.toContain(token);
  });

  it("(b) no block + skill-linked pins -> body DEMANDS a human block and synthesizes none", () => {
    const body = composeBumpPrBody({ oldBody: "", pinChanges: PIN_CHANGES, skillLinked: SKILL_LINKED });
    expect(body).toMatch(/a person must/i);
    // The marker pair is placed for the human; the acknowledgement is not.
    expect(body).toContain("<!-- cinatra:skills-ack v1 fingerprint=");
    expect(body).toContain(fingerprintSkillLinkedPins(SKILL_LINKED));
    expect(body).toContain("<!-- /cinatra:skills-ack -->");
    expect(body).toContain("@cinatra-ai/example-watched-agent");
    for (const token of ACK_TOKENS) expect(body).not.toContain(token);
  });

  it("(c) valid block + UNCHANGED fingerprint -> block carried BYTE-IDENTICAL", () => {
    const fp = fingerprintSkillLinkedPins(SKILL_LINKED);
    const human = "Skills-unaffected: the bumped blog packages change no watched primitive name or param shape.";
    const block = markedBlock(fp, human);
    const oldBody = `Stale preamble a human never wrote.\n\n${block}\n\n## Pin changes\n\n- stale list\n`;
    const body = composeBumpPrBody({ oldBody, pinChanges: PIN_CHANGES, skillLinked: SKILL_LINKED });
    expect(body).toContain(block);
    expect(body).toContain(human);
    // A real, non-blank human judgment DOES get the carried-judgment sentence.
    expect(body).toMatch(/written by a person/i);
    // Only the marked block survives; every other old-body edit is regenerated.
    expect(body).not.toContain("Stale preamble a human never wrote.");
    expect(body).not.toContain("- stale list");
    // Exactly one block, and no second marker pair appended.
    expect(body.match(/<!-- cinatra:skills-ack/g)).toHaveLength(1);
    expect(body).not.toMatch(/a person must/i);
  });

  it("(d) valid block + MOVED fingerprint -> block dropped, fresh-judgment note present", () => {
    const staleFp = fingerprintSkillLinkedPins([SKILL_LINKED[0]]);
    const human = "Skills-unaffected: covered only the previous pin set.";
    const oldBody = `## Pin changes\n\n${markedBlock(staleFp, human)}\n`;
    const body = composeBumpPrBody({ oldBody, pinChanges: PIN_CHANGES, skillLinked: SKILL_LINKED });
    expect(body).not.toContain(human);
    // The stale fingerprint may be NAMED in the drop note (that is the audit
    // trail), but it must not survive on a marker line — a carried block is
    // exactly a marker line, so this is the assertion that matters.
    expect(body).not.toContain(`fingerprint=${staleFp}`);
    expect(body).toMatch(/fresh judgment/i);
    expect(body).toContain(fingerprintSkillLinkedPins(SKILL_LINKED));
    for (const token of ACK_TOKENS) expect(body).not.toContain(token);
  });

  it("(d2) a dropped block does not resurrect on the NEXT refresh", () => {
    const staleFp = fingerprintSkillLinkedPins([SKILL_LINKED[0]]);
    const once = composeBumpPrBody({
      oldBody: markedBlock(staleFp, "Skills-reviewed: old."),
      pinChanges: PIN_CHANGES,
      skillLinked: SKILL_LINKED,
    });
    const twice = composeBumpPrBody({ oldBody: once, pinChanges: PIN_CHANGES, skillLinked: SKILL_LINKED });
    expect(twice).not.toContain("Skills-reviewed: old.");
    for (const token of ACK_TOKENS) expect(twice).not.toContain(token);
  });

  it("(d3) a skills-universe re-pin alone drops the block, pins unchanged", () => {
    const fp = fingerprintSkillLinkedPins(SKILL_LINKED, UNIVERSE);
    const human = "Skills-unaffected: judged against the previous skills universe.";
    const oldBody = markedBlock(fp, human);
    // Same pins, re-pinned universe -> the judgment no longer covers the gate's
    // declarations, so it must not carry.
    const repinned = { ...UNIVERSE, pins: ["cinatra-ai/example-skill@" + "3".repeat(40)] };
    const body = composeBumpPrBody({ oldBody, pinChanges: PIN_CHANGES, skillLinked: SKILL_LINKED, universe: repinned });
    expect(body).not.toContain(human);
    expect(body).toMatch(/fresh judgment/i);
    // ...and the SAME universe carries it.
    const carried = composeBumpPrBody({ oldBody, pinChanges: PIN_CHANGES, skillLinked: SKILL_LINKED, universe: UNIVERSE });
    expect(carried).toContain(human);
  });

  it("(e) the automation emits NO acknowledgement token in ANY generated text", () => {
    const cases = [
      { oldBody: "", skillLinked: [] },
      { oldBody: "", skillLinked: SKILL_LINKED },
      { oldBody: markedBlock("0".repeat(64), "Skills-reviewed: stale."), skillLinked: SKILL_LINKED },
      { oldBody: "<!-- cinatra:skills-ack v1 fingerprint=nothex -->\nx\n<!-- /cinatra:skills-ack -->", skillLinked: SKILL_LINKED },
      { oldBody: "<!-- cinatra:skills-ack v1 fingerprint=" + "1".repeat(64) + " -->\nno end marker", skillLinked: SKILL_LINKED },
      { oldBody: "Skills-unaffected: a bare line OUTSIDE any marker block.", skillLinked: SKILL_LINKED },
    ];
    for (const c of cases) {
      const body = composeBumpPrBody({ ...c, pinChanges: PIN_CHANGES });
      for (const token of ACK_TOKENS) {
        expect(body, `token ${token} leaked for oldBody=${JSON.stringify(c.oldBody).slice(0, 60)}`).not.toContain(token);
      }
    }
  });

  it("(e2) an UNMARKED acknowledgement line is NOT preserved (only the marked block is)", () => {
    const body = composeBumpPrBody({
      oldBody: "Skills-unaffected: a human wrote this outside the markers.",
      pinChanges: PIN_CHANGES,
      skillLinked: SKILL_LINKED,
    });
    expect(body).not.toContain("a human wrote this outside the markers");
  });

  it("(f) tolerates human edits AROUND the markers and CRLF line endings", () => {
    const fp = fingerprintSkillLinkedPins(SKILL_LINKED);
    const human = "Skills-reviewed: checked the three blog SKILL.md watch surfaces.";
    const oldBody = [
      "Some prose a reviewer typed above the block.",
      "",
      markedBlock(fp, human),
      "",
      "And a note they typed below it.",
    ].join("\r\n");
    const body = composeBumpPrBody({ oldBody, pinChanges: PIN_CHANGES, skillLinked: SKILL_LINKED });
    expect(body).toContain(human);
    expect(body).not.toContain("Some prose a reviewer typed above the block.");
    expect(body).not.toContain("And a note they typed below it.");
  });

  it("(f2) TWO marker blocks are ambiguous -> fail closed, drop both, demand a fresh judgment", () => {
    const fp = fingerprintSkillLinkedPins(SKILL_LINKED);
    const oldBody = `${markedBlock(fp, "Skills-reviewed: first.")}\n\n${markedBlock(fp, "Skills-reviewed: second.")}`;
    const body = composeBumpPrBody({ oldBody, pinChanges: PIN_CHANGES, skillLinked: SKILL_LINKED });
    expect(body).not.toContain("Skills-reviewed: first.");
    expect(body).not.toContain("Skills-reviewed: second.");
    expect(body).toMatch(/a person must/i);
  });

  it("an empty marked block is NOT carried as a judgment across a refresh: no claim, instructions kept", () => {
    const fp = fingerprintSkillLinkedPins(SKILL_LINKED);
    const first = composeBumpPrBody({ oldBody: "", pinChanges: PIN_CHANGES, skillLinked: SKILL_LINKED });
    const second = composeBumpPrBody({ oldBody: first, pinChanges: PIN_CHANGES, skillLinked: SKILL_LINKED });
    expect(second).toContain(fp);
    expect(second.match(/<!-- cinatra:skills-ack/g)).toHaveLength(1);
    for (const token of ACK_TOKENS) expect(second).not.toContain(token);
    // The empty pair must never read as a person's judgment...
    expect(second).not.toMatch(/written by a person/i);
    // ...and the instructions that tell a person what to do must survive.
    expect(second).toMatch(/a person must record that judgment here/i);
  });

  it("a WHITESPACE-ONLY block also counts as blank, not a judgment", () => {
    const fp = fingerprintSkillLinkedPins(SKILL_LINKED);
    const oldBody = markedBlock(fp, "   \n\t  \n");
    const body = composeBumpPrBody({ oldBody, pinChanges: PIN_CHANGES, skillLinked: SKILL_LINKED });
    expect(body).not.toMatch(/written by a person/i);
    expect(body).toMatch(/a person must record that judgment here/i);
    expect(body.match(/<!-- cinatra:skills-ack/g)).toHaveLength(1);
    for (const token of ACK_TOKENS) expect(body).not.toContain(token);
  });

  it("the no-skill-linked branch: a real judgment written into its marker pair carries on the next refresh", () => {
    const opened = composeBumpPrBody({ oldBody: "", pinChanges: PIN_CHANGES, skillLinked: [] });
    expect(opened).toMatch(/if it does, a person must record that judgment here/i);
    const fpMatch = opened.match(/fingerprint=([0-9a-f]{64})/);
    expect(fpMatch).not.toBeNull();
    const human = "Skills-unaffected: no watched primitive, route, or path moved in this bump.";
    const withJudgment = opened.replace(
      /<!-- cinatra:skills-ack v1 fingerprint=[0-9a-f]{64} -->\n\n<!-- \/cinatra:skills-ack -->/,
      markedBlock(fpMatch[1], human),
    );
    const refreshed = composeBumpPrBody({ oldBody: withJudgment, pinChanges: PIN_CHANGES, skillLinked: [] });
    // The block a person wrote survives verbatim — it legitimately carries the
    // token they wrote; only the AUTOMATION must never emit one itself.
    expect(refreshed).toContain(human);
    expect(refreshed.match(/<!-- cinatra:skills-ack/g)).toHaveLength(1);
  });

  it("always regenerates the pin list from the CURRENT bump, never the old body", () => {
    const body = composeBumpPrBody({
      oldBody: "## Pin changes\n\n- `@cinatra-ai/example-retired-package`: aaaaaaaaaaaa -> bbbbbbbbbbbb\n",
      pinChanges: PIN_CHANGES,
      skillLinked: [],
    });
    expect(body).not.toContain("@cinatra-ai/example-retired-package");
    expect(body).toContain("@cinatra-ai/example-watched-agent");
  });
});

describe("extractAckBlock", () => {
  it("reports the stored fingerprint and the raw block for a well-formed pair", () => {
    const fp = "a".repeat(64);
    const block = markedBlock(fp, "human text");
    const res = extractAckBlock(`lead\n\n${block}\n\ntrail`);
    expect(res.kind).toBe("found");
    expect(res.fingerprint).toBe(fp);
    expect(res.raw).toBe(block);
  });

  it("reports NONE for a body with no markers", () => {
    expect(extractAckBlock("nothing here").kind).toBe("none");
  });

  it("reports MALFORMED for an unterminated or reversed pair", () => {
    const fp = "b".repeat(64);
    expect(extractAckBlock(`<!-- cinatra:skills-ack v1 fingerprint=${fp} -->\nx`).kind).toBe("malformed");
    expect(extractAckBlock(`<!-- /cinatra:skills-ack -->\n<!-- cinatra:skills-ack v1 fingerprint=${fp} -->`).kind).toBe(
      "malformed",
    );
  });

  it("reports AMBIGUOUS for two begin markers", () => {
    const fp = "c".repeat(64);
    const body = `${markedBlock(fp, "one")}\n${markedBlock(fp, "two")}`;
    expect(extractAckBlock(body).kind).toBe("ambiguous");
  });

  it("reports NONE for a block whose inner text is BLANK — an empty pair is not a judgment", () => {
    const fp = "d".repeat(64);
    expect(extractAckBlock(markedBlock(fp, "")).kind).toBe("none");
    // Whitespace-only content (spaces, tabs, blank lines) also counts as blank.
    expect(extractAckBlock(markedBlock(fp, "   \n\t  \n  ")).kind).toBe("none");
  });

  it("still reports FOUND when inner text has real content around whitespace", () => {
    const fp = "e".repeat(64);
    const res = extractAckBlock(markedBlock(fp, "  Skills-unaffected: judged.  "));
    expect(res.kind).toBe("found");
    expect(res.fingerprint).toBe(fp);
  });
});

describe("CLI: --skill-linked fails loud on a missing file", () => {
  it("exits non-zero rather than silently defaulting to the empty (permissive) set", () => {
    const dir = mkdtempSync(join(tmpdir(), "dev-lock-bump-pr-body-"));
    try {
      const pinChangesPath = join(dir, "pin-changes.md");
      writeFileSync(pinChangesPath, PIN_CHANGES);
      const missingSkillLinkedPath = join(dir, "does-not-exist.json");
      expect(() =>
        execFileSync(
          process.execPath,
          [CLI_PATH, "--pin-changes", pinChangesPath, "--skill-linked", missingSkillLinkedPath],
          { stdio: "pipe" },
        ),
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a missing --old-body file is still permissive (empty body on a freshly opened PR)", () => {
    const dir = mkdtempSync(join(tmpdir(), "dev-lock-bump-pr-body-"));
    try {
      const pinChangesPath = join(dir, "pin-changes.md");
      writeFileSync(pinChangesPath, PIN_CHANGES);
      const missingOldBodyPath = join(dir, "does-not-exist.md");
      const out = execFileSync(
        process.execPath,
        [CLI_PATH, "--pin-changes", pinChangesPath, "--old-body", missingOldBodyPath],
        { stdio: "pipe", encoding: "utf8" },
      );
      expect(out).toContain("## Pin changes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
