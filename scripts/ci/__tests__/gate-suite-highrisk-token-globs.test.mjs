// Regression assertion for cinatra#1856 (paired with the auditEvidence record in
// .github/gate-suite.json). The truthful-attribution-gate classifies genuine
// HMAC token mint/verify changes as NORMAL-risk unless their leaf paths are
// covered by the effective high-risk glob set. This suite pins the known token
// surfaces + their token-consuming route seams and asserts they classify
// high-risk under THIS repo's own gate-suite.json highRiskPaths — so a future
// rename/addition that evades the globs, or an accidental over-broadening that
// drags unrelated src/lib leaves in, reds this required check. It runs inside
// the root Vitest suite (gate of record) via the scripts/ci/__tests__ include.
//
// The classification uses a FAITHFUL COPY of the gate's own glob→regex
// translation. The production classifier lives cross-repo and is not importable
// here, so globToRegExp below is copied verbatim from
//   cinatra-ai/ci scripts/truthful-attribution-gate.mjs @72d0b1caa9b11e33a9ba3e65e55aae46ad844bf1
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

// The HMAC token mint/verify leaves + the token-consuming assistants route seams
// that MUST classify high-risk (cinatra#1856 AC). widget-chat-resume-token.ts is
// the #1855 near-miss that motivated the closure.
const KNOWN_TOKEN_HIGH_RISK = [
  "src/lib/agent-run-mcp-actor-token.ts",
  "src/lib/widget-mcp-actor-token.ts",
  "src/lib/chat-mcp-actor-token.ts",
  "src/lib/agent-run-token.ts",
  "src/lib/widget-token-broker.ts",
  "src/lib/widget-chat-resume-token.ts",
  "src/app/api/assistants/chat/route.ts",
  "src/app/api/assistants/chat/capabilities/route.ts",
  "src/app/api/assistants/runs/[runId]/stream/route.ts",
];

// Representative non-token src/lib leaves that MUST stay NORMAL — the
// approval-fatigue guard the #1289 closure required (a wholesale src/lib glob
// would mark every store/lib edit high-risk).
const KNOWN_NORMAL = [
  "src/lib/drizzle-store.ts",
  "src/lib/utils.ts",
];

describe("gate-suite highRiskPaths token coverage (cinatra#1856)", () => {
  const globs = loadHighRiskPaths();

  it.each(KNOWN_TOKEN_HIGH_RISK)(
    "classifies the token surface high-risk: %s",
    (file) => {
      expect(classify(file, globs)).toBe(true);
    },
  );

  it.each(KNOWN_NORMAL)(
    "does NOT over-match the non-token src/lib leaf: %s",
    (file) => {
      expect(classify(file, globs)).toBe(false);
    },
  );

  it("keeps the three cinatra#1856 globs present in highRiskPaths", () => {
    for (const g of [
      "src/lib/**/*token*.ts",
      "src/app/api/assistants/chat/**",
      "src/app/api/assistants/runs/**/stream/**",
    ]) {
      expect(globs).toContain(g);
    }
  });
});
