// Regression assertion for cinatra#2493 (paired with the auditEvidence record in
// .github/gate-suite.json, 2026-08-07 entry). The CLI control plane's Bearer
// verification / actor-resolution seam (src/lib/cli-api/verified-bearer.ts) and
// the tier-authorization seam every /api/cli route calls right after it
// (src/lib/cli-api/route-guard.ts) classified NORMAL-risk: the effective
// high-risk set's auth anchors are directory-name ('**/auth/**') or basename
// ('src/lib/**/*token*.ts') matches that src/lib/cli-api/verified-bearer.ts and
// route-guard.ts do not satisfy, so an authn/authz change on that surface was
// machine-arm mergeable with no maintainer Reviewed-by (measured on #2491,
// which changed exactly that file and matched zero globs). This is a sibling of
// gate-suite-highrisk-token-globs.test.mjs and
// gate-suite-highrisk-execplane-globs.test.mjs (same pattern, same include),
// kept separate so this surface's coverage is independently traceable. It runs
// inside the root Vitest suite (gate of record) via the scripts/ci/__tests__
// include.
//
// The classification uses a FAITHFUL COPY of the gate's own glob→regex
// translation. The production classifier lives cross-repo and is not importable
// here, so globToRegExp below is copied verbatim from
//   cinatra-ai/ci scripts/truthful-attribution-gate.mjs @5c437aa1b65acd135353e92d679c3893bde42bd3
// (the exact pin carried by requiredContexts[].pinned in gate-suite.json). If
// that pin advances and the matcher semantics change, update this copy in the
// same audit that bumps the pin.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const GATE_SUITE = path.join(REPO_ROOT, ".github", "gate-suite.json");

// --- verbatim copy of the production matcher (see header for the source pin) ---
function globToRegExp(glob) {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i += 2;
        if (glob[i] === "/") {
          re += "(?:.*/)?";
          i++;
        } else {
          re += ".*";
        }
        continue;
      }
      re += "[^/]*";
      i++;
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      i++;
      continue;
    }
    if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
      i++;
      continue;
    }
    re += c;
    i++;
  }
  return new RegExp("^" + re + "$");
}

function loadHighRiskPaths() {
  const suite = JSON.parse(fs.readFileSync(GATE_SUITE, "utf8"));
  const globs = suite.highRiskPaths;
  if (!Array.isArray(globs)) {
    throw new Error("gate-suite.json highRiskPaths is not an array");
  }
  return globs.map(String);
}

function classify(file, globs) {
  return globs.some((g) => globToRegExp(g).test(file));
}

// The three paths cinatra#2493's acceptance criterion measured as newly
// high-risk. verified-bearer.test.ts is covered because '**/verified-bearer*'
// anchors on the BASENAME, so the __tests__ sibling matches too.
const KNOWN_CLI_BEARER_HIGH_RISK = [
  "src/lib/cli-api/verified-bearer.ts",
  "src/lib/cli-api/__tests__/verified-bearer.test.ts",
  "src/lib/cli-api/route-guard.ts",
];

// Non-boundary CLI plumbing that MUST stay NORMAL — the approval-fatigue guard
// (#1289): the rejected directory-wide alternative 'src/lib/cli-api/**' drags
// these four leaves + their tests in, so every unrelated CLI edit would demand a
// maintainer approval. If one of these ever reds this suite, the glob set was
// widened to the alternative #2493 deliberately rejected.
const KNOWN_NORMAL = [
  "src/lib/cli-api/zip.ts",
  "src/lib/cli-api/status.ts",
  "src/lib/cli-api/agent-transfer.ts",
  "src/lib/cli-api/extensions-reconcile.ts",
];

// The KNOWN LIMIT #2493 measured and ratified: '**/cli-api/route-guard*'
// anchors the leaf DIRECTLY under a cli-api/ segment, so the route-guard test
// one level deeper under __tests__/ classifies NORMAL — a test-only edit to the
// route-guard regression suite is therefore NOT gated. This is pinned, not left
// unasserted, because #2493's acceptance criterion ratifies a flip set of
// EXACTLY three paths: without this assertion a later widening to
// '**/cli-api/**/route-guard*' would move a fourth path with every other
// assertion still green. Closing the limit is legitimate — it just has to be a
// DELIBERATE change that flips this expectation and updates the gate-suite
// auditEvidence in the same commit, which is what a red here forces.
const KNOWN_LIMIT_NORMAL = "src/lib/cli-api/__tests__/route-guard.test.ts";

describe("gate-suite highRiskPaths CLI bearer-verification coverage (cinatra#2493)", () => {
  const globs = loadHighRiskPaths();

  it.each(KNOWN_CLI_BEARER_HIGH_RISK)(
    "classifies the CLI bearer/authorization surface high-risk: %s",
    (file) => {
      expect(classify(file, globs)).toBe(true);
    },
  );

  it.each(KNOWN_NORMAL)(
    "does NOT over-match the non-boundary src/lib/cli-api leaf: %s",
    (file) => {
      expect(classify(file, globs)).toBe(false);
    },
  );

  // Classification alone is a CONFIG guard, not a RENAME guard: every path
  // above is a hard-coded string, so renaming verified-bearer.ts out from under
  // '**/verified-bearer*' would leave every assertion green while the real
  // surface silently left coverage. Binding each pinned path to a file that
  // must EXIST turns a rename into a red check, which is the only thing that
  // forces the renamer back to this list (and to the glob set) — so the
  // gate-suite auditEvidence's rename claim is actually enforced.
  it.each([...KNOWN_CLI_BEARER_HIGH_RISK, ...KNOWN_NORMAL, KNOWN_LIMIT_NORMAL])(
    "still binds a path that exists in the tree (rename guard): %s",
    (file) => {
      expect(fs.existsSync(path.join(REPO_ROOT, file))).toBe(true);
    },
  );

  it("pins the ratified KNOWN LIMIT: the route-guard test leaf stays NORMAL", () => {
    expect(classify(KNOWN_LIMIT_NORMAL, globs)).toBe(false);
  });

  it("keeps the two cinatra#2493 globs present in highRiskPaths", () => {
    for (const g of ["**/verified-bearer*", "**/cli-api/route-guard*"]) {
      expect(globs).toContain(g);
    }
  });
});
