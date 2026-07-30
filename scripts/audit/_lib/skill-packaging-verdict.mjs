// ---------------------------------------------------------------------------
// THE SKILL-PACKAGING VERDICT (cinatra#2089, epic #2086 S2).
//
// One module decides whether a skill bundle / a `kind:"skill"` extension / a
// non-skill extension conforms to the Anthropic-schema packaging contract. It
// is consumed IDENTICALLY by:
//
//   - CI            — `scripts/audit/skill-packaging-gate.mjs` (+ the
//                     frontmatter half re-exported into
//                     `scripts/audit/skill-frontmatter-gate.mjs`, so the two
//                     gates can never disagree about a SKILL.md);
//   - store install — `src/lib/skill-packaging-install-gate.ts`, the pipeline's
//                     pre-journal (inert) seam;
//   - publish       — the extension repos' `extension-kind-gate.mjs`, which
//                     VENDORS this file verbatim (see the vendoring contract
//                     below).
//
// so a non-conforming extension gets THE SAME verdict text at all three points.
//
// ── ZERO-DEPENDENCY, PURE ──────────────────────────────────────────────────
// Node builtins only — in fact no imports at all: every entry point takes data
// (strings, arrays) and returns violations. Two hard reasons:
//   1. The audit lane runs pure `node` with NO `pnpm install`; `yaml` is a
//      packages/skills dependency and pnpm's strict node_modules does not hoist
//      it, so a YAML library is unavailable (the pre-existing
//      skill-frontmatter-gate already carries this constraint).
//   2. A public extension repo's CI runs unauthenticated and BEFORE the
//      @cinatra-ai registry is reachable, so the gate that ships into those
//      repos cannot resolve any package.
// Purity is also what makes the store-install seam able to import it from TS.
//
// ── VENDORING CONTRACT ─────────────────────────────────────────────────────
// This file is the ORIGIN. `create-cinatra-extension` copies it verbatim into
// `templates/_shared/` and each scaffolded repo's `extension-kind-gate.mjs`
// imports it. A copy is identified by the `VERDICT_CONTRACT_VERSION` below:
// changing any RULE (not a comment) bumps it, and the extension-repo gate
// reports the version it ran, so a stale vendored copy is visible rather than
// silently lenient.
// ---------------------------------------------------------------------------

/** Bumped whenever a RULE changes. Reported by every consumer. */
export const VERDICT_CONTRACT_VERSION = 1;

// ---------------------------------------------------------------------------
// Constants — each mirrors an authority elsewhere in the tree and is pinned to
// it by an agreement test (see scripts/audit/__tests__/skill-packaging-gate.test.mjs).
// ---------------------------------------------------------------------------

/**
 * The ONLY top-level SKILL.md frontmatter keys the upstream Anthropic validator
 * (`skill-creator/quick_validate.py`) permits. Cinatra semantics (match rules,
 * watches, requires_execution, capability ids, role) live UNDER `metadata:` or,
 * preferably, in the extension manifest — never at top level.
 */
export const ALLOWED_FRONTMATTER_KEYS = Object.freeze([
  "name",
  "description",
  "license",
  "allowed-tools",
  "metadata",
  "compatibility",
]);

/** The router file every bundle carries exactly one of. */
export const SKILL_ROUTER_FILENAME = "SKILL.md";

/**
 * The router is a ROUTER: it points at one-hop reference files rather than
 * inlining a manual. The issue's own bound.
 */
export const SKILL_ROUTER_MAX_LINES = 500;

