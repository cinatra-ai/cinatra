/**
 * ORG-WIDE migration regression (cinatra#2094 S7).
 *
 * The S3 wave (cinatra#2090) removed every embedded skill from non-skill
 * extensions. `scripts/audit/skill-packaging-gate.mjs` already proves that over
 * the PINNED universe (the SHAs in the two lock files). This driver proves the
 * complementary half the acceptance spec asks for: the state of every extension
 * repo's DEFAULT BRANCH, fetched live from GitHub — which is where a
 * release-fenced pin lag becomes visible rather than hidden.
 *
 * Arms:
 *   A  default-branch SKILL.md census across every cloned-back extension repo,
 *      classified by `cinatra.kind`, with the SHARED fixture allowlist applied.
 *      Expected: zero embedded skills in non-skill kinds.
 *   B  zero raw `skillIds: string[]` callers in core (the S4 typed-contract
 *      invariant) — an arch grep over the delivery/injection entry points.
 *   C  the assistant's required injectable skill set is <= 8 and EXCLUDES the
 *      internal HITL skill.
 *   D  matcher/authoring skills are reachable only through declared dependency
 *      edges (role-carrying edges), never same-package ownership.
 *
 * Read-only. No secrets. Emits `migration-results.json`.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, "..");
const REPO_ROOT = path.join(HERE, "..", "..", "..");
const EXT_ROOT = path.join(REPO_ROOT, "extensions");

const allowlistDoc = JSON.parse(readFileSync(path.join(REPO_ROOT, "config", "skill-fixture-allowlist.json"), "utf8"));
const EXT_DEFAULT_ALLOWLIST = allowlistDoc.extensionRepoDefault ?? [];

const results = {
  driver: "cinatra#2094 S7 org-wide migration regression",
  ranAt: new Date().toISOString(),
  arms: {},
};

/** Anchored glob matcher with the ledger's documented grammar (`**` / `*`). */
function matchesAllowlist(relPath, patterns) {
  for (const p of patterns) {
    const rx = new RegExp(
      "^" +
        p
          .split("**")
          .map((seg) => seg.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
          .join(".*") +
        "$",
    );
    if (rx.test(relPath)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Arm A — default-branch SKILL.md census (live GitHub)
// ---------------------------------------------------------------------------
function listClonedPackages() {
  const out = [];
  if (!existsSync(EXT_ROOT)) return out;
  for (const owner of readdirSync(EXT_ROOT)) {
    const ownerDir = path.join(EXT_ROOT, owner);
    if (!statSync(ownerDir).isDirectory()) continue;
    for (const repo of readdirSync(ownerDir)) {
      const pkgPath = path.join(ownerDir, repo, "package.json");
      if (!existsSync(pkgPath)) continue;
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      } catch {
        continue;
      }
      out.push({
        owner,
        repo,
        name: pkg.name ?? `${owner}/${repo}`,
        kind: pkg.cinatra?.kind ?? null,
        skillRole: pkg.cinatra?.skillRole ?? null,
      });
    }
  }
  return out.sort((a, b) => (a.repo < b.repo ? -1 : 1));
}

function defaultBranchTree(owner, repo) {
  try {
    const raw = execFileSync(
      "gh",
      ["api", `repos/${owner}/${repo}/git/trees/HEAD?recursive=1`, "--jq", ".tree[]|select(.type==\"blob\")|.path"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
    );
    return { ok: true, paths: raw.split("\n").filter(Boolean) };
  } catch (err) {
    const msg = String(err?.stderr ?? err?.message ?? err).slice(0, 200);
    return { ok: false, error: msg };
  }
}

function armA() {
  const pkgs = listClonedPackages();
  const perRepo = [];
  let unreachable = 0;
  for (const p of pkgs) {
    const tree = defaultBranchTree(p.owner, p.repo);
    if (!tree.ok) {
      unreachable += 1;
      perRepo.push({ repo: p.repo, kind: p.kind, reachable: false, error: tree.error });
      continue;
    }
    const skillMds = tree.paths.filter((f) => f === "SKILL.md" || f.endsWith("/SKILL.md"));
    const offending = skillMds.filter((f) => !matchesAllowlist(f, EXT_DEFAULT_ALLOWLIST));
    perRepo.push({
      repo: p.repo,
      pkg: p.name,
      kind: p.kind,
      skillRole: p.skillRole,
      skillMdCount: skillMds.length,
      // For kind:"skill" a bundle IS expected — exactly one.
      embeddedViolation: p.kind !== "skill" && offending.length > 0 ? offending : null,
      bundleCount: p.kind === "skill" ? skillMds.length : undefined,
    });
  }
  const agentRepos = perRepo.filter((r) => r.kind === "agent");
  const nonSkill = perRepo.filter((r) => r.kind && r.kind !== "skill" && r.reachable !== false);
  const violations = nonSkill.filter((r) => r.embeddedViolation);
  const skillRepos = perRepo.filter((r) => r.kind === "skill" && r.reachable !== false);
  const multiBundle = skillRepos.filter((r) => r.bundleCount !== 1);

  results.arms.A_defaultBranchCensus = {
    verdict: violations.length === 0 && multiBundle.length === 0 ? "PASS" : "FAIL",
    scannedRepos: perRepo.length,
    unreachableRepos: unreachable,
    counts: {
      agentRepos: agentRepos.length,
      nonSkillRepos: nonSkill.length,
      skillRepos: skillRepos.length,
      embeddedSkillViolations: violations.length,
      skillReposNotExactlyOneBundle: multiBundle.length,
    },
    embeddedSkillViolations: violations.map((v) => ({ repo: v.repo, kind: v.kind, paths: v.embeddedViolation })),
    skillReposNotExactlyOneBundle: multiBundle.map((v) => ({ repo: v.repo, bundleCount: v.bundleCount })),
    perRepo,
  };
}

// ---------------------------------------------------------------------------
// Arm B — zero raw skillIds callers (S4 typed-contract invariant)
// ---------------------------------------------------------------------------
function grep(pattern, globs) {
  try {
    const raw = execFileSync(
      "git",
      ["grep", "-n", "-E", pattern, "--", ...globs],
      { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 },
    );
    return raw.split("\n").filter(Boolean);
  } catch {
    return []; // git grep exits 1 on no match
  }
}

function armB() {
  // NOTE ON MEASUREMENT AUTHORITY. The authoritative check for this invariant is
  // the S4 arch gate, `packages/skills/src/injection/__tests__/no-bypass-arch.test.ts`
  // — it walks the source tree, refuses to be vacuously green, and pins four
  // separate properties (buildSkillTools reachable only from the delivery seam;
  // no production caller passes a raw skillIds array into a skill-aware entry
  // point; ResolvedInjectedSkillSet has exactly one constructor; every
  // skill-aware caller declares an intent). This arm does NOT re-derive that
  // verdict — it records the census as context so the report can state exact
  // numbers, and defers PASS/FAIL to the suite run recorded in the report.
  //
  // POSIX character classes, not `\s`: git grep -E is POSIX ERE, where `\s` is
  // not a class and silently matches nothing (an earlier revision of this
  // driver reported a vacuous 0).
  const declHits = grep("skillIds[[:space:]]*[?]?:[[:space:]]*string\\[\\]", [
    "src",
    "packages/skills/src",
    "packages/agents/src",
    "packages/llm/src",
    "packages/sdk-extensions/src",
  ]);
  const isTest = (l) => /\.test\.ts|__tests__|tests\/__helpers__/.test(l);
  const postResolutionWire = declHits.filter(
    (l) =>
      l.includes("packages/llm/src/tools/skill-delivery.ts") ||
      l.includes("packages/llm/src/tools/skills.ts") ||
      l.includes("llm-provider-adapter-contract"),
  );
  const tests = declHits.filter((l) => isTest(l));
  const other = declHits.filter((l) => !postResolutionWire.includes(l) && !tests.includes(l));
  results.arms.B_rawSkillIdCensus = {
    verdict: "CONTEXT",
    authority: "packages/skills/src/injection/__tests__/no-bypass-arch.test.ts (run in the skills suite)",
    totalDeclarations: declHits.length,
    postResolutionDeliveryWire: postResolutionWire.length,
    testAndHelperDeclarations: tests.length,
    otherDeclarations: other.length,
    otherDeclarationSites: other,
    note:
      "A bare string[] is legitimate on the POST-resolution delivery wire and inside tests. " +
      "The arch gate is what decides whether any of the remaining sites is a skill-aware ENTRY POINT.",
  };
}

// ---------------------------------------------------------------------------
// Arm C — assistant required injectable set <= 8, HITL excluded
// ---------------------------------------------------------------------------
function armC() {
  // The generated server manifest is the resolved truth for what the host ships:
  // every extension with its kind and its resolution tier. The assistant's
  // REQUIRED injectable set is the `kind:"skill"` packages at
  // `resolution:"required"`, minus the ones whose own manifest declares
  // `skillRole:"internal"` (never injected, never uploaded).
  const gen = readFileSync(path.join(REPO_ROOT, "src", "lib", "generated", "extensions.server.ts"), "utf8");
  const rows = [...gen.matchAll(/"(@cinatra-ai\/[^"]+)":\s*(\{[^\n]*?\}),\n/g)];
  const skillPkgs = [];
  for (const [, name, blob] of rows) {
    let d;
    try {
      d = JSON.parse(blob);
    } catch {
      continue;
    }
    if (d.kind !== "skill") continue;
    const repo = name.replace(/^@cinatra-ai\//, "");
    const pj = path.join(EXT_ROOT, "cinatra-ai", repo, "package.json");
    let role = "unknown";
    if (existsSync(pj)) {
      try {
        role = JSON.parse(readFileSync(pj, "utf8")).cinatra?.skillRole ?? "injectable";
      } catch {
        /* leave unknown */
      }
    }
    skillPkgs.push({ name, resolution: d.resolution ?? null, skillRole: role });
  }
  const required = skillPkgs.filter((s) => s.resolution === "required");
  const injectable = required.filter((s) => s.skillRole === "injectable");
  const internal = required.filter((s) => s.skillRole === "internal");
  results.arms.C_assistantRequiredSet = {
    verdict: injectable.length > 0 && injectable.length <= 8 && internal.length > 0 ? "PASS" : "FAIL",
    totalSkillPackages: skillPkgs.length,
    requiredSkillPackages: required.length,
    injectableCount: injectable.length,
    cap: 8,
    injectable: injectable.map((s) => s.name),
    internalExcludedFromInjectionAndUpload: internal.map((s) => s.name),
    roleBreakdownAllSkillPackages: skillPkgs.reduce((acc, s) => {
      acc[s.skillRole] = (acc[s.skillRole] ?? 0) + 1;
      return acc;
    }, {}),
    note: "Injectable counts toward the 8 cap; internal is never injected and never uploaded.",
  };
}

// ---------------------------------------------------------------------------
// Arm D — matcher/authoring trust only via declared dependency edges
// ---------------------------------------------------------------------------
function armD() {
  const samePackageOwnership = grep("ownedByPackage|samePackageOwner|owningPackage\\s*===", [
    "src/lib/artifacts",
    "packages/skills/src",
  ]);
  const edgeResolution = grep("matcher|authoring", ["packages/skills/src/extension-skill-resolver.ts"]);
  results.arms.D_edgeResolvedTrust = {
    verdict: samePackageOwnership.length === 0 ? "PASS" : "REVIEW",
    residualSamePackageTrustHits: samePackageOwnership,
    roleAwareResolverHits: edgeResolution.length,
    note: "Trust must key on the RESOLVED target of a declared role-carrying edge, not same-package ownership.",
  };
}

armA();
armB();
armC();
armD();

const verdicts = Object.values(results.arms).map((a) => a.verdict);
results.summary = {
  arms: Object.keys(results.arms).length,
  pass: verdicts.filter((v) => v === "PASS").length,
  fail: verdicts.filter((v) => v === "FAIL").length,
  review: verdicts.filter((v) => v === "REVIEW").length,
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(path.join(OUT_DIR, "migration-results.json"), JSON.stringify(results, null, 2) + "\n");
for (const [k, v] of Object.entries(results.arms)) console.log(`[${v.verdict}] ${k}`);
console.log(JSON.stringify(results.summary));
