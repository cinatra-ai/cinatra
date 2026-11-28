// declared-text-core-gate tests (cinatra#4533, stages 1 and 2).
//
// The gate module is imported inside each test, so a checkout without it fails
// every case by an assertion rather than failing to load. The fixture trees
// live under a temporary directory; every package in them uses the scope
// `@example-org`. The last block is the TEST OF RECORD: it runs the gate's own
// scan over the real tree and holds the committed floor against it, so the
// root suite refuses a new, grown or stale match on every pull request.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { makeFloorRepo, NO_PULL_REQUEST_RUN, PULL_REQUEST_RUN } from "./floor-base-fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_ROOT = resolve(HERE, "..", "..", "..");
const RECORD_TIMEOUT = 120_000;

async function gate() {
  try {
    return await import("../declared-text-core-gate.mjs");
  } catch (err) {
    expect.fail(`the declared text gate module does not load: ${err?.message ?? err}`);
  }
}

const temps = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function put(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, typeof content === "string" ? content : JSON.stringify(content, null, 2));
}

const DECLARED_STEP = "Pick the one weekly digest you want to send today.";
const DECLARED_DESC = "Writes a short weekly digest of the notes your team keeps.";
const DECLARED_FIELD = "Choose how many notes the digest may carry at most.";
const DECLARED_OAS_ONLY = "The notes agent pauses here until a person approves the digest.";
const FIXTURE_ONLY = "This sentence lives only in a test fixture of the pack.";
const PACK_CODE_ONLY = "This sentence lives only in the pack's own source code.";

/** A repository with two pinned packs and a small core tree. */
function fixtureRepo({ withTree = true, extraPinned = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "declared-text-"));
  temps.push(root);
  const pinned = ["@example-org/notes-agent", "@example-org/digest-connector", ...extraPinned];
  put(root, "package.json", { name: "@example-org/host", cinatra: { devExtensions: Object.fromEntries(pinned.map((p) => [p, "x"])) } });
  put(root, "cinatra-required-extensions.lock.json", { packages: [{ packageName: pinned[0] }] });
  put(root, "cinatra-dev-extensions.lock.json", { packages: [{ packageName: pinned[1] }] });
  if (withTree) {
    put(root, "extensions/example-org/notes-agent/package.json", {
      name: "@example-org/notes-agent",
      description: DECLARED_DESC,
      cinatra: { kind: "agent", steps: [{ title: DECLARED_STEP }] },
      scripts: { build: "Builds The Package From Its Sources Today" },
    });
    put(root, "extensions/example-org/notes-agent/cinatra/settings.json", { fields: [{ help: DECLARED_FIELD }] });
    put(root, "extensions/example-org/notes-agent/flows/notes.oas.json", {
      nodes: [{ metadata: { cinatra: { hitl: { prompt: `  ${DECLARED_OAS_ONLY.replace(/ /g, "\n   ")}  ` } } } }],
    });
    put(root, "extensions/example-org/notes-agent/tests/fixtures/cinatra/sample.json", { text: FIXTURE_ONLY });
    put(root, "extensions/example-org/notes-agent/src/index.ts", `export const t = ${JSON.stringify(PACK_CODE_ONLY)};\n`);
    put(root, "extensions/example-org/digest-connector/package.json", { name: "@example-org/digest-connector", cinatra: { kind: "connector" } });
  }
  put(
    root,
    "src/app/notes/page.tsx",
    `export default function Page() {\n  return <p>\n    Pick the one weekly digest\n    you want to send today.\n  </p>;\n}\n`,
  );
  put(root, "src/lib/notes.ts", `export const a = "${DECLARED_FIELD}";\nexport const b = \`${DECLARED_FIELD}\`;\nexport const c = \`${DECLARED_FIELD.slice(0, 10)}\${1}\`;\n`);
  put(root, "packages/notes/src/help.ts", `export const h = ${JSON.stringify(DECLARED_OAS_ONLY)};\n`);
  put(root, "packages/notes/src/other.ts", `export const p = ${JSON.stringify(PACK_CODE_ONLY)};\nexport const f = ${JSON.stringify(FIXTURE_ONLY)};\n`);
  put(root, "src/lib/__tests__/notes.test.ts", `export const t = "${DECLARED_FIELD}";\n`);
  put(root, "scripts/audit/x.ts", `export const s = "${DECLARED_FIELD}";\n`);
  return root;
}