/**
 * Boundary rule (S0, #2087): reject when EITHER the archive bytes OR the
 * uncompressed file total REACHES this value.
 *
 * MIRRORS `ANTHROPIC_SKILL_MAX_UPLOAD_BYTES` in
 * packages/llm/src/tools/anthropic-skill-content-hash.ts, and the
 * "agreement pins" test in `__tests__/skill-packaging-gate.test.mjs` asserts the
 * two are equal — a packaging gate that rejected at a different size than the
 * uploader would either pass bundles the upload then refuses, or refuse bundles
 * the API accepts.
 *
 * Raised 30,000,000 -> 31,457,280 (30 MiB) with the S7 live evidence
 * (cinatra#2094): the API ACCEPTED a rooted canonical zip the old value rejected,
 * so it was a confirmed client-side false rejection. Read the full grounding on
 * the mirrored constant — in particular that 31,457,280 is the docs-based POLICY
 * reading of "under 30 MB", consistent with but not derived from the measurement
 * (which bounds only a lower edge). Change both constants together or the
 * agreement pin fails.
 */
export const SKILL_BUNDLE_MAX_BYTES = 31_457_280;

/** A `kind:"skill"` package name is SINGULAR: `@<scope>/<slug>-skill`. */
export const SKILL_PACKAGE_NAME_RE = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*-skill$/;

/**
 * The manifest-carried skill ROLE (the cinatra semantics that used to sit in
 * frontmatter):
 *   - `injectable` — counts toward the injection cap; upload-eligible;
 *   - `matcher`    — consumed by artifact/agent matching, not injected as prose;
 *   - `internal`   — pipeline-consumed; NEVER injected, NEVER uploaded.
 */
export const SKILL_ROLES = Object.freeze(["injectable", "matcher", "internal"]);

/** Every violation code this module can emit (the stable verdict vocabulary). */
export const VIOLATION_CODES = Object.freeze([
  "invalid-frontmatter",
  "bundle-name-mismatch",
  "router-too-long",
  "dangling-reference",
  "bundle-oversize",
  "package-suffix",
  "not-exactly-one-bundle",
  "stray-skill-md",
  "invalid-skill-role",
  "skill-md-in-non-skill-package",
]);

// ---------------------------------------------------------------------------
// Frontmatter — the dependency-free strict reader.
//
// STRICTNESS IS THE POINT (#2089): a malformed SKILL.md used to fail QUIET
// (`parseSkillFrontmatterYaml` returns undefined and the skill silently loses
// its rules). Here every malformed shape is a NAMED reason string, and every
// consumer treats a reason as a hard error.
// ---------------------------------------------------------------------------

/** Strip one layer of matching surrounding quotes from a scalar. */
function unquoteScalar(raw) {
  const v = raw.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * A bare (unquoted) scalar containing `: ` or ending with `:` is the YAML
 * "mapping values are not allowed here" error the upstream validator reports.
 */
function unquotedScalarHasMappingColon(raw) {
  const v = raw.trim();
  if (!v) return false;
  if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) return false;
  return /:\s/.test(v) || /:$/.test(v);
}

/**
 * Read a SKILL.md's frontmatter STRICTLY. Returns
 * `{ ok: true, topLevel: Map<string, string|null> }` (value `null` = nested
 * mapping/list) or `{ ok: false, reason }`. Never throws, never returns a
 * partially-understood document.
 */
export function readSkillFrontmatterStrict(content) {
  if (typeof content !== "string") return { ok: false, reason: "SKILL.md is not text" };
  if (!content.startsWith("---")) return { ok: false, reason: "No YAML frontmatter found" };
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { ok: false, reason: "Invalid frontmatter format" };

  const lines = match[1].split(/\r?\n/);
  const topLevel = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.trimStart().startsWith("#")) continue; // comment
    if (/^\s/.test(line)) continue; // indented → nested under a top-level key
    const m = line.match(/^([^:\s][^:]*?):(.*)$/);
    if (!m) {
      return { ok: false, reason: `Invalid YAML in frontmatter: unexpected line "${line.trim()}"` };
    }
    const key = m[1].trim();
    const rest = m[2];
    const rawValue = rest.trim() === "" ? null : rest;
    if (rawValue !== null && unquotedScalarHasMappingColon(rawValue)) {
      return { ok: false, reason: "Invalid YAML in frontmatter: mapping values are not allowed here" };
    }
    if (topLevel.has(key)) {
      return { ok: false, reason: `Invalid YAML in frontmatter: duplicate top-level key "${key}"` };
    }
    topLevel.set(key, rawValue);
  }
  if (topLevel.size === 0) return { ok: false, reason: "Frontmatter must be a YAML dictionary" };
  return { ok: true, topLevel };
}

