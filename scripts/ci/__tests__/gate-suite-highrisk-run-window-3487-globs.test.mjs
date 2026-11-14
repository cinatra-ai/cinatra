// Regression assertion for cinatra#3487 (items 5-7): "the builder module and the
// three tests sit on the attribution gate's high-risk path list". The three
// tests are item 5's structural invariant on the one request builder, item 6's
// behavioural test (its server half and its client half) and item 7's
// tool-manifest parity spec on a booted instance. Each is pinned here as a
// path that MUST classify high-risk under THIS repo's own gate-suite.json
// highRiskPaths, so widening or weakening one needs a maintainer-tier
// approval; and each pinned path must exist, so a rename that leaves a dead
// entry behind reds this required check. It runs inside the root Vitest suite
// via the scripts/ci/__tests__ include.
//
// The classification uses a FAITHFUL COPY of the gate's own glob->regex
// translation, copied verbatim from
// scripts/ci/__tests__/gate-suite-highrisk-token-globs.test.mjs (same source
// pin as stated there).
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

// The builder module, the window road and the three tests (cinatra#3487).
const RUN_WINDOW_HIGH_RISK = [
  // item 5: the one request builder, the window's server road and client bridge
  "src/lib/assistant-runtime/cinatra-assistant-config.ts",
  "src/lib/lifecycle/run-window-turn.ts",
  "packages/agents/src/run-window-actions.ts",
  // item 1 and item 5: the two structural invariants
  "packages/agents/src/__tests__/run-window-panel-single-importer.invariant.test.ts",
  "packages/agents/src/__tests__/run-window-request-builder.invariant.test.ts",
  // item 6: the behavioural test, server half and client half
  "src/lib/lifecycle/__tests__/run-window-full-capabilities-3487.test.ts",
  "packages/agents/src/__tests__/run-page-chrome-one-window-3487.test.tsx",
  // item 7: the tool-manifest parity spec and the route it reads
  "tests/e2e/agents-run/tool-manifest-parity-3487.spec.ts",
  "src/app/api/assistants/chat/tool-manifest/route.ts",
];

// Neighbours that MUST stay NORMAL: the entries are exact files, not folders.
const RUN_WINDOW_NEIGHBOURS_NORMAL = [
  "src/lib/lifecycle/__tests__/run-window-turn.test.ts",
  "src/lib/lifecycle/__tests__/run-window-frame.test.ts",
  "packages/agents/src/__tests__/run-page-chrome-real-field-3487.test.tsx",
  "tests/e2e/agents-run/trigger-step-after-approval.spec.ts",
  "tests/e2e/config/agents-run.config.ts",
];

describe("gate-suite highRiskPaths run-window coverage (cinatra#3487 items 5-7)", () => {
  const globs = loadHighRiskPaths();

  it.each(RUN_WINDOW_HIGH_RISK)("classifies high-risk: %s", (file) => {
    expect(classify(file, globs)).toBe(true);
  });

  it.each(RUN_WINDOW_HIGH_RISK)("pins a file that exists: %s", (file) => {
    expect(fs.existsSync(path.join(REPO_ROOT, file))).toBe(true);
  });

  it.each(RUN_WINDOW_NEIGHBOURS_NORMAL)("does NOT over-match the neighbour: %s", (file) => {
    expect(fs.existsSync(path.join(REPO_ROOT, file))).toBe(true);
    expect(classify(file, globs)).toBe(false);
  });
});