const EXPECTED_MATCHES = {
  "packages/notes/src/help.ts :: The notes agent pauses here until a person approves the digest.": 1,
  "src/app/notes/page.tsx :: Pick the one weekly digest you want to send today.": 1,
  "src/lib/notes.ts :: Choose how many notes the digest may carry at most.": 2,
};

describe("the comparison", () => {
  it("collapses whitespace and counts a text only with 20 characters, 4 words, a capital and no template syntax", async () => {
    const m = await gate();
    expect(m.collapseWhitespace("  Send\n\tthe   digest  ")).toBe("Send the digest");
    expect(m.isCountedText("Send the weekly digest now")).toBe(true);
    expect(m.isCountedText("Send the digest now")).toBe(false); // 19 characters
    expect(m.isCountedText("Send weeklydigestnow please")).toBe(false); // 3 words
    expect(m.isCountedText("send the weekly digest now")).toBe(false); // no capital
    for (const t of ["Send the {{count}} digests now", "Send the ${count} digests now", "Send the {% x %} digests now", "Send the <%= x %> digests now"]) {
      expect(m.isCountedText(t), t).toBe(false);
    }
  });

  it("reads string literals, substitution-free template literals and JSX texts, and nothing with a substitution", async () => {
    const m = await gate();
    const counts = m.coreTexts(
      "x.tsx",
      'const a = "One two three";\nconst b = `Four five`;\nconst c = `Six ${a} seven`;\nconst d = <b title="Eight nine">Ten   eleven</b>;\n',
    );
    expect([...counts.keys()].sort()).toEqual(["Eight nine", "Four five", "One two three", "Ten eleven"]);
  });

  it("a core module that does not parse is a scanner error", async () => {
    const m = await gate();
    expect(() => m.coreTexts("broken.ts", "const = ;")).toThrow(m.DeclaredTextScanError);
  });
});

describe("the scan over a fixture tree", () => {
  it("reads the manifest description, the cinatra field, cinatra/**/*.json and *.oas.json, never fixtures or pack code", async () => {
    const m = await gate();
    const root = fixtureRepo();
    const declared = m.readDeclaredTexts(m.locatePinnedPackages(root));
    expect([...declared.keys()].sort()).toEqual([DECLARED_FIELD, DECLARED_STEP, DECLARED_DESC, DECLARED_OAS_ONLY].sort());
    expect(declared.get(DECLARED_STEP)).toEqual(["@example-org/notes-agent"]);
  });

  it("records every equal core text by file and count, with the application border gate's scope and exemptions", async () => {
    const m = await gate();
    const root = fixtureRepo();
    const scan = m.scanDeclaredTextCore(root);
    expect(scan.matches).toEqual(EXPECTED_MATCHES);
    expect(scan.packageCount).toBe(2);
  });

  it("fails closed on an absent tree, a missing pinned package, no pinned package and an unreadable declaration", async () => {
    const m = await gate();
    expect(() => m.scanDeclaredTextCore(fixtureRepo({ withTree: false }))).toThrow(/no extension package/);
    expect(() => m.scanDeclaredTextCore(fixtureRepo({ extraPinned: ["@example-org/absent-artifact"] }))).toThrow(
      /not found under .*@example-org\/absent-artifact/,
    );
    const none = fixtureRepo();
    put(none, "package.json", { name: "@example-org/host" });
    put(none, "cinatra-required-extensions.lock.json", { packages: [] });
    put(none, "cinatra-dev-extensions.lock.json", { packages: [] });
    expect(() => m.scanDeclaredTextCore(none)).toThrow(/no pinned extension package/);
    const broken = fixtureRepo();
    put(broken, "extensions/example-org/notes-agent/cinatra/settings.json", "{ not json");
    expect(() => m.scanDeclaredTextCore(broken)).toThrow(m.DeclaredTextScanError);
    const twice = fixtureRepo();
    put(twice, "extensions/example-org/notes-agent-copy/package.json", { name: "@example-org/notes-agent" });
    expect(() => m.scanDeclaredTextCore(twice)).toThrow(/two extension directories/);
  });
});

