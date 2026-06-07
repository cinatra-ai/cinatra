// Cinatra local verification orchestrator (`pnpm verify:local`).
//
// Turns the Automated-tagged procedures of the full-functional verification
// runbook into a single on-demand evidence run, with the ledger mapped 1:1 to
// the §11 "Final Fully-Functional Acceptance Checklist". Each gate runs as an
// INDEPENDENT child process — gates are NEVER `&&`-chained, so one red gate
// cannot abort or mask the gates after it (the "a failing step masks later
// steps" hazard the runbook calls out for the G15 stack).
//
// The ledger has ONE entry per §11 checklist line, keyed by its bracketed ID
// (G1, B1, G9, G10, G16, G17, G15, A3/check:services, C1…, E1…, F2…, etc.) with
// PASS / FAIL / N-A. Lines that are AUTOMATED and locally runnable are RUN; lines
// that are MANUAL, owner-gated, or already covered wholesale by a broader gate
// (the per-package G5 / root G19 suites) are recorded N-A with a reason that
// cross-references the coverage-gaps notes — they are NOT executed here.
//
// Output:
//   - a machine-readable ledger at verification-ledger.json
//     (array of { id, label, status, reason, ms }), one entry per §11 line.
//   - a human-readable summary table on stdout.
//
// Exit code: 0 when no gate FAILed (N-A / SKIP are fine); 1 when any gate FAILed.
// A green run means the driver worked — NOT that every gate passes; some gates
// legitimately FAIL until their fixes land (the pre-existing per-package /
// per-extension reds + the worktree-local scratch artifacts documented in the
// coverage-gaps notes §6). The ledger records which.
//
// Pre-flight (extension presence): the per-extension suites and parts of the IoC-coupling
// stack — AND `pnpm typecheck` — need the gitignored extensions/cinatra-ai/*
// repos present (preflight B0). A worktree missing them carries a large typecheck
// baseline that is NOT a real failure, so the pre-flight runs FIRST and, when the
// extension tree is absent, records typecheck + the extension-dependent gates as
// N-A and SKIPS running them. The driver never crashes.
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Resolve the repo root from this script's location (scripts/ -> ..), so the
// driver works in any checkout — never a hardcoded path.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const LEDGER_PATH = path.join(repoRoot, "verification-ledger.json");
const EXTENSIONS_DIR = path.join(repoRoot, "extensions", "cinatra-ai");

// ANSI colors — disabled when stdout is not a TTY or NO_COLOR is set.
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `[${code}m${s}[0m` : s);
const green = (s) => c("0;32", s);
const red = (s) => c("0;31", s);
const yellow = (s) => c("1;33", s);
const gray = (s) => c("2", s);
const bold = (s) => c("1", s);

// Status constants. PASS / FAIL / N-A / SKIP map to the §11 checklist outcomes:
// N-A = legitimately not applicable in this environment (B0 absent, manual /
// owner-gated, or covered wholesale by a broader gate);
// SKIP = an opt-in gate that was not requested this run (e.g. CI-mirror e2e).
const PASS = "PASS";
const FAIL = "FAIL";
const NA = "N-A";
const SKIP = "SKIP";

// Cross-reference target for every N-A reason.
const GAPS = "the coverage-gaps notes";

// ---------------------------------------------------------------------------
// Gate registry. Each entry is keyed to a §11 checklist line item via `id`.
//
// A gate either RUNS a command or is statically N-A:
//   - `cmd`: a pnpm-script invocation (e.g. ["design:scan"]) — runs exactly as a
//     developer / CI would, via the pnpm CLI.
//   - `run`: a raw argv (e.g. ["node", "scripts/audit/marketplace-mcp-client-banned.mjs"]) —
//     for the scripts/audit/* + scripts/design/* gates the plan invokes with
//     `node …` directly rather than through a pnpm script.
//   - `na`: a fixed { status: N-A, reason } for MANUAL / owner-gated / covered-by-
//     broader-gate lines that are deliberately NOT executed locally.
//   - `extensionDependent: true`: short-circuit to N-A when extensions/cinatra-ai
//     is absent (resolved by the extension-presence pre-flight).
//
// Multi-step gates carry `steps` (an array of { cmd } | { run }); the gate PASSes
// only if every step exits 0, and FAILs on the first non-zero step (with a reason
// naming which step failed). This keeps a stacked gate (G10, G16, G17) a single
// §11 ledger line while still running each constituent as an independent process.
// ---------------------------------------------------------------------------

