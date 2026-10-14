// cinatra#4137 — the core development setup names no connector.
//
// `src/lib/dev-auto-setup.ts` is the VENDOR-NEUTRAL shell that runs every
// connector's own `cinatra.devSetup` hook. The border check of core
// (scripts/audit/vendor-token-core-gate.mjs) reads only file paths and import
// specifiers, so a core module that imports a connector-named FUNCTION from
// another core module, or names a connector in its comments and log lines,
// passed it (cinatra#4113 did both). This guard reads the shell's WHOLE text —
// code, comments, strings and log lines — against two vocabularies, both read
// from the repository, never typed here:
//   (1) the vendor tokens core must not hold: the frozen VENDOR_TOKENS of that
//       gate, matched by its own `segmentMatchesToken`;
//   (2) the name of every connector the two committed extension locks pin:
//       its package name, its package leaf (`<name>-connector`) and the first
//       word of its name. A first word that is the first word of a host
//       workspace package or of an SDK contract module (`email`, `crm`, `mcp`
//       …) names a host capability the connector provides, not the connector,
//       and is not read as a name; that connector's package name and leaf
//       still are.
// A finding names the line and the word. The third case proves the reading
// catches a reintroduced name in each form it can take.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  VENDOR_TOKENS,
  segmentMatchesToken,
  subTokens,
} from "../../../scripts/audit/vendor-token-core-gate.mjs";

const REPO = path.resolve(__dirname, "../../..");
const SHELL = "src/lib/dev-auto-setup.ts";
const LOCKS = ["cinatra-required-extensions.lock.json", "cinatra-dev-extensions.lock.json"];
const SDK_SRC = "packages/sdk-extensions/src";

type Vocabulary = { tokens: readonly string[]; words: string[]; literals: string[] };
type Finding = { line: number; name: string };

/** Every connector the committed locks pin; fails closed on a thin universe. */
function installedConnectors(): string[] {
  const out = new Set<string>();
  for (const lock of LOCKS) {
    const doc = JSON.parse(readFileSync(path.join(REPO, lock), "utf8")) as { packages?: Array<{ packageName?: string }> };
    const names = (doc.packages ?? []).map((p) => p.packageName).filter((n): n is string => typeof n === "string");
    const connectors = names.filter((n) => n.endsWith("-connector"));
    if (connectors.length === 0) throw new Error(`${lock} pins no connector — the vocabulary would be thin`);
    for (const c of connectors) out.add(c);
  }
  return [...out].sort();
}

const leafOf = (pkg: string) => pkg.replace(/^@[^/]+\//, "");
const firstWordOf = (leaf: string) => leaf.split("-")[0] ?? leaf;

/** First words the host itself owns: of its workspace packages and of its SDK contract modules. */
function hostOwnedWords(): Set<string> {
  const words = new Set<string>();
  for (const dir of readdirSync(path.join(REPO, "packages"))) {
    const manifest = path.join(REPO, "packages", dir, "package.json");
    if (!existsSync(manifest)) continue;
    const name = (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name;
    if (name) words.add(firstWordOf(leafOf(name)));
  }
  for (const file of readdirSync(path.join(REPO, SDK_SRC))) {
    if (/contract\.ts$/.test(file)) words.add(firstWordOf(file));
  }
  return words;
}

function vocabulary(): Vocabulary {
  const connectors = installedConnectors();
  const owned = hostOwnedWords();
  const words = new Set<string>();
  const literals = new Set<string>();
  for (const pkg of connectors) {
    const leaf = leafOf(pkg);
    literals.add(pkg.toLowerCase());
    literals.add(leaf.toLowerCase());
    const word = firstWordOf(leaf).toLowerCase();
    if (!owned.has(word)) words.add(word);
  }
  return { tokens: VENDOR_TOKENS, words: [...words].sort(), literals: [...literals].sort() };
}

/** Every connector name the text holds, line by line (comments and strings included). */
function connectorNamesIn(text: string, vocab: Vocabulary): Finding[] {
  const out: Finding[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = i + 1;
    const lower = raw.toLowerCase();
    for (const literal of vocab.literals) if (lower.includes(literal)) out.push({ line, name: literal });
    for (const segment of raw.split(/[^A-Za-z0-9]+/).filter(Boolean)) {
      for (const token of vocab.tokens) if (segmentMatchesToken(segment, token)) out.push({ line, name: token });
      const parts = subTokens(segment);
      for (const word of vocab.words) if (parts.includes(word)) out.push({ line, name: word });
    }
  });
  return out;
}

describe("the core development setup names no connector (cinatra#4137)", () => {
  it("src/lib/dev-auto-setup.ts holds no vendor token and no installed connector's name — in code, comments or log text", () => {
    const text = readFileSync(path.join(REPO, SHELL), "utf8");

    const findings = connectorNamesIn(text, vocabulary());

    expect(findings.map((f) => `${SHELL}:${f.line} names ${f.name}`)).toEqual([]);
  });

  it("the vocabulary is read from the repository: the locks' connectors, the vendor gate's tokens, the host's own words", () => {
    const vocab = vocabulary();

    expect(installedConnectors()).toContain("@cinatra-ai/twenty-connector");
    expect(vocab.words).toContain("twenty");
    expect(vocab.literals).toContain("@cinatra-ai/twenty-connector");
    expect(vocab.tokens).toContain("twenty");
    // A host capability word is not a connector's name; the package still is.
    expect(hostOwnedWords().has("email")).toBe(true);
    expect(vocab.words).not.toContain("email");
    expect(vocab.literals).toContain("email-connector");
  });

  it("a connector name reintroduced into the shell is caught in every form it can take", () => {
    const vocab = vocabulary();
    const clean = "const shell = 1;\n";
    expect(connectorNamesIn(clean, vocab)).toEqual([]);
    const forms = (word: string) => {
      const cap = word.charAt(0).toUpperCase() + word.slice(1);
      return [
        `// the ${cap} connection is handed over`,
        `import { devReownRefusedFixture${cap}Connection } from "@/lib/external-mcp-registry";`,
        `console.log("could not hand the ${word} connection over");`,
        `const file = "tests/e2e/${word}-uat/.uat/actor.json";`,
      ];
    };
    for (const word of [...vocab.words, ...vocab.tokens]) {
      for (const form of forms(word)) {
        expect(connectorNamesIn(clean + form, vocab).map((f) => f.line), `${word}: ${form}`).toEqual(
          expect.arrayContaining([2]),
        );
      }
    }
    for (const literal of vocab.literals) {
      expect(connectorNamesIn(`${clean}const pkg = "${literal}";`, vocab).length, literal).toBeGreaterThan(0);
    }
  });
});