describe("the extension side's test and fixture paths", () => {
  const NORMAL_FLOW = "Pick the notes the weekly flow should gather first.";
  const SKIPPED = "This sentence lives only in a skipped test or fixture file.";

  /** The fixture repository plus a normal cinatra/flow.json and one skipped file; core spells both texts. */
  function repoWithSkipped(skippedRel) {
    const root = fixtureRepo();
    put(root, "extensions/example-org/notes-agent/cinatra/flow.json", { steps: [{ title: NORMAL_FLOW }] });
    put(root, `extensions/example-org/notes-agent/${skippedRel}`, { steps: [{ title: SKIPPED }] });
    put(root, "src/lib/flow-texts.ts", `export const n = ${JSON.stringify(NORMAL_FLOW)};\nexport const s = ${JSON.stringify(SKIPPED)};\n`);
    return root;
  }

  for (const skippedRel of ["cinatra/flow.test.json", "fixtures/sample.oas.json", "cinatra/__mocks__/x.json"]) {
    it(`does not read ${skippedRel}, and reads the normal cinatra/flow.json beside it`, async () => {
      const m = await gate();
      const root = repoWithSkipped(skippedRel);
      const declared = m.readDeclaredTexts(m.locatePinnedPackages(root));
      expect(declared.has(SKIPPED), `${skippedRel} was read`).toBe(false);
      expect(declared.get(NORMAL_FLOW)).toEqual(["@example-org/notes-agent"]);
      const scan = m.scanDeclaredTextCore(root);
      expect(scan.matches).toEqual({ ...EXPECTED_MATCHES, [`src/lib/flow-texts.ts :: ${NORMAL_FLOW}`]: 1 });
    });
  }
});