// Order mirrors the §11 checklist top-to-bottom so the ledger reads like the list.
const GATES = [
  // ---- Toolchain & static integrity --------------------------------------
  {
    id: "1.A",
    label: "Node>=24 / pnpm 11 / docker present",
    na: { reason: `manual toolchain pre-flight — run \`node -v\` / \`pnpm -v\` / \`docker --version\` (see ${GAPS})` },
  },
  {
    id: "G1",
    label: "Typecheck (pnpm typecheck)",
    cmd: ["typecheck"],
    extensionDependent: true,
  },
  {
    id: "B1",
    label: "Lazy-DB-pool build invariant (db-pool-lazy-init.test.ts)",
    run: ["pnpm", "exec", "vitest", "run", "src/lib/__tests__/db-pool-lazy-init.test.ts", "--no-coverage"],
  },
  {
    id: "G10",
    label: "CRM migration gates (crm-pointer + oas-banned + parser tests)",
    steps: [
      { run: ["node", "scripts/audit/crm-pointer-gate.mjs", "--strict"] },
      { run: ["node", "scripts/audit/oas-banned-primitives-gate.mjs"] },
      { run: ["pnpm", "exec", "vitest", "run", "scripts/audit/__tests__/oas-banned-primitives-gate.test.mjs", "--no-coverage"] },
    ],
  },
  {
    id: "G16",
    label: "Standalone non-required static gates",
    steps: [
      { run: ["node", "scripts/audit/administration-route-banned.mjs"] },
      { run: ["node", "scripts/audit/connector-access-policy-write-gate.mjs"] },
      { run: ["node", "scripts/audit/gantt-css-tokens.mjs"] },
      { run: ["node", "scripts/audit/marketplace-mcp-client-banned.mjs"] },
      { run: ["node", "scripts/audit/administration-mcp-machine-flow-banned.mjs"] },
      { run: ["node", "scripts/audit/viewer-scope-gate.mjs"] },
    ],
  },
  {
    id: "G17",
    label: "Design-system scans + token drift (design:scan + design:tokens:check)",
    // Each design scanner runs as its OWN independent child process — NOT through
    // the `design:scan` pnpm script, which `&&`-chains the three scanners (a red
    // scanner 1 would mask scanners 2+3). Splitting them keeps the no-`&&`-masking
    // invariant: the gate FAILs on the first non-zero scanner and names it, but
    // every scanner is a separate process so none can be skipped by an earlier red.
    steps: [
      { run: ["node", "scripts/design/scan-raw-colors.mjs"] },
      { run: ["node", "scripts/design/scan-status-render.mjs"] },
      { run: ["node", "scripts/design/scan-chart-colors.mjs"] },
      { cmd: ["design:tokens:check"] },
    ],
  },
  {
    id: "G15",
    label: "Perpetual system loops invariants (connector-IoC slice)",
    // The full G15 stack is ~40 sequential CI steps; the locally-cheap,
    // extension-dependent slice the orchestrator runs is the design-packages
    // pack-smoke (connector-IoC coupling). The rest of the stack is exercised
    // by the broader per-package (G5) + root (G19) suites and the static gates
    // above; see the coverage-gaps notes for the deferred CI-only steps.
    cmd: ["gate:design-packages"],
    extensionDependent: true,
  },

  // ---- Area A — Dev from-scratch -----------------------------------------
  {
    id: "A1",
    label: "make setup exits 0 with `Setup complete!`",
    na: { reason: `manual/destructive cold-setup — needs a fresh clone + docker (see ${GAPS})` },
  },
  {
    id: "A3",
    label: "Infra services up (pnpm check:services)",
    cmd: ["check:services"],
  },
  {
    id: "A4/A5",
    label: "Dev server Ready + root/auth/mcp smoke",
    na: { reason: `manual — needs a running \`pnpm dev\` server (see ${GAPS})` },
  },
  {
    id: "A6",
    label: "First-user registration -> platform admin",
    na: { reason: `manual browser flow (see ${GAPS})` },
  },

  // ---- Area B — Prod from-scratch ----------------------------------------
  {
    id: "B2/B5",
    label: "Prod build (Docker image OR pnpm build standalone)",
    na: { reason: `heavy build — see G3 production-build line; not run locally (see ${GAPS})` },
  },
  {
    id: "B4",
    label: "setup prod prints `Cinatra prod setup complete.`",
    na: { reason: `manual — needs a built image / standalone + reachable Postgres (see ${GAPS})` },
  },
  {
    id: "B7",
    label: "/api/auth/get-session returns 200",
    na: { reason: `manual — needs a provisioned prod server (see ${GAPS})` },
  },
  {
    id: "B8",
    label: "Root page renders from standalone",
    na: { reason: `manual — needs a provisioned prod server (see ${GAPS})` },
  },
  {
    id: "B9/B10",
    label: "public.* auth tables + cinatra store schema present",
    na: { reason: `manual — needs a provisioned prod DB (see ${GAPS})` },
  },

  // ---- Area C — Marketplace install --------------------------------------
  {
    id: "C1",
    label: "Trust + signature unit tests",
    na: { reason: `covered wholesale by the root suite (G19) src/lib/__tests__ (see ${GAPS})` },
  },
  {
    id: "C2",
    label: "Install pipeline + simulated e2e",
    na: { reason: `covered wholesale by the root suite (G19) src/lib/__tests__ (see ${GAPS})` },
  },
  {
    id: "C3",
    label: "Boot-loader + capability split + caller parity",
    na: { reason: `covered wholesale by the root suite (G19) src/lib/__tests__ (see ${GAPS})` },
  },
  {
    id: "C4",
    label: "Gatekept-install direct-registry-ban gate",
    cmd: ["gate:gatekept-install"],
  },
  {
    id: "C6",
    label: "Genuine prod install vs live registry/marketplace",
    na: { reason: `owner-gated — needs prod broker + signing keys (see ${GAPS} §2)` },
  },

  // ---- Area D — /chat creation -------------------------------------------
  {
    id: "D1",
    label: "Agent-creation pipeline (admin gate + propose/decide)",
    na: { reason: `covered wholesale by per-package suites (G5) packages/agents (see ${GAPS})` },
  },
  {
    id: "D2",
    label: "Full agents-package source-authoring suite",
    na: { reason: `covered wholesale by per-package suites (G5) packages/agents (see ${GAPS})` },
  },
  {
    id: "D3",
    label: "Delegated-chat tool policy",
    na: { reason: `covered wholesale by per-package suites (G5) packages/mcp-server (see ${GAPS})` },
  },
  {
    id: "D5",
    label: "Manual: author + publish an agent via /chat",
    na: { reason: `manual — real LLM spend + tunnel (see ${GAPS} §2)` },
  },
  {
    id: "D6",
    label: "Manual: create a semantic artifact via /chat",
    na: { reason: `manual — real LLM spend (see ${GAPS} §2)` },
  },
  {
    id: "D4",
    label: "Chat SSE progress unit (known alias-gap)",
    na: { reason: `known harness gap — @/components/icon-button transform; not a regression (see ${GAPS} §4)` },
  },

  // ---- Area E — MCP server + primitives + UI -----------------------------
  {
    id: "E1",
    label: "packages/mcp-server vitest",
    na: { reason: `covered wholesale by per-package suites (G5) packages/mcp-server (see ${GAPS})` },
  },
  {
    id: "E2",
    label: "advertised-url-routes",
    na: { reason: `covered wholesale by per-package suites (G5) (see ${GAPS})` },
  },
  {
    id: "E3",
    label: "machine-flow-banned audit",
    run: ["node", "scripts/audit/administration-mcp-machine-flow-banned.mjs"],
  },
  {
    id: "E4",
    label: "in-process transport + deterministic client",
    na: { reason: `covered wholesale by per-package suites (G5) (see ${GAPS})` },
  },
  {
    id: "E5",
    label: "/api/mcp returns 401 Bearer handshake",
    na: { reason: `manual — needs a running server (see ${GAPS})` },
  },
  {
    id: "E6",
    label: "/api/mcp/health returns 200 mcpHandlerWired:true",
    na: { reason: `manual — needs a running server (see ${GAPS})` },
  },
  {
    id: "E8",
    label: "MCP configuration UI renders for admin",
    na: { reason: `manual browser flow (see ${GAPS})` },
  },
  {
    id: "E7",
    label: "External-transport tools/list + primitive call",
    na: { reason: `owner-gated — needs a public MCP tunnel (see ${GAPS} §2)` },
  },

  // ---- Area F — UI via Playwright ----------------------------------------
  {
    id: "F1",
    label: "Design pixel-diff + axe",
    na: { reason: `Playwright e2e — opt-in via VERIFY_LOCAL_E2E (see ${GAPS})` },
  },
  // F2/F3/F4 are the opt-in CI-mirror browser e2e gates handled below.
  {
    id: "F7",
    label: "Notifications flyout e2e",
    na: { reason: `Playwright e2e — opt-in via VERIFY_LOCAL_E2E (see ${GAPS})` },
  },
  {
    id: "F9",
    label: "Render-smoke of uncovered routes",
    na: { reason: `automated floor = render-smoke spec (opt-in e2e); manual elsewhere (see ${GAPS} §5)` },
  },
  {
    id: "F8",
    label: "Playwright config/script + required-gate inventory",
    na: { reason: `manual audit + gh api probe; N-A unauthenticated (see ${GAPS})` },
  },
  {
    id: "F5",
    label: "WP/Drupal UAT",
    na: { reason: `partly owner-gated — needs WP/Drupal containers + private plugin (see ${GAPS} §2)` },
  },
  {
    id: "F6",
    label: "agents-run live UAT",
    na: { reason: `owner-gated — needs public MCP tunnel + WayFlow + real LLM spend (see ${GAPS} §2)` },
  },

  // ---- Area G — Automated tests + CI gates -------------------------------
  {
    id: "G5",
    label: "Per-package unit suites (packages/*)",
    // Run vitest directly per-package (not each package's own `test` script) so
    // the gate is consistent: `--passWithNoTests` keeps packages that legitimately
    // ship no test files from registering a false FAIL, and bare `vitest run`
    // avoids the watch-mode `test: "vitest"` scripts a few packages still use.
    // Excludes the known sandbox-alias-gap test (projects' project-access-mcp
    // imports the host `@/lib/pg-array` alias, which only resolves inside the
    // Next.js bundle — not in a standalone package vitest; its handler logic is
    // exercised by the host root suite + the projects CI job). See the coverage-gaps notes.
    cmd: ["-r", "--filter", "./packages/*", "exec", "vitest", "run", "--passWithNoTests", "--exclude", "**/project-access-mcp.test.ts"],
  },
  {
    id: "G6",
    label: "Per-package integration suites (agents + workflows + a2a)",
    na: { reason: `heavy integration suites — needs DB/Redis; run via package \`test:integration\` (see ${GAPS})` },
  },
  {
    id: "G19",
    label: "Root Vitest suite (test:root)",
    cmd: ["test:root"],
  },
  {
    id: "G7",
    label: "Per-extension unit suites (extensions/cinatra-ai/*)",
    // Same robustness as the per-package gate: vitest directly + --passWithNoTests.
    cmd: ["-r", "--filter", "./extensions/cinatra-ai/*", "exec", "vitest", "run", "--passWithNoTests"],
    extensionDependent: true,
  },
  {
    id: "G8",
    label: "RBAC authz unit subset (authz:inventory:check)",
    cmd: ["authz:inventory:check"],
  },
  {
    id: "G11",
    label: "Release workflows tests (unit + integration)",
    na: { reason: `heavy workflows suites (~175 specs) — run via packages/workflows test scripts (see ${GAPS})` },
  },
  {
    id: "G14",
    label: "build-image Typecheck+unit mirror",
    na: { reason: `mirrors G1 typecheck + agents specs (G5); covered there (see ${GAPS})` },
  },
  {
    id: "G20",
    label: "build-image + workflow extra jobs / CI matrix audit",
    na: { reason: `CI-only / path-gated jobs + manual matrix audit (see ${GAPS})` },
  },
  {
    id: "G3",
    label: "Production build (placeholder env)",
    na: { reason: `heavy build (~2-15 min) — out of the tractable local floor (see ${GAPS})` },
  },
  {
    id: "G18",
    label: "Fresh-schema DDL check (check:fresh-schema)",
    na: { reason: `needs reachable Postgres + .env.local; only when drizzle-store touched (see ${GAPS})` },
  },

  // ---- Cross-cutting ------------------------------------------------------
  {
    id: "X.required-7",
    label: "All 7 branch-protection required checks accounted for",
    na: { reason: `audit line — F2/F3/F4 + G11 + G8 + G9 + G10 are individual ledger entries (see ${GAPS})` },
  },
  {
    id: "X.owner-gated",
    label: "Every owner-gated item recorded N/A with a reason",
    na: { reason: `audit line — each owner-gated ledger entry carries its reason (see ${GAPS} §2)` },
  },
];

