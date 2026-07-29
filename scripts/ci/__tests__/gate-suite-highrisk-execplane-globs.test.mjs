// Regression assertion for the exec-plane S7 service-boundary highRiskPaths
// addition (paired with the auditEvidence record in .github/gate-suite.json,
// 2026-07-30 entry). S7 lands packages/execution-plane's HTTP/mTLS service
// boundary + per-command authorization voucher — a trust-boundary surface no
// prior highRiskPaths glob covers, because packages/execution-plane/src/
// service/ and .../authz/ don't match any auth/permissions/trust-gate/
// capability-registry anchor by directory NAME. This is a sibling of
// gate-suite-highrisk-token-globs.test.mjs (same pattern, same include), kept
// separate so this program's coverage is independently traceable. It runs
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

// Representative future leaves under the two new S7 prefixes — the directories
// don't exist on this branch yet (S7's code lands in a later lane of this same
// program); these stand in for "the first file that lands there" so the glob's
// coverage is proven before that file exists, not after (closing the #1289 /
// #1856 evasion class in the opposite temporal order).
const KNOWN_EXECPLANE_HIGH_RISK = [
  "packages/execution-plane/src/service/http-listener.ts",
  "packages/execution-plane/src/service/mtls-verifier.ts",
  "packages/execution-plane/src/authz/voucher.ts",
  "packages/execution-plane/src/authz/__tests__/voucher.test.ts",
];

// Representative non-boundary execution-plane leaves that MUST stay NORMAL —
// the approval-fatigue guard: a wholesale packages/execution-plane/** glob
// would mark every plane edit high-risk, which these two prefixes deliberately
// avoid by scoping to only the service/authz trust boundary.
const KNOWN_NORMAL = [
  "packages/execution-plane/src/workspace.ts",
  "packages/execution-plane/src/broker.ts",
];

describe("gate-suite highRiskPaths exec-plane S7 service/authz coverage", () => {
  const globs = loadHighRiskPaths();

  it.each(KNOWN_EXECPLANE_HIGH_RISK)(
    "classifies the exec-plane service/authz surface high-risk: %s",
    (file) => {
      expect(classify(file, globs)).toBe(true);
    },
  );

  it.each(KNOWN_NORMAL)(
    "does NOT over-match the non-boundary execution-plane leaf: %s",
    (file) => {
      expect(classify(file, globs)).toBe(false);
    },
  );

  it("keeps the two exec-plane S7 globs present in highRiskPaths", () => {
    for (const g of [
      "packages/execution-plane/src/service/**",
      "packages/execution-plane/src/authz/**",
    ]) {
      expect(globs).toContain(g);
    }
  });
});