describe("the floor", () => {
  it("refuses a new or grown match, reports a fallen one stale, and is never raised by the writer", async () => {
    const m = await gate();
    const floor = { "a.ts :: Old": 2, "b.ts :: Gone": 1 };
    const live = { "a.ts :: Old": 1, "c.ts :: New": 1 };
    expect(m.checkFloor(floor, live)).toEqual({ grown: ["c.ts :: New (0 -> 1)"], stale: ["a.ts :: Old (2 -> 1)", "b.ts :: Gone (1 -> 0)"] });
    expect(m.checkFloor({ "a.ts :: Old": 1 }, { "a.ts :: Old": 2 }).grown).toEqual(["a.ts :: Old (1 -> 2)"]);
    expect(m.ratchetFloor(floor, live)).toEqual({ "a.ts :: Old": 1 });
  });

  it("the command line exits 0 on a held floor, 1 on a grown or stale one, 2 on a scanner error", async () => {
    const m = await gate();
    const quiet = { log() {}, error() {} };
    const root = fixtureRepo();
    expect(m.main(["--repo-root", root], { env: {}, out: quiet })).toBe(2); // no floor yet
    expect(m.main(["--repo-root", root, "--write-baseline"], { env: {}, out: quiet })).toBe(0);
    expect(m.main(["--repo-root", root], { env: {}, out: quiet })).toBe(0);
    put(root, "src/lib/more.ts", `export const x = "${DECLARED_DESC}";\n`);
    expect(m.main(["--repo-root", root], { env: {}, out: quiet })).toBe(1); // a new match
    expect(m.main(["--repo-root", root, "--write-baseline"], { env: {}, out: quiet })).toBe(1); // never raised
    rmSync(join(root, "src/lib/more.ts"));
    rmSync(join(root, "packages/notes/src/help.ts"));
    expect(m.main(["--repo-root", root], { env: {}, out: quiet })).toBe(1); // stale
    expect(m.main(["--repo-root", root, "--write-baseline"], { env: {}, out: quiet })).toBe(0);
    expect(m.main(["--repo-root", root], { env: {}, out: quiet })).toBe(0);
    rmSync(join(root, "extensions"), { recursive: true });
    expect(m.main(["--repo-root", root], { env: {}, out: quiet })).toBe(2);
  });

  it("refuses a committed floor that grew against the base, and admits the introducing change", async () => {
    const m = await gate();
    const root = fixtureRepo();
    const git = (...args) => execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q");
    git("-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "--allow-empty", "-m", "empty");
    git("tag", "before");
    const floorPath = join(root, m.FLOOR_REL);
    mkdirSync(dirname(floorPath), { recursive: true });
    writeFileSync(floorPath, m.floorDocument({ "src/lib/notes.ts :: Choose how many notes the digest may carry at most.": 2 }));
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "base");
    git("tag", "base");
    const grownFloor = { ...EXPECTED_MATCHES };
    const grew = m.checkFloorAgainstBase({ repoRoot: root, env: { [m.FLOOR_BASE_VAR]: "base" }, headFloor: grownFloor });
    expect(grew.ok).toBe(false);
    expect(grew.status).toBe("grew");
    const held = m.checkFloorAgainstBase({
      repoRoot: root,
      env: { [m.FLOOR_BASE_VAR]: "base" },
      headFloor: { "src/lib/notes.ts :: Choose how many notes the digest may carry at most.": 1 },
    });
    expect(held.ok).toBe(true);
    const intro = m.checkFloorAgainstBase({ repoRoot: root, env: { [m.FLOOR_BASE_VAR]: "before" }, headFloor: grownFloor });
    expect(intro.status).toBe("introducing");
    const bad = m.checkFloorAgainstBase({ repoRoot: root, env: { [m.FLOOR_BASE_VAR]: "no-such-ref" }, headFloor: grownFloor });
    expect(bad.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stage 2: the extensions' own code literals under `src/` and `cinatra/`.
// ---------------------------------------------------------------------------

const CODE_STRING = "Pick a weekly digest before you send it out.";
const CODE_TEMPLATE = "The digest list is empty for this week so far.";
const CODE_JSX = "Your weekly digest has been queued for sending.";
const CODE_IN_CINATRA = "The digest step needs one approved note to continue.";
const CODE_IN_TEST = "This sentence lives only in a test file of the pack code.";
const CODE_IN_DTS = "This sentence lives only in a type declaration file here.";
const CODE_OUTSIDE = "This sentence lives in pack code outside the read folders.";

/** The fixture repository plus pack code files; core spells every text once in one file. */
function repoWithCode() {
  const root = fixtureRepo();
  const pack = "extensions/example-org/notes-agent";
  put(root, `${pack}/src/texts.ts`, `export const a = ${JSON.stringify(CODE_STRING)};\nexport const b = \`${CODE_TEMPLATE}\`;\nexport const c = \`${CODE_STRING} \${a}\`;\n`);
  put(root, `${pack}/src/view.tsx`, `export const V = () => <p>\n  Your weekly digest has been\n  queued for sending.\n</p>;\n`);
  put(root, `${pack}/cinatra/steps/step.mjs`, `export default { help: ${JSON.stringify(CODE_IN_CINATRA)} };\n`);
  put(root, `${pack}/src/texts.test.ts`, `export const t = ${JSON.stringify(CODE_IN_TEST)};\n`);
  put(root, `${pack}/src/__tests__/view.tsx`, `export const t = ${JSON.stringify(CODE_IN_TEST)};\n`);
  put(root, `${pack}/src/types.d.ts`, `export declare const d: ${JSON.stringify(CODE_IN_DTS)};\n`);
  put(root, `${pack}/scripts/build.mjs`, `export const o = ${JSON.stringify(CODE_OUTSIDE)};\n`);
  put(root, `${pack}/src/declared-too.ts`, `export const x = ${JSON.stringify(DECLARED_FIELD)};\n`);
  const all = [CODE_STRING, CODE_TEMPLATE, CODE_JSX, CODE_IN_CINATRA, CODE_IN_TEST, CODE_IN_DTS, CODE_OUTSIDE];
  put(root, "src/lib/pack-code-texts.ts", all.map((t, i) => `export const s${i} = ${JSON.stringify(t)};`).join("\n") + "\n");
  return root;
}

const EXPECTED_CODE_MATCHES = {
  "packages/notes/src/other.ts :: This sentence lives only in the pack's own source code.": 1,
  [`src/lib/pack-code-texts.ts :: ${CODE_IN_CINATRA}`]: 1,
  [`src/lib/pack-code-texts.ts :: ${CODE_JSX}`]: 1,
  [`src/lib/pack-code-texts.ts :: ${CODE_STRING}`]: 1,
  [`src/lib/pack-code-texts.ts :: ${CODE_TEMPLATE}`]: 1,
};

describe("stage 2: the extensions' own code", () => {
  it("the code path rule: code files under src/ and cinatra/, never tests, *.test.ts(x), declaration files or other folders", async () => {
    const m = await gate();
    expect(m.isExtensionCodePath, "the gate exports isExtensionCodePath").toBeTypeOf("function");
    for (const rel of ["src/a.ts", "src/b/c.tsx", "src/d.mts", "src/e.cts", "src/f.js", "src/g.jsx", "cinatra/h.mjs", "cinatra/i/j.cjs"]) {
      expect(m.isExtensionCodePath(rel), rel).toBe(true);
    }
    for (const rel of [
      "src/a.test.ts",
      "src/a.test.tsx",
      "src/__tests__/a.ts",
      "src/fixtures/a.ts",
      "cinatra/__mocks__/a.js",
      "src/a.d.ts",
      "src/a.d.mts",
      "cinatra/a.d.cts",
      "scripts/a.ts",
      "dist/a.js",
      "index.ts",
      "src/a.json",
    ]) {
      expect(m.isExtensionCodePath(rel), rel).toBe(false);
    }
    expect(m.isExtensionTestOrFixturePath("src/a.test.ts")).toBe(true);
    expect(m.isExtensionTestOrFixturePath("src/a.test.tsx")).toBe(true);
  });

  it("records a core text equal to a pack code literal as a codeMatches entry; a JSON-declared text stays a matches entry", async () => {
    const m = await gate();
    const scan = m.scanDeclaredTextCore(repoWithCode());
    expect(scan.matches).toEqual(EXPECTED_MATCHES);
    expect(scan.codeMatches).toEqual(EXPECTED_CODE_MATCHES);
    expect(scan.owners[`src/lib/pack-code-texts.ts :: ${CODE_JSX}`]).toEqual(["@example-org/notes-agent"]);
  });

  it("an extension code file that does not parse is a scanner error naming the file", async () => {
    const m = await gate();
    const root = repoWithCode();
    put(root, "extensions/example-org/notes-agent/src/broken.ts", "export const = ;\n");
    expect(() => m.scanDeclaredTextCore(root)).toThrow(/notes-agent\/src\/broken\.ts/);
    expect(() => m.scanDeclaredTextCore(root)).toThrow(m.DeclaredTextScanError);
  });

  it("the writer seeds codeMatches into a floor without the section, and afterwards a new code match fails", async () => {
    const m = await gate();
    const quiet = { log() {}, error() {} };
    const root = repoWithCode();
    const floorPath = join(root, m.FLOOR_REL);
    mkdirSync(dirname(floorPath), { recursive: true });
    writeFileSync(floorPath, `${JSON.stringify({ note: "a stage 1 floor", matches: EXPECTED_MATCHES }, null, 2)}\n`);
    expect(m.main(["--repo-root", root], { env: {}, out: quiet })).toBe(1); // the code matches are not on the floor
    expect(m.main(["--repo-root", root, "--write-baseline"], { env: {}, out: quiet })).toBe(0);
    const written = JSON.parse(readFileSync(floorPath, "utf8"));
    expect(written.matches).toEqual(EXPECTED_MATCHES);
    expect(written.codeMatches).toEqual(EXPECTED_CODE_MATCHES);
    expect(m.main(["--repo-root", root], { env: {}, out: quiet })).toBe(0);
    put(root, "src/lib/more-code.ts", `export const y = ${JSON.stringify(CODE_TEMPLATE)};\n`);
    expect(m.main(["--repo-root", root], { env: {}, out: quiet })).toBe(1);
    expect(m.main(["--repo-root", root, "--write-baseline"], { env: {}, out: quiet })).toBe(1); // never raised
    expect(JSON.parse(readFileSync(floorPath, "utf8")).codeMatches).toEqual(EXPECTED_CODE_MATCHES);
  });

  it("the base guard: a base without codeMatches seeds it once; then it only shrinks and is never removed; matches never seeds", async () => {
    const m = await gate();
    expect(m.parseFloorDocument, "the gate exports parseFloorDocument, the two-section floor reader").toBeTypeOf("function");
    const tree = treeFiles(fixtureRepo());
    const codeKey = "packages/notes/src/other.ts :: This sentence lives only in the pack's own source code.";
    const declKey = "src/lib/notes.ts :: Choose how many notes the digest may carry at most.";
    const run = (baseFloorText, headFloorText) => {
      const repo = makeFloorRepo({ base: { ...tree, [m.FLOOR_REL]: baseFloorText }, head: { [m.FLOOR_REL]: headFloorText } });
      try {
        const doc = m.parseFloorDocument(headFloorText);
        return m.checkFloorAgainstBase({
          repoRoot: repo.root,
          env: { ...PULL_REQUEST_RUN, FLOOR_BASE_FETCH: "0" },
          headFloor: doc.matches,
          headCodeFloor: doc.codeMatches,
        });
      } finally {
        repo.cleanup();
      }
    };
    const stage1Base = `${JSON.stringify({ note: "stage 1", matches: {} }, null, 2)}\n`;
    const seeded = run(stage1Base, m.floorDocument({}, { [codeKey]: 1 }));
    expect(seeded.ok, seeded.lines.join("\n")).toBe(true);
    expect(seeded.lines.join("\n")).toMatch(/seeds it with 1 entr/);
    const declGrew = run(stage1Base, m.floorDocument({ [declKey]: 1 }, { [codeKey]: 1 }));
    expect(declGrew.ok).toBe(false);
    expect(declGrew.growth).toEqual([`${declKey} (0 -> 1)`]);
    const codeGrew = run(m.floorDocument({}, {}), m.floorDocument({}, { [codeKey]: 1 }));
    expect(codeGrew.ok).toBe(false);
    expect(codeGrew.growth).toEqual([`codeMatches: ${codeKey} (0 -> 1)`]);
    const raised = run(m.floorDocument({}, { [codeKey]: 1 }), m.floorDocument({}, { [codeKey]: 2 }));
    expect(raised.growth).toEqual([`codeMatches: ${codeKey} (1 -> 2)`]);
    const shrunk = run(m.floorDocument({}, { [codeKey]: 2 }), m.floorDocument({}, { [codeKey]: 1 }));
    expect(shrunk.ok, shrunk.lines.join("\n")).toBe(true);
    const removed = run(m.floorDocument({}, { [codeKey]: 1 }), stage1Base);
    expect(removed.ok).toBe(false);
    expect(removed.growth.join("\n")).toMatch(/codeMatches: the section is removed/);
  });
});

/** Every file under `root` as a { repo-relative path: text } map. */
function treeFiles(root, dir = root, out = {}) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) treeFiles(root, abs, out);
    else out[relative(root, abs).split("\\").join("/")] = readFileSync(abs, "utf8");
  }
  return out;
}

describe("the record check (the function the test of record runs)", () => {
  it("on a pull request's run, refuses a list that grew against the base together with its new core literal", async () => {
    const m = await gate();
    expect(m.checkRecord, "the gate exports checkRecord, the test of record's check").toBeTypeOf("function");
    const tree = treeFiles(fixtureRepo());
    for (const core of ["src/lib/notes.ts", "src/app/notes/page.tsx", "packages/notes/src/help.ts", "packages/notes/src/other.ts"]) delete tree[core];
    const key = "src/lib/notes.ts :: Choose how many notes the digest may carry at most.";
    const repo = makeFloorRepo({
      base: { ...tree, [m.FLOOR_REL]: m.floorDocument({}) },
      head: { "src/lib/notes.ts": `export const a = "${DECLARED_FIELD}";\n`, [m.FLOOR_REL]: m.floorDocument({ [key]: 1 }) },
    });
    try {
      const pr = m.checkRecord({ repoRoot: repo.root, env: { ...PULL_REQUEST_RUN, FLOOR_BASE_FETCH: "0" } });
      expect(pr.grown).toEqual([]);
      expect(pr.stale).toEqual([]);
      expect(pr.guard.ok, pr.guard.lines.join("\n")).toBe(false);
      expect(pr.guard.status).toBe("grew");
      expect(pr.guard.growth).toEqual([`${key} (0 -> 1)`]);
      const push = m.checkRecord({ repoRoot: repo.root, env: { ...NO_PULL_REQUEST_RUN } });
      expect(push.guard.status).toBe("no-base");
      const unreadable = m.checkRecord({
        repoRoot: repo.root,
        env: { GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "no-such-base-4533", FLOOR_BASE_FETCH: "0" },
      });
      expect(unreadable.guard.ok).toBe(false);
    } finally {
      repo.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// TEST OF RECORD: the real tree against the committed floor and, on a pull
// request's run (GITHUB_BASE_REF, GITHUB_EVENT_NAME), the floor against the
// base: a list that grew against the base fails, a base that cannot be read
// fails.
// ---------------------------------------------------------------------------

function realTreeEmpty() {
  const ext = join(REAL_ROOT, "extensions");
  if (!existsSync(ext)) return true;
  try {
    return readdirSync(ext).length === 0;
  } catch {
    return true;
  }
}
const REAL_TREE_EMPTY = realTreeEmpty();

describe("test of record", () => {
  it.skipIf(REAL_TREE_EMPTY && !process.env.CI)(
    "core spells no declared text beyond the committed floor, and the floor holds no stale entry",
    async () => {
      const m = await gate();
      if (REAL_TREE_EMPTY) {
        throw new Error("the extension tree is not materialized on a CI run; clone it back before the root suite");
      }
      const { grown, stale, guard } = m.checkRecord({ repoRoot: REAL_ROOT, env: process.env });
      expect(grown, "core spells a text an extension declares; the extension supplies its own text").toEqual([]);
      expect(stale, "a recorded match is gone; lower the floor with --write-baseline").toEqual([]);
      expect(guard.ok, guard.lines.join("\n")).toBe(true);
      if (["pull_request", "pull_request_target"].includes(process.env.GITHUB_EVENT_NAME ?? "")) {
        expect(guard.status, "a pull request's run compares the floor with its base").not.toBe("no-base");
      }
    },
    RECORD_TIMEOUT,
  );
});