// CI-mirror browser e2e (§11 F2/F3/F4). These are heavyweight and require a
// server. They are SKIP / N-A by default and only run when VERIFY_LOCAL_E2E=1 AND
// a server is reachable. We never boot Turbopack from the ledger; if run against a
// plain dev server the result is labelled 'dev-smoke', NOT a CI-equivalent gate.
const E2E_GATES = [
  { id: "F2", label: "RBAC browser e2e (test:e2e:rbac)", cmd: ["test:e2e:rbac"] },
  { id: "F3", label: "Workflows browser e2e (test:e2e:workflows)", cmd: ["test:e2e:workflows"] },
  { id: "F4", label: "Dashboards browser e2e (test:e2e:dashboards)", cmd: ["test:e2e:dashboards"] },
];

// ---------------------------------------------------------------------------
// Child-process runner. Each step runs INDEPENDENTLY via spawnSync — never
// `&&`-chained — so a red step cannot abort or mask later gates.
// ---------------------------------------------------------------------------

const pnpmBin = process.env.npm_execpath ? process.execPath : "pnpm";
function pnpmArgs(cmd) {
  // When invoked through npm/pnpm, npm_execpath points at the pnpm CLI .cjs so we
  // can re-enter it with node; otherwise fall back to a bare `pnpm` on PATH.
  return process.env.npm_execpath ? [process.env.npm_execpath, ...cmd] : cmd;
}