/**
 * Validate a SKILL.md's frontmatter against the Anthropic schema. Returns a
 * human-readable reason string, or `null` when valid.
 *
 * This IS the rule set the pre-existing `skill-frontmatter-gate` enforced; it
 * moved here so CI, store install and publish share one implementation.
 */
export function validateSkillFrontmatter(content) {
  const read = readSkillFrontmatterStrict(content);
  if (!read.ok) return read.reason;
  const { topLevel } = read;

  const allowed = new Set(ALLOWED_FRONTMATTER_KEYS);
  const unexpected = [...topLevel.keys()].filter((k) => !allowed.has(k));
  if (unexpected.length > 0) {
    return (
      `Unexpected key(s) in SKILL.md frontmatter: ${unexpected.sort().join(", ")}. ` +
      `Allowed properties are: ${[...allowed].sort().join(", ")} ` +
      `(move Cinatra-specific keys such as match_when under metadata.*).`
    );
  }

  if (!topLevel.has("name")) return "Missing 'name' in frontmatter";
  if (!topLevel.has("description")) return "Missing 'description' in frontmatter";

  const nameRaw = topLevel.get("name");
  if (nameRaw === null) return "Name must be a string, got object";
  const name = unquoteScalar(nameRaw);
  if (name) {
    if (!/^[a-z0-9-]+$/.test(name)) {
      return `Name '${name}' should be kebab-case (lowercase letters, digits, and hyphens only)`;
    }
    if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
      return `Name '${name}' cannot start/end with hyphen or contain consecutive hyphens`;
    }
    if (name.length > 64) {
      return `Name is too long (${name.length} characters). Maximum is 64 characters.`;
    }
  }

  const descRaw = topLevel.get("description");
  if (descRaw === null) return "Description must be a string, got object";
  const description = unquoteScalar(descRaw);
  if (description) {
    if (description.includes("<") || description.includes(">")) {
      return "Description cannot contain angle brackets (< or >)";
    }
    if (description.length > 1024) {
      return `Description is too long (${description.length} characters). Maximum is 1024 characters.`;
    }
  }

  if (topLevel.has("compatibility")) {
    const compatRaw = topLevel.get("compatibility");
    if (compatRaw !== null) {
      const compatibility = unquoteScalar(compatRaw);
      if (compatibility.length > 500) {
        return `Compatibility is too long (${compatibility.length} characters). Maximum is 500 characters.`;
      }
    }
  }

  return null;
}

/** The declared `name:` of a SKILL.md, or `null` when unreadable. */
export function readSkillFrontmatterName(content) {
  const read = readSkillFrontmatterStrict(content);
  if (!read.ok) return null;
  const raw = read.topLevel.get("name");
  if (raw === null || raw === undefined) return null;
  return unquoteScalar(raw);
}

// ---------------------------------------------------------------------------
// One-hop router reference lint.
//
// A FAITHFUL TWIN of `lintBundleRouterReferences` /
// `normalizeBundledRelPath` in `src/lib/skill-bundle-store.ts` (#2088, S1),
// which computed the same lint as a DIAGNOSTIC and explicitly handed
// fail-closed enforcement to S2. The two implementations are pinned together by
// an agreement test over a shared fixture matrix — do not change one alone.
// ---------------------------------------------------------------------------

/**
 * Normalize a bundled file's relative path: backslashes → `/`, `.` segments
 * dropped, absolute / `..`-traversal / empty paths REJECTED (throws).
 */
export function normalizeBundledRelPath(relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new Error("[skill-packaging] empty bundled file path");
  }
  const posix = relPath.replaceAll("\\", "/");
  if (posix.startsWith("/")) {
    throw new Error(`[skill-packaging] absolute bundled path rejected: ${relPath}`);
  }
  const segments = posix.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.some((s) => s === "..")) {
    throw new Error(`[skill-packaging] path traversal ('..') rejected: ${relPath}`);
  }
  if (segments.length === 0) {
    throw new Error(`[skill-packaging] bundled path resolves to empty: ${relPath}`);
  }
  return segments.join("/");
}

