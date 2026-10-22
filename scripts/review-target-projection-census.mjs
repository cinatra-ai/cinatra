#!/usr/bin/env node
// THE REVIEW TARGET'S PROJECTION CENSUS — a WARN-ONLY cross-check. It never
// fails a build.
//
// A review gate pins its targets by identity (an artifact id and the
// representation revision id it froze). One section of the protocol's
// lifecycle cards (`BEGIN review-target-projection` … `END
// review-target-projection`) makes every form of that identity. A target
// leaves the section as a `ReviewTargetKey`, a compile-time label whose runtime
// value is the revision id: the type refuses the common slips (a template, `+`,
// a comparison with text, text in a key's place), and a deliberate string
// operation still compiles. A text search can never prove that boundary,
// because it cannot see map keys, JSX attributes, joins or equality read-back;
// this script does not try to.
//
// What it does is list, as warnings, some lines the type does not see: a cast
// that mints a key, a template that wraps an id or a section call, a data
// attribute that names an id, the island's target parameter read outside the
// section, a per-target address set indexed or serialized by hand, and the
// projection primitives (an encoder, a query builder or reader, a URL parse, a
// version-pinned path, an iframe, a React key) in a file that names a target
// field. Each hit is classified:
//
//   MODULE      inside the projection section itself;
//   EXEMPT      a rule below names the file and the line, and says why it is
//               no projection of a review target, or that the line hands on a
//               form the section made whole;
//   UNLISTED    none of these: printed as a warning.
//
// A rule that matches no hit is STALE, and is printed as a warning too. The
// census is not complete and claims no completeness; no committed snapshot of
// it exists.
//
//   node scripts/review-target-projection-census.mjs            (warnings)
//   node scripts/review-target-projection-census.mjs --brief <dir>
//
// `--brief` writes every hit with its line number (`census.tsv`) and the
// per-file sweep (`sweep-files.tsv`) into <dir>.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MODULE_FILE = "packages/agent-ui-protocol/src/renderable-views/lifecycle-cards.ts";
const BEGIN_MARK = "// BEGIN review-target-projection";
const END_MARK = "// END review-target-projection";

/** A file is searched when it names a review target's identity, its headers
 *  or its island. */
export const TARGET_FIELD =
  /representationRevisionId|captureArtifactId|pinnedTargets|targetHeaders|islandSrc|REVIEW_ISLAND|REVIEW_TARGET_ISLAND_PATH|\/lifecycle\/review-island/;

/** The names an id is carried under. */
const ID_NAME = /(?:revisionId|RevisionId|artifactId|ArtifactId|\btarget\b)/;