// Run ONE step. A step is either { cmd } (pnpm script) or { run } (raw argv).
function runStep(step) {
  const isRaw = Array.isArray(step.run);
  const bin = isRaw ? step.run[0] : pnpmBin;
  const args = isRaw ? step.run.slice(1) : pnpmArgs(step.cmd);
  const label = isRaw ? step.run.join(" ") : `pnpm ${step.cmd.join(" ")}`;
  let result;
  try {
    result = spawnSync(bin, args, {
      cwd: repoRoot,
      stdio: "inherit",
      env: process.env,
      // Never let a hung step wedge the whole run.
      timeout: 30 * 60 * 1000,
    });
  } catch (err) {
    return { ok: false, reason: `spawn error: ${err && err.message ? err.message : String(err)}`, label };
  }
  if (result.error) return { ok: false, reason: `spawn error: ${result.error.message}`, label };
  if (result.signal) return { ok: false, reason: `terminated by signal ${result.signal}`, label };
  if (result.status === 0) return { ok: true, reason: "exit 0", label };
  return { ok: false, reason: `exit ${result.status}`, label };
}

// Run a gate (one or more steps). PASS only if every step exits 0; FAIL on the
// first non-zero step, naming which step failed.
function runGate(gate) {
  const started = Date.now();
  const steps = gate.steps || [gate];
  for (const step of steps) {
    const out = runStep(step);
    if (!out.ok) {
      return {
        status: FAIL,
        reason: steps.length > 1 ? `${out.reason} (step: ${out.label})` : out.reason,
        ms: Date.now() - started,
      };
    }
  }
  return {
    status: PASS,
    reason: steps.length > 1 ? `${steps.length} steps exit 0` : "exit 0",
    ms: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// Reachability probe for the opt-in e2e gates (no Turbopack boot from here).
// ---------------------------------------------------------------------------

async function serverReachable(url, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "manual" });
    // Any HTTP response (even a redirect or 401) means a server is listening.
    return Boolean(res);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main() {
  const ledger = [];
  const record = (id, label, status, reason, ms = 0) => {
    ledger.push({ id, label, status, reason, ms });
  };

  console.log(bold("\nverify:local — Automated verification gates (no &&-chaining)\n"));

  // --- EXTENSION-PRESENCE PRE-FLIGHT: runs FIRST, before typecheck. -------------------
  const extensionsPresent = existsSync(EXTENSIONS_DIR);
  const B0_REASON = `extensions/cinatra-ai absent — run plan B0 (see ${GAPS} §4)`;
  if (!extensionsPresent) {
    console.log(
      yellow(
        `  pre-flight: ${EXTENSIONS_DIR} absent — typecheck + G7 + G15 connector-IoC marked N-A (run plan B0)\n`,
      ),
    );
  } else {
    console.log(gray(`  pre-flight: extensions/cinatra-ai present — extension-dependent gates enabled\n`));
  }

  // Process every §11 gate in checklist order. A gate is:
  //   - statically N-A (`na`) — recorded without running;
  //   - extension-dependent + extensions absent — short-circuited to N-A;
  //   - otherwise RUN as independent child process(es).
  for (const gate of GATES) {
    if (gate.na) {
      console.log(`  ${yellow("N-A ")} ${gate.label} — ${gate.na.reason}`);
      record(gate.id, gate.label, NA, gate.na.reason, 0);
      continue;
    }
    if (gate.extensionDependent && !extensionsPresent) {
      console.log(`  ${yellow("N-A ")} ${gate.label} — ${B0_REASON}`);
      record(gate.id, gate.label, NA, B0_REASON, 0);
      continue;
    }
    console.log(gray(`  ──── running: ${gate.label}`));
    const out = runGate(gate);
    const tag = out.status === PASS ? green("PASS") : red("FAIL");
    console.log(`  ${tag} ${gate.label} — ${out.reason} (${out.ms}ms)\n`);
    record(gate.id, gate.label, out.status, out.reason, out.ms);
  }

  // --- CI-mirror browser e2e (opt-in; §11 F2/F3/F4) ----------------------
  const e2eOptIn = process.env.VERIFY_LOCAL_E2E === "1";
  let e2eReachable = false;
  const baseUrl =
    process.env.VERIFY_LOCAL_E2E_BASE_URL ||
    process.env.BETTER_AUTH_URL ||
    "http://127.0.0.1:3000";
  if (e2eOptIn) {
    e2eReachable = await serverReachable(baseUrl);
  }
  for (const gate of E2E_GATES) {
    if (!e2eOptIn) {
      const reason = "VERIFY_LOCAL_E2E!=1 — opt-in CI-mirror e2e not requested";
      console.log(`  ${gray("SKIP")} ${gate.label} — ${reason}`);
      record(gate.id, gate.label, SKIP, reason, 0);
      continue;
    }
    if (!e2eReachable) {
      const reason = `no server reachable at ${baseUrl} — driver never boots Turbopack`;
      console.log(`  ${yellow("N-A ")} ${gate.label} — ${reason}`);
      record(gate.id, gate.label, NA, reason, 0);
      continue;
    }
    // Reachable but a plain dev server is NOT the CI mirror (prod build +
    // standalone server). Label it 'dev-smoke', not CI-equivalent.
    console.log(gray(`  ──── running (dev-smoke, NOT CI-equivalent): ${gate.label}`));
    const out = runGate(gate);
    const tag = out.status === PASS ? green("PASS") : red("FAIL");
    const reason = `dev-smoke (NOT CI-equivalent) — ${out.reason}`;
    console.log(`  ${tag} ${gate.label} — ${reason} (${out.ms}ms)\n`);
    record(gate.id, gate.label, out.status, reason, out.ms);
  }

  // --- Write the ledger ---------------------------------------------------
  mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  writeFileSync(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");

  // --- Human summary table ------------------------------------------------
  printSummary(ledger);
  console.log(
    gray(
      `\n  Ledger written to ${path.relative(repoRoot, LEDGER_PATH)} ` +
        `(${ledger.length} entries, one per §11 checklist line; N-A entries cross-reference ${GAPS})`,
    ),
  );

  const failed = ledger.filter((e) => e.status === FAIL);
  if (failed.length > 0) {
    console.log(red(`\n  ${failed.length} gate(s) FAILED — see ledger.\n`));
    process.exit(1);
  }
  console.log(green(`\n  No FAILures (N-A / SKIP are fine).\n`));
  process.exit(0);
}

function printSummary(ledger) {
  console.log(bold("\n  Summary\n"));
  const idW = Math.max(4, ...ledger.map((e) => e.id.length));
  const statusW = 5;
  const labelW = Math.max(20, ...ledger.map((e) => e.label.length));
  const header =
    `  ${"ID".padEnd(idW)}  ${"STAT".padEnd(statusW)}  ${"GATE".padEnd(labelW)}  TIME`;
  console.log(gray(header));
  console.log(gray("  " + "-".repeat(header.length - 2)));
  const colorFor = (status) => {
    if (status === PASS) return green(status.padEnd(statusW));
    if (status === FAIL) return red(status.padEnd(statusW));
    if (status === NA) return yellow(status.padEnd(statusW));
    return gray(status.padEnd(statusW));
  };
  for (const e of ledger) {
    const time = e.ms ? `${(e.ms / 1000).toFixed(1)}s` : "-";
    console.log(
      `  ${e.id.padEnd(idW)}  ${colorFor(e.status)}  ${e.label.padEnd(labelW)}  ${time}`,
    );
  }
  const counts = ledger.reduce((acc, e) => {
    acc[e.status] = (acc[e.status] || 0) + 1;
    return acc;
  }, {});
  console.log(
    gray(
      `\n  ${counts[PASS] || 0} PASS · ${counts[FAIL] || 0} FAIL · ` +
        `${counts[NA] || 0} N-A · ${counts[SKIP] || 0} SKIP`,
    ),
  );
}

main().catch((err) => {
  // Defensive: the driver must never crash on an unexpected error — surface it
  // and exit non-zero so callers see a clear signal.
  console.error(red(`\nverify:local crashed: ${err && err.stack ? err.stack : err}\n`));
  process.exit(1);
});