/**
 * Lint the router's ONE-HOP references: every relative file reference SKILL.md
 * names must resolve to a path present in the bundle. Returns
 * `{ ok, missing: string[] }`.
 *
 * Conservative by construction — only references that unambiguously name a
 * bundled file are considered (markdown links/images, and inline-code paths
 * containing a `/`); absolute URLs, root-absolute paths, in-page anchors and
 * bare tokens without a `/` are prose, not paths.
 */
export function lintRouterOneHopReferences(skillMd, bundlePaths) {
  const present = new Set();
  /** The bundle's own top-level directory names — see `fromInlineCode` below. */
  const bundleDirs = new Set();
  for (const p of bundlePaths) {
    try {
      const norm = normalizeBundledRelPath(p);
      present.add(norm);
      const slash = norm.indexOf("/");
      if (slash > 0) bundleDirs.add(norm.slice(0, slash));
    } catch {
      /* a malformed bundle path is reported by the bundle shape rules, not here */
    }
  }
  const missing = [];
  const seen = new Set();
  const consider = (raw, fromInlineCode) => {
    let target = raw.trim();
    if (!target) return;
    const sp = target.search(/\s/);
    if (sp >= 0) target = target.slice(0, sp); // drop a markdown link title
    if (target.startsWith("#")) return;
    if (target.startsWith("/")) return;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return; // scheme: (http:, mailto:, data:)
    if (target.startsWith("//")) return;
    // A `{placeholder}` / `<placeholder>` TEMPLATE is not a file.
    if (/[{}<>]/.test(target)) return;
    target = target.split("#")[0].split("?")[0];
    if (!target || !target.includes("/")) return; // no `/` ⇒ not a bundled path
    if (fromInlineCode) {
      // An inline-code span is the WEAKEST signal. A SKILL.md legitimately
      // shows JSON-RPC method names (`message/send`), IANA timezones
      // (`"Europe/Vienna"`), URL paths, and — for the authoring skills — paths
      // in the OTHER repo it teaches you to write (`cinatra/oas.json`,
      // `packages/agents/src/a2a-actions.ts`). None of those are bundled files,
      // and fail-closed enforcement (#2089) must not reject a correct skill for
      // them. So an inline-code reference counts as a BUNDLED path only when
      // all three hold:
      //   - it is unquoted,
      //   - its last segment carries a dotted extension (it names a FILE), and
      //   - its FIRST segment is a directory THIS BUNDLE actually ships.
      // The last rule is what separates "the router points at
      // `references/foo.md` and forgot to ship it" (the failure S1 named — the
      // bundle has a `references/` dir) from prose about another tree. A
      // MARKDOWN LINK target keeps the stricter treatment: an explicit
      // `[text](path)` link is a reference by construction, so a broken one is
      // reported whether or not the directory exists.
      if (/["'`]/.test(target)) return;
      const last = target.slice(target.lastIndexOf("/") + 1);
      if (!/^[^.].*\.[A-Za-z0-9]+$/.test(last)) return;
      if (!bundleDirs.has(target.slice(0, target.indexOf("/")))) return;
    }
    let norm;
    try {
      norm = normalizeBundledRelPath(target);
    } catch {
      if (!seen.has(target)) {
        seen.add(target);
        missing.push(target);
      }
      return;
    }
    if (!present.has(norm) && !seen.has(norm)) {
      seen.add(norm);
      missing.push(norm);
    }
  };

  const md = typeof skillMd === "string" ? skillMd : "";
  // SINGLE LEFT-TO-RIGHT PASS — deliberately not a regex. The obvious patterns
  // (`\[[^\]]*\]\(([^)]+)\)`) are polynomial-time on adversarial input, and a
  // SKILL.md arrives from an installed extension. Every `indexOf` result
  // advances the SAME cursor it searched from, so the pass is linear.
  // An UNTERMINATED span must not abort the pass: a stray "[x](" earlier in the
  // body used to `break`, hiding every later reference and failing the lint OPEN.
  // When a terminator is not found, none exists in the rest of the document
  // either — record that once and skip the branch from then on, so the scan
  // continues without ever re-searching (still exactly one pass).
  let i = 0;
  let openBracket = -1;
  let noMoreCloseParen = false;
  let noMoreBacktick = false;
  while (i < md.length) {
    const ch = md[i];
    if (ch === "[") {
      openBracket = i;
      i += 1;
      continue;
    }
    if (ch === "]" && openBracket >= 0 && md[i + 1] === "(" && !noMoreCloseParen) {
      const close = md.indexOf(")", i + 2);
      if (close === -1) {
        noMoreCloseParen = true;
        i += 1;
        continue;
      }
      consider(md.slice(i + 2, close), false);
      i = close + 1;
      openBracket = -1;
      continue;
    }
    if (ch === "`" && !noMoreBacktick) {
      const close = md.indexOf("`", i + 1);
      if (close === -1) {
        noMoreBacktick = true;
        i += 1;
        continue;
      }
      const inner = md.slice(i + 1, close).trim();
      if (inner.includes("/")) consider(inner, true);
      i = close + 1;
      continue;
    }
    i += 1;
  }

  return { ok: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// The shared fixture-allowlist policy.
//
// ONE artifact (`config/skill-fixture-allowlist.json`) is read identically by
// all three gates. Defaults: `**/__tests__/fixtures/**` and
// `**/tests/fixtures/**`. The scaffolder repo additionally allows
// `templates/**`. EXTENSION repos default to an EMPTY allowlist — no
// exceptions.
// ---------------------------------------------------------------------------

/**
 * Minimal, anchored glob matcher supporting `**` (any path segments, possibly
 * none) and `*` (any characters within one segment). Deliberately tiny: the
 * policy artifact's grammar is exactly these two wildcards.
 */
export function matchesGlob(relPath, pattern) {
  if (typeof relPath !== "string" || typeof pattern !== "string") return false;
  const segments = pattern.split("/");
  let re = "^";
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const isLast = i === segments.length - 1;
    if (seg === "**") {
      // `**` spans ZERO OR MORE whole segments — so `**/__tests__/fixtures/**`
      // matches a fixture tree at the package root as well as a nested one.
      re += isLast ? "(?:[^/]+(?:/[^/]+)*)?" : "(?:[^/]+/)*";
      continue;
    }
    re += seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*");
    if (!isLast) re += "/";
  }
  re += "$";
  return new RegExp(re).test(relPath);
}

/** True when `relPath` matches ANY pattern. An empty/absent list matches nothing. */
export function matchesAllowlist(relPath, patterns) {
  if (!Array.isArray(patterns)) return false;
  return patterns.some((p) => matchesGlob(relPath, p));
}

/**
 * Resolve the effective allowlist for a repo from the shared policy document.
 * `repoKey` is the repo's short name (e.g. `cinatra`,
 * `create-cinatra-extension`). An UNKNOWN repo resolves to the extension-repo
 * default: EMPTY (fail closed).
 */
export function resolveFixtureAllowlist(policy, repoKey) {
  const doc = policy && typeof policy === "object" ? policy : {};
  const overrides = doc.repoAllowlists && typeof doc.repoAllowlists === "object" ? doc.repoAllowlists : {};
  if (Object.prototype.hasOwnProperty.call(overrides, repoKey)) {
    const list = overrides[repoKey];
    return Array.isArray(list) ? [...list] : [];
  }
  return Array.isArray(doc.extensionRepoDefault) ? [...doc.extensionRepoDefault] : [];
}

// ---------------------------------------------------------------------------
// Bundle + package verdicts
// ---------------------------------------------------------------------------

function violation(code, message, path) {
  return path === undefined ? { code, message } : { code, message, path };
}

/**
 * Validate ONE skill bundle.
 *
 * @param {object} input
 * @param {string} input.dirName    the bundle DIRECTORY's own name
 * @param {string} input.routerText the SKILL.md router's text
 * @param {Array<{path: string, byteLength: number}>} input.files
 *        every file in the bundle, `path` relative to the bundle root
 *        (`SKILL.md` included)
 * @param {string} [input.label]    a display prefix for messages
 * @returns {Array<{code: string, message: string, path?: string}>}
 */
export function validateSkillBundle(input) {
  const { dirName, routerText, files } = input;
  const label = input.label ?? dirName;
  const out = [];

  const reason = validateSkillFrontmatter(routerText);
  if (reason) {
    out.push(violation("invalid-frontmatter", `${label}/SKILL.md: ${reason}`, label));
    // Without readable frontmatter the name-match rule below has nothing to
    // compare — the remaining structural rules still run.
  } else {
    const declared = readSkillFrontmatterName(routerText);
    if (declared !== null && declared !== dirName) {
      out.push(
        violation(
          "bundle-name-mismatch",
          `${label}: bundle directory name "${dirName}" must equal the SKILL.md frontmatter name "${declared}" ` +
            `(the uploaded bundle is rooted at the declared name; a mismatch uploads a differently-named skill).`,
          label,
        ),
      );
    }
  }

  const lineCount = typeof routerText === "string" ? routerText.split(/\r?\n/).length : 0;
  if (lineCount > SKILL_ROUTER_MAX_LINES) {
    out.push(
      violation(
        "router-too-long",
        `${label}/SKILL.md is ${lineCount} lines; a router must stay under ${SKILL_ROUTER_MAX_LINES} ` +
          `(move the detail into one-hop reference files the router points at).`,
        label,
      ),
    );
  }

  const paths = (files ?? []).map((f) => f.path);
  const lint = lintRouterOneHopReferences(routerText, paths);
  if (!lint.ok) {
    out.push(
      violation(
        "dangling-reference",
        `${label}/SKILL.md references ${lint.missing.length} file(s) that are not in the bundle: ` +
          `${lint.missing.join(", ")}. A router may only point one hop, at files it ships.`,
        label,
      ),
    );
  }

  const total = (files ?? []).reduce((n, f) => n + (Number(f.byteLength) || 0), 0);
  if (total >= SKILL_BUNDLE_MAX_BYTES) {
    out.push(
      violation(
        "bundle-oversize",
        `${label}: bundle is ${total} uncompressed bytes; the upload boundary rejects at ` +
          `${SKILL_BUNDLE_MAX_BYTES}.`,
        label,
      ),
    );
  }

  return out;
}

/**
 * Validate a `kind:"skill"` EXTENSION package.
 *
 * @param {object} input
 * @param {string} input.packageName
 * @param {object} input.manifest  the package.json `cinatra` block
 * @param {Array<{dirName: string, relDir: string, routerText: string, files: Array<{path: string, byteLength: number}>}>} input.bundles
 * @param {string[]} [input.straySkillMdPaths] SKILL.md paths NOT at a bundle root
 */
export function validateSkillExtensionPackage(input) {
  const { packageName, manifest, bundles } = input;
  const out = [];

  if (typeof packageName !== "string" || !SKILL_PACKAGE_NAME_RE.test(packageName)) {
    out.push(
      violation(
        "package-suffix",
        `package name must be SINGULAR \`@<scope>/<slug>-skill\` (got ${JSON.stringify(packageName)}). ` +
          `One extension ships one skill bundle, so the plural \`-skills\` name is retired.`,
      ),
    );
  }

  if (!Array.isArray(bundles) || bundles.length !== 1) {
    const n = Array.isArray(bundles) ? bundles.length : 0;
    out.push(
      violation(
        "not-exactly-one-bundle",
        `a kind:"skill" extension must ship EXACTLY ONE skill bundle (found ${n}` +
          `${n > 0 ? `: ${bundles.map((b) => b.relDir).join(", ")}` : ""}). ` +
          `Split a multi-skill pack into one extension per skill and wire the rest as dependency edges.`,
      ),
    );
  }

  for (const stray of input.straySkillMdPaths ?? []) {
    out.push(
      violation(
        "stray-skill-md",
        `${stray}: a SKILL.md outside the single \`skills/<name>/\` bundle root is not part of any bundle ` +
          `and would never be uploaded — remove it or make it the bundle's router.`,
        stray,
      ),
    );
  }

  const role = manifest && typeof manifest === "object" ? manifest.skillRole : undefined;
  if (role !== undefined && !SKILL_ROLES.includes(role)) {
    out.push(
      violation(
        "invalid-skill-role",
        `cinatra.skillRole must be one of ${SKILL_ROLES.join(" | ")} (got ${JSON.stringify(role)}).`,
      ),
    );
  }

  for (const bundle of bundles ?? []) {
    out.push(
      ...validateSkillBundle({
        dirName: bundle.dirName,
        routerText: bundle.routerText,
        files: bundle.files,
        label: bundle.relDir,
      }),
    );
  }

  return out;
}

/**
 * Validate a NON-skill extension package: it must contain NO `SKILL.md` at ANY
 * path outside the shared fixture allowlist. Skills belong in `kind:"skill"`
 * extensions, reached through a dependency edge.
 *
 * @param {object} input
 * @param {string} input.packageName
 * @param {string} input.kind
 * @param {string[]} input.skillMdPaths package-relative paths of every SKILL.md
 * @param {string[]} input.allowlist    the resolved fixture allowlist
 */
export function validateNonSkillExtensionPackage(input) {
  const { packageName, kind, skillMdPaths, allowlist } = input;
  const out = [];
  for (const rel of skillMdPaths ?? []) {
    if (matchesAllowlist(rel, allowlist)) continue;
    out.push(
      violation(
        "skill-md-in-non-skill-package",
        `${packageName} (kind:"${kind}") ships ${rel} — a non-skill extension must not embed a skill. ` +
          `Extract it into a \`-skill\` extension and declare a dependency edge, or fold it into the ` +
          `extension's own configuration.`,
        rel,
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Legacy exception ledger.
//
// The DAG runs S2 (this gate) BEFORE S3 (the migration wave), so on the day
// this lands the four `kind:"skill"` packages that exist today are all
// non-conforming (plural suffix; one ships eighteen bundles). A gate that
// refused them would make the platform un-installable before its own migration
// could run.
//
// So the verdict is fail-closed WITH AN ENUMERATED LEDGER: exactly the
// (package, violation-code) pairs recorded in
// `config/skill-packaging-legacy-exceptions.json` are downgraded to WAIVED and
// reported; anything else — a new package, a new violation class on a listed
// package — fails. S3 empties the ledger, and the emptied ledger is the proof
// the migration is complete.
// ---------------------------------------------------------------------------

/**
 * Partition violations into `{ blocking, waived }` using the ledger.
 * A ledger entry waives a code ONLY for its exact package name.
 */
export function applyLegacyExceptions(violations, input) {
  const { packageName, ledger } = input;
  const entries = ledger && Array.isArray(ledger.exceptions) ? ledger.exceptions : [];
  const entry = entries.find((e) => e && e.packageName === packageName);
  const waivedCodes = new Set(entry && Array.isArray(entry.codes) ? entry.codes : []);
  const blocking = [];
  const waived = [];
  for (const v of violations) {
    (waivedCodes.has(v.code) ? waived : blocking).push(v);
  }
  return { blocking, waived };
}

/** Render violations as the one canonical verdict text every consumer prints. */
export function formatViolations(violations, subject) {
  if (!violations || violations.length === 0) return "";
  const head = `skill-packaging verdict v${VERDICT_CONTRACT_VERSION}: ${violations.length} violation(s) in ${subject}`;
  return [head, ...violations.map((v) => `  - [${v.code}] ${v.message}`)].join("\n");
}
