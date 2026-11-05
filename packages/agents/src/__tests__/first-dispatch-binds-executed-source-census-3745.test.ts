/**
 * cinatra#3745 — CENSUS: every direct first-task send to WayFlow binds the
 * executed source first.
 *
 * A run's later callbacks are checked against the source bound to the run. A
 * first task sent without that binding would leave the run's callbacks with
 * nothing to be checked against, so each first-task send selects the loader's
 * source (`selectWayflowRunStepToolPolicy`) and binds it to the run's attempt
 * (`bindRunStepToolPolicy`) before its `sendTask`.
 *
 * The other sends are resumes of a run that was already dispatched: they bind
 * nothing new. The stopped-orchestrator resume dispatches under a fresh attempt,
 * so it carries the run's one binding to that attempt in its `queued -> running`
 * claim, before its send.
 *
 * A new `sendTask` call site anywhere under `src/` or `packages/` fails this
 * census until it is classified here.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SEND = ".sendTask(";

/** First-task sends: each one must bind before it sends. */
const FIRST_TASK_SENDS = ["packages/agents/src/execution.ts", "src/lib/host-content-editor-dispatch.ts"];
/** Resumes of a dispatched run: not first tasks. */
const RESUME_SENDS = [
  "packages/agents/src/artifact-review-resume-delivery.ts",
  "packages/agents/src/mcp/handlers.ts",
  "packages/agents/src/orchestrator-actions.ts",
  "packages/agents/src/review-task-actions.ts",
];

const SKIP_DIRS = new Set(["node_modules", "__tests__", "dist", "build", ".next", "coverage", "generated-fixtures"]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) sourceFiles(join(dir, entry.name), out);
    } else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry.name) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

const rel = (abs: string) => relative(REPO_ROOT, abs).split(sep).join("/");
const read = (relPath: string) => readFileSync(join(REPO_ROOT, relPath), "utf8");

/** The offsets of every `.sendTask(` in a file's code (comment lines are not call sites). */
function sends(text: string): number[] {
  const at: number[] = [];
  let lineStart = 0;
  for (const line of text.split("\n")) {
    const lead = line.trimStart();
    if (!lead.startsWith("//") && !lead.startsWith("*") && !lead.startsWith("/*")) {
      for (let i = line.indexOf(SEND); i !== -1; i = line.indexOf(SEND, i + 1)) at.push(lineStart + i);
    }
    lineStart += line.length + 1;
  }
  return at;
}

/** The text of the top-level function that holds `offset`, up to `offset`. */
function functionPrefix(text: string, offset: number): string {
  const head = text.slice(0, offset);
  const starts = [...head.matchAll(/^(?:export\s+)?(?:async\s+)?function\s/gm)];
  const start = starts.at(-1)?.index;
  if (start === undefined) throw new Error("a send outside any top-level function");
  return head.slice(start);
}

describe("T-P1a-census: every direct first-task send to WayFlow binds the executed source first", () => {
  it("every sendTask call site under src/ and packages/ is classified as a first task or a resume", () => {
    const found = new Map<string, number>();
    for (const root of ["src", "packages"]) {
      for (const file of sourceFiles(join(REPO_ROOT, root))) {
        const n = sends(readFileSync(file, "utf8")).length;
        if (n > 0) found.set(rel(file), n);
      }
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
      expect(prefix.slice(bind)).not.toContain(SEND);
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