/** The primitives a projection is made of, by kind. */
export const PRIMITIVES = [
  ["encode", /\bencodeURI(?:Component)?\(/],
  ["query-build", /\bURLSearchParams\b/],
  ["url-parse", /\bnew URL\(/],
  ["query-read", /\bsearchParams\.get\(|\bsp\[/],
  ["version-path", /\/versions\//],
  ["id-template", { test: (line) => idTemplates(line) }],
  ["iframe", /^\s*<iframe\b/],
  ["react-key", /\bkey=\{/],
  ["id-clamp", /(?:revisionId|RevisionId)\.slice\(|\bclamp\(\s*[\w.]*(?:revisionId|RevisionId)/],
  // The hatches a type cannot see.
  ["key-cast", /\bas\s+(?:unknown\s+as\s+)?ReviewTargetKey\b/],
  ["data-identity", /\bdata-[\w-]+=\{[^}]*(?:revisionId|RevisionId|artifactId|ArtifactId|\btarget\b)/],
  ["target-param", /\bREVIEW_ISLAND_TARGET_QUERY_PARAM\b/],
  [
    "address-set",
    /\bislandSrcByRevision\s*(?:\?\.)?\[|\b(?:Object\.(?:keys|values|entries|fromEntries)|JSON\.stringify)\([^)]*\bislandSrcByRevision\b/,
  ],
];

/**
 * WHY A HIT IS NO PROJECTION OF A REVIEW TARGET. Each rule names one file and
 * a substring of the hit's line, and only silences that line's warning; a rule
 * that matches no hit is printed as STALE.
 */
export const NOT_TARGET_RULES = [
  // --- the card: no target id in these values
  ["packages/agents/src/review-gate-card.tsx", "new URL(src, window.location.href).origin", "reads the frame's ORIGIN for the message wall; no target id is read"],
  ["packages/agents/src/review-gate-card.tsx", "new URL(current.src).origin", "reads the frame's ORIGIN for the message wall; no target id is read"],
  ["packages/agents/src/review-gate-card.tsx", "key={decisionGeneration}", "keys the decision bar by the decision generation, not a target"],
  ["packages/agents/src/review-gate-card.tsx", "key={s.id}", "keys a suggestion chip by the suggestion's id, not a target"],
  ["packages/agents/src/review-gate-card.tsx", "key={entry.id}", "keys a run-window entry by its id, not a target"],
  ["packages/agents/src/review-gate-card.tsx", "key={placement.keys[index]}", "the pair key reviewTargetPairKey made in placePairs"],
  ["packages/agents/src/review-gate-card.tsx", "<iframe", "the island frame; its src is an address composeReviewIslandAddress made"],
  ["packages/agents/src/review-gate-card.tsx", "key={reviewIslandFrameKey(load.identity, load.attempt)}", "the frame key reviewIslandFrameKey made whole; nothing wraps it"],
  ["packages/agents/src/review-gate-card.tsx", "key={reviewTargetHeaderKey(index, header)}", "the header key reviewTargetHeaderKey made whole; nothing wraps it"],
  // --- the island: reads what the module composed, or values with no target id
  ["src/app/lifecycle/review-island/page.tsx", "sp[REVIEW_ISLAND_CREDENTIAL_QUERY_PARAM]", "reads the island credential, not a target id"],
  ["src/app/lifecycle/review-island/page.tsx", "sp[REVIEW_ISLAND_COLOR_SCHEME_PARAM]", "reads the color scheme, not a target id"],
  ["src/app/lifecycle/review-island/page.tsx", "key={reviewTargetStreamKey(index, stream.target)}", "the stream key reviewTargetStreamKey made whole; nothing wraps it"],
  ["src/lib/lifecycle/review-island-credential.ts", "?ref=${encodeURIComponent(input.ref)}", "the island's BASE address carries the gate ref and no target id; a target joins it only through withReviewIslandTarget, which bounds the final address"],
  ["src/lib/lifecycle/review-island-credential.ts", "=${encodeURIComponent(input.credential)}", "the island's BASE address carries the credential and no target id; a target joins it only through withReviewIslandTarget"],
  ["src/lib/auth-route-guard.ts", "searchParams.get(REVIEW_ISLAND_CREDENTIAL_PARAM)", "reads the island credential, not a target id"],
  ["src/lib/auth-route-guard.ts", "searchParams.get(\"assistant\")", "reads the widget frame's assistant, not a target id"],
  ["src/lib/auth-route-guard.ts", "searchParams.get(\"instanceId\")", "reads the widget frame's instance, not a target id"],
  ["src/lib/auth-route-guard.ts", "new URL(buildSignInPath(currentPath), request.url)", "the sign-in redirect for the request's own path"],
  // --- sealed capabilities: the token is opaque and carries the ids sealed inside
  ["src/lib/lifecycle/review-island-byte-capability.ts", "encodeURIComponent(capability)", "encodes a sealed byte capability token, not a target id"],
  ["src/lib/lifecycle/capture-capability.ts", "encodeURIComponent(encoded)", "encodes a sealed capture capability token, not a target id"],
  ["src/app/api/lifecycle-views/artifact-bytes/route.ts", "const url = new URL(request.url);", "parses the request's own address to read the capability"],
  ["src/app/api/lifecycle-views/artifact-bytes/route.ts", "searchParams.get(REVIEW_ISLAND_BYTE_CAPABILITY_QUERY_PARAM)", "reads the sealed byte capability, not a target id"],
  ["src/app/api/lifecycle-views/artifact-bytes/route.ts", "const filename = `artifact-${decision.capability.artifactId}`;", "the download filename handed to the disposition helper, from the capability's sealed server-minted id"],
  ["src/app/api/lifecycle-views/capture/route.ts", "const url = new URL(request.url);", "parses the request's own address to read the capability"],
  ["src/app/api/lifecycle-views/capture/route.ts", "searchParams.get(CAPTURE_CAPABILITY_QUERY_PARAM)", "reads the sealed capture capability, not a target id"],
  // --- the artifact page: its own head revision, which no gate pins
  ["src/app/artifacts/[id]/page.tsx", "/versions/${revisionId}/", "the artifact page's own head revision under the page's route id; no review gate pins it"],
  // --- internal keys and hash material: never an address, a drawn key or a header
  ["packages/agents/src/lifecycle-repair-store.ts", "`${t.artifactId.length}:${t.artifactId}:${t.representationRevisionId}`", "a length-prefixed set key for dedupe; never an address, a key a surface draws by, or a header"],
  ["packages/agents/src/lifecycle-review-orchestration-store.ts", "`${t.artifactId.length}:${t.artifactId}:${t.representationRevisionId}`", "a length-prefixed set key for dedupe; never an address, a key a surface draws by, or a header"],
  ["src/lib/lifecycle/lifecycle-batch.ts", "`${t.artifactId.length}:${t.artifactId}:${t.representationRevisionId}`", "a length-prefixed set key for dedupe; never an address, a key a surface draws by, or a header"],
  ["src/lib/lifecycle/lifecycle-orchestration.ts", "`${t.artifactId.length}:${t.artifactId}:${t.representationRevisionId}`", "a length-prefixed set key for dedupe; never an address, a key a surface draws by, or a header"],
  ["src/lib/artifacts/artifact-review-target.ts", "return `${target.artifactId}", "the target set's equality key; parsing refuses an id that embeds its NUL separator; never an address, a drawn key or a header"],
  ["src/lib/artifacts/artifact-refs-store.ts", "`${r.artifactId}::${r.representationRevisionId}`", "a reference row's membership key inside one store call; never an address, a drawn key or a header"],
  ["src/lib/artifacts/artifact-refs-store.ts", "`${a.artifactId}::${a.representationRevisionId}`", "a reference row's membership key inside one store call; never an address, a drawn key or a header"],
  ["src/lib/artifacts/artifact-revision-append.ts", "#append:", "the append ledger's output id; never an address, a drawn key or a header"],
  ["src/lib/artifacts/cms-preview-capture-store.ts", ".update(`${boundArtifactId}", "hash material for a capture's digest; never an address, a drawn key or a header"],
  ["src/lib/lifecycle/lifecycle-produced-event.ts", "const material = `${artifactId}", "hash material for an event id; never an address, a drawn key or a header"],
  ["src/lib/lifecycle/lifecycle-suggestion-producer.ts", "idScope: `${entry.target.artifactId}", "the scope a suggestion id is hashed under; never an address, a drawn key or a header"],
  ["src/lib/lifecycle/lifecycle-suggestion-producer.ts", "const key = `${t.target.artifactId}", "a length-prefixed set key for dedupe; never an address, a key a surface draws by, or a header"],
  ["src/lib/artifacts/matcher-enqueue.ts", "artifact-match__", "the matcher job's id; never an address, a drawn key or a header"],
  ["src/lib/artifacts/matcher-runtime.ts", "return `${args.artifactId}${ext}`;", "the stored file name of a matched artifact's bytes; never an address, a drawn key or a header"],
  ["src/lib/cms-review-host-seam.ts", ":post-apply`", "a verification record's synthetic post-apply revision, stored as plain text; no gate pins it"],
  ["src/lib/lifecycle/lifecycle-card-refetch.ts", "clamp(reviewedRevisionId,", "bounds a verification summary's display text; a verification record's revision, not a gate's pin"],
  ["src/lib/lifecycle/lifecycle-card-refetch.ts", "clamp(repairedRevisionId,", "bounds a verification summary's display text; a verification record's revision, not a gate's pin"],
  // --- the context selector: a selection candidate (artifact, revision AND assertion), not a gate's pin
  ["packages/agents/src/context-selector-renderer.tsx", "`${r.artifactId}|${r.representationRevisionId}|${r.semanticAssertionId}`", "a context-selection candidate's identity; the selector is no review gate"],
  ["packages/agents/src/context-selector-renderer.tsx", "key={group.scope}", "keys a candidate group by its scope name"],
  ["packages/agents/src/context-selector-renderer.tsx", "key={key}", "keys a context-selection candidate by its identity above; the selector is no review gate"],
  ["src/lib/artifacts/context-allocation-planner.ts", "`${r.artifactId}|${r.representationRevisionId}|${r.semanticAssertionId}`", "a context-selection triple's key; never an address, a drawn key or a header"],
  ["src/lib/artifacts/context-route-support.ts", "`${r.artifactId}|${r.representationRevisionId}|${r.semanticAssertionId}`", "a context-selection triple's key; never an address, a drawn key or a header"],
  // --- other surfaces: the encoded or keyed value is no artifact id at all
  ["packages/agents/src/execution.ts", "RUN_STEP_QUERY_KEY}=${encodeURIComponent(step)}", "a run step's name in the run page's query"],
  ["packages/agents/src/execution.ts", "${encodeURIComponent(id)}`,", "an organization, team or project id in its page path"],
  ["packages/agents/src/execution.ts", "/agents/unknown/unknown/${encodeURIComponent(runId)}", "a run id in its page path"],
  ["packages/agents/src/instance-screens.tsx", "/configuration/marketplace/${encodeURIComponent(match[1])}", "an extension's package name in its marketplace path"],
  ["packages/agents/src/instance-screens.tsx", "buildAgentInstancePath(", "an agent run or instance id in its page path"],
  ["packages/agents/src/instance-screens.tsx", ": encodeURIComponent(agentId);", "an agent id in its page path"],
  ["packages/agents/src/instance-screens.tsx", "key={entry.reviewTaskId}", "keys a verification card by its review task id"],
  ["packages/agents/src/instance-screens.tsx", "key={run.id}", "keys the run rail by the run id"],
  ["packages/agents/src/hitl-conversation-panel.tsx", "key={entry.id}", "keys a conversation entry by its id"],
  ["packages/chat/src/ag-ui-chat-client.ts", "/api/assistants/runs/${encodeURIComponent(runId)}/stream", "a run id in its stream path"],
  ["packages/objects/src/connector-ref.ts", "parsed = new URL(raw);", "checks that a connector's address is http(s)"],
  ["src/components/app-shell.tsx", "new URLSearchParams(window.location.search).get(", "reads the shell's own embed and section flags"],
  ["src/components/app-shell.tsx", "key={breadcrumbCrumbKey(crumb, i)}", "keys a breadcrumb"],
  ["src/components/app-shell.tsx", "key={id}", "keys an LLM provider button by the provider's name"],
];

const SKIP_DIRS = new Set(["node_modules", "dist", ".next", "build", "coverage", "__tests__", "__mocks__", "e2e"]);
const CODE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.(?:test|spec|stories)\.[^.]+$|\.d\.ts$/;

function walk(dir, out) {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (CODE_EXT.test(name) && !TEST_FILE.test(name)) out.push(full);
  }
}

/** The searched roots: the application and every workspace package's source. */
export function searchedFiles(root = ROOT) {
  const files = [];
  walk(path.join(root, "src"), files);
  const packages = path.join(root, "packages");
  for (const name of readdirSync(packages).sort()) {
    const src = path.join(packages, name, "src");
    if (existsSync(src) && statSync(src).isDirectory()) walk(src, files);
  }
  return files.map((file) => path.relative(root, file).split(path.sep).join("/")).sort();
}

/** The exported projections of the section, read from the section itself. */
export function moduleProjections(root = ROOT) {
  const text = readFileSync(path.join(root, MODULE_FILE), "utf8");
  const begin = text.indexOf(BEGIN_MARK);
  const end = text.indexOf(END_MARK);
  if (begin < 0 || end < begin) throw new Error(`${MODULE_FILE}: the projection section's markers are missing`);
  const names = [...text.slice(begin, end).matchAll(/^export function (\w+)/gm)].map((m) => m[1]);
  if (names.length === 0) throw new Error(`${MODULE_FILE}: the projection section exports nothing`);
  return names.sort();
}

const isCommentLine = (line) => /^\s*(?:\/\/|\/\*|\*)/.test(line);

/** The line without a trailing ` // ` comment (a URL's `://` is kept). */
const codeOf = (line) => line.replace(/\s\/\/\s.*$/, "");

/**
 * An id interpolated into a string that is a FORM of it (a key, a path, a
 * query), not a sentence about it: a template literal whose static text has no
 * whitespace and that interpolates an id. A message (`artifact ${id} not
 * found`) names the id to a reader and is no projection.
 */
function idTemplates(line) {
  for (const match of line.matchAll(/`([^`]*)`?/g)) {
    const literal = match[1];
    const holes = [...literal.matchAll(/\$\{([^}]*)\}/g)];
    if (!holes.some((hole) => ID_NAME.test(hole[1]))) continue;
    if (/\s/.test(literal.replace(/\$\{[^}]*\}/g, ""))) continue;
    return true;
  }
  return false;
}

/** Every primitive hit, classified. */
export function census(root = ROOT) {
  const projections = moduleProjections(root);
  const hits = [];
  for (const rel of searchedFiles(root)) {
    const text = readFileSync(path.join(root, rel), "utf8");
    if (!TARGET_FIELD.test(text)) continue;
    const lines = text.split("\n");
    let inModule = false;
    lines.forEach((line, index) => {
      if (rel === MODULE_FILE && line.startsWith(BEGIN_MARK)) inModule = true;
      if (rel === MODULE_FILE && line.startsWith(END_MARK)) inModule = false;
      if (isCommentLine(line)) return;
      const code = codeOf(line);
      const kinds = PRIMITIVES.filter(([, re]) => re.test(code)).map(([kind]) => kind);
      if (kinds.length === 0) return;
      const textOf = code.trim();
      let outcome;
      if (inModule) outcome = "MODULE";
      else {
        const rule = NOT_TARGET_RULES.find(([file, needle]) => file === rel && code.includes(needle));
        outcome = rule ? `EXEMPT: ${rule[2]}` : "UNLISTED";
      }
      hits.push({ path: rel, line: index + 1, kinds: kinds.join(","), outcome, text: textOf });
    });
  }
  const stale = NOT_TARGET_RULES.filter(
    ([file, needle]) => !hits.some((hit) => hit.path === file && hit.text.includes(needle.trim())),
  );
  return { hits, stale, projections };
}

/** A line as one TSV cell: every control character (a tab, a NUL) escaped,
 *  so the census stays one row per hit and plain text. */
const clean = (value) =>
  value.replace(/[\u0000-\u001f\u007f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

function main(argv) {
  const mode = argv[0];
  const { hits, stale } = census();
  const unlisted = hits.filter((hit) => hit.outcome === "UNLISTED");
  if (mode === "--brief") {
    const dir = argv[1];
    if (!dir) throw new Error("--brief needs a directory");
    mkdirSync(dir, { recursive: true });
    const rows = hits.map((hit) => [`${hit.path}:${hit.line}`, hit.kinds, hit.outcome, clean(hit.text)].join("\t"));
    writeFileSync(path.join(dir, "census.tsv"), `site\tkinds\toutcome\ttext\n${rows.join("\n")}\n`);
    const byFile = new Map();
    for (const hit of hits) byFile.set(hit.path, [...(byFile.get(hit.path) ?? []), hit]);
    const sweep = [...byFile].map(([file, list]) => {
      const outcomes = [...new Set(list.map((hit) => hit.outcome.split(":")[0]))].sort().join(",");
      return [file, list.length, outcomes].join("\t");
    });
    writeFileSync(path.join(dir, "sweep-files.tsv"), `path\thits\toutcomes\n${sweep.join("\n")}\n`);
  }
  for (const hit of unlisted) console.warn(`WARN UNLISTED ${hit.path}:${hit.line} [${hit.kinds}] ${hit.text}`);
  for (const [file, needle] of stale) console.warn(`WARN STALE RULE ${file}: ${needle}`);
  console.log(`hits ${hits.length} unlisted ${unlisted.length} stale ${stale.length} (warnings only)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
