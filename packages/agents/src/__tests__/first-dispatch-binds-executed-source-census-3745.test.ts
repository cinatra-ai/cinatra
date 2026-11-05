/**
 * cinatra#3745 — CENSUS: every direct first-task send to WayFlow binds the
 * executed source first.
 *
 * A later part of the stack checks a run's callbacks against the source bound
 * to the run. A first task sent without that binding would leave them nothing
 * to be checked against, so each first-task send selects the loader's
 * source (`selectWayflowRunStepToolPolicy`) and binds it to the run's attempt
 * (`bindRunStepToolPolicy`) before its `sendTask`.
 *
 * The other sends are resumes of a run that was already dispatched: they bind
 * nothing new. The stopped-orchestrator resume dispatches under a fresh attempt,
 * so it carries the run's one binding to that attempt in its `queued -> running`
 * claim, before its send.
 *
 * A new `sendTask` call site in any file git tracks under `src/` or `packages/` (dot-directories, `build` and
 * `dist` included; test files excluded) fails this census until it is classified here. A site is a member call
 * (`.sendTask(`, `.sendTask?.(`) or a destructured `sendTask`; comment lines are not sites.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
/** A member call of sendTask (optional call included), or sendTask taken out of an object by destructuring. */
const SITE = /\.sendTask\s*(?:\?\.)?\s*\(|[{,]\s*sendTask\s*[,}:]/g;

/** First-task sends: each one must bind before it sends. */
const FIRST_TASK_SENDS = ["packages/agents/src/execution.ts", "src/lib/host-content-editor-dispatch.ts"];
/** Resumes of a dispatched run: not first tasks. */
const RESUME_SENDS = [
  "packages/agents/src/artifact-review-resume-delivery.ts",
  "packages/agents/src/mcp/handlers.ts",
  "packages/agents/src/orchestrator-actions.ts",
  "packages/agents/src/review-task-actions.ts",
];

/** Every tracked source file under src/ and packages/ (the index, so a file in any directory is seen). */
function sourceFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z", "--", "src", "packages"], { cwd: REPO_ROOT, maxBuffer: 1 << 28 })
    .toString("utf8").split("\0").filter(Boolean)
    .filter((f) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(f) && !f.endsWith(".d.ts"))
    .filter((f) => !/(^|\/)__tests__\//.test(f) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(f));
}

const read = (relPath: string) => readFileSync(join(REPO_ROOT, relPath), "utf8");
const isComment = (line: string) => { const lead = line.trimStart(); return lead.startsWith("//") || lead.startsWith("*") || lead.startsWith("/*"); };
/** The text with its comment lines blanked (offsets kept), so a commented-out call is no call. */
const code = (text: string) => text.split("\n").map((line) => (isComment(line) ? " ".repeat(line.length) : line)).join("\n");

/** The offsets of every send site in a file's code. */
function sends(text: string): number[] {
  return [...code(text).matchAll(SITE)].map((m) => m.index!);
}

/** The code of the top-level function that holds `offset`, up to `offset`. */
function functionPrefix(text: string, offset: number): string {
  const head = code(text).slice(0, offset);
  const starts = [...head.matchAll(/^(?:export\s+)?(?:async\s+)?function\s/gm)];
  const start = starts.at(-1)?.index;
  if (start === undefined) throw new Error("a send outside any top-level function");
  return head.slice(start);
}

describe("T-P1a-census: every direct first-task send to WayFlow binds the executed source first", () => {
  it("every tracked sendTask call site under src/ and packages/ is classified as a first task or a resume", () => {
    const found = new Map<string, number>();
    for (const file of sourceFiles()) {
      const n = sends(read(file)).length;
      if (n > 0) found.set(file, n);
    }
    const classified = [...FIRST_TASK_SENDS, ...RESUME_SENDS].sort();
    expect([...found.keys()].sort()).toEqual(classified);
    for (const file of classified) expect({ file, sends: found.get(file) }).toEqual({ file, sends: 1 });
  });

  for (const file of FIRST_TASK_SENDS) {
    it(`${file}: selects the loader's source, then binds it, then sends`, () => {
      const text = read(file);
      const [send] = sends(text);
      const prefix = functionPrefix(text, send!);
      const select = prefix.lastIndexOf("selectWayflowRunStepToolPolicy(");
      const bind = prefix.lastIndexOf("await bindRunStepToolPolicy(");
      expect(select, "the send's function selects the loader's source").toBeGreaterThan(-1);
      expect(bind, "the send's function awaits the bind").toBeGreaterThan(select);
      // Nothing between the bind and the send skips the bind: no early send.
      expect(prefix.slice(bind).match(SITE)).toBeNull();
    });
  }

  for (const file of RESUME_SENDS) {
    it(`${file}: a resume binds nothing new`, () => {
      const text = read(file);
      const [send] = sends(text);
      expect(functionPrefix(text, send!)).not.toContain("bindRunStepToolPolicy(");
    });
  }

  it("the stopped-orchestrator resume carries the binding in its queued -> running claim, before it sends", () => {
    const text = read("packages/agents/src/orchestrator-actions.ts");
    const [send] = sends(text);
    const prefix = functionPrefix(text, send!);
    const claim = prefix.search(/transitionRunStatus\(runId, "queued", "running", \{\s*dispatch: \{ attemptId, carryBoundStepToolPolicy: true \}/);
    expect(claim).toBeGreaterThan(-1);
  });
});
