/**
 * E2 — ONE REQUEST BUILDER, AND IT NARROWS NOTHING (cinatra#3487).
 *
 * The ruling: "ONE request builder at the network boundary shared by the chat
 * composer and the run page's window, with NO parameter that narrows tools,
 * intents or capabilities — the screen context is a separate, additive
 * argument." And the enforcement: "a structural invariant on the request
 * builder: every prompt-window mount calls the one exported builder, whose
 * signature carries no allowlist, filter or mode parameter; a second builder, a
 * filtering wrapper or a new parameter of that kind fails by name."
 *
 * WHAT THE THREE MODULES ARE.
 *   - `src/lib/assistant-runtime/cinatra-assistant-config.ts` —
 *     `buildCinatraAssistantRuntimeConfig()` is the builder at the network
 *     boundary: it is what fixes the turn's tool surface and capability set,
 *     and BOTH roads call it. It takes no parameters, so no caller can hand it
 *     a narrower world.
 *   - `src/lib/lifecycle/run-window-turn.ts` — the one server road a prompt
 *     window's turn takes, which calls that builder and `runAssistantTurn`
 *     exactly as the chat road does.
 *   - `packages/agents/src/run-window-actions.ts` — the one client bridge every
 *     window reaches it through.
 *
 * NO WAIVER, NO ENVIRONMENT SWITCH, NO SKIP (E6).
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-window-request-builder.invariant.test.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../../..");

/** THE ONE BUILDER at the network boundary, named once. */
const BUILDER_NAME = "buildCinatraAssistantRuntimeConfig";
const BUILDER_MODULE = "src/lib/assistant-runtime/cinatra-assistant-config.ts";
/** THE ONE SERVER ROAD a prompt window's turn takes. */
const WINDOW_TURN_MODULE = "src/lib/lifecycle/run-window-turn.ts";
/** THE ONE CLIENT BRIDGE the windows reach it through. */
const WINDOW_BRIDGE_MODULE = "packages/agents/src/run-window-actions.ts";
/** THE CHAT COMPOSER'S OWN ROAD, for the byte-equal comparison below. */
const CHAT_RUNNER_MODULE = "src/app/api/chat/runner.ts";

/**
 * A PARAMETER OF THIS KIND IS THE THING THE RULING FORBIDS: anything that
 * would let one caller be served a smaller world than another.
 */
const NARROWING =
  /\b(allow|allowList|allowlist|allowedTools|filter|toolFilter|mode|toolMode|tools|toolset|capabilities|capabilitySet|deny|denyList|restrict|restrictTo|onlyTools|subset|scopeTools|disableTools|withoutTools)\b/i;

const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

/** The parameter list of a named function declaration, verbatim. */
function parameterListOf(source: string, fn: string): string {
  const at = source.indexOf(`function ${fn}(`);
  expect(at, `${fn} is not declared in the module the invariant reads`).toBeGreaterThan(-1);
  const open = source.indexOf("(", at);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const c = source[i];
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated parameter list for ${fn}`);
}

/** The body of the first `type <name> = { … }` in a module. */
function typeBodyOf(source: string, typeName: string): string {
  const at = source.indexOf(`type ${typeName} = {`);
  expect(at, `${typeName} is not declared in the module the invariant reads`).toBeGreaterThan(-1);
  const open = source.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const c = source[i];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated type body for ${typeName}`);
}

/** Top-level field names of a type body, comments stripped. */
function fieldNamesOf(body: string): string[] {
  const withoutComments = body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const names: string[] = [];
  let depth = 0;
  let atLineStart = true;
  let buffer = "";
  for (const ch of withoutComments) {
    if (ch === "{" || ch === "(" || ch === "[") depth += 1;
    else if (ch === "}" || ch === ")" || ch === "]") depth -= 1;
    if (ch === "\n") {
      if (depth === 0 && atLineStart) {
        const m = /^\s*([A-Za-z_$][\w$]*)\s*\??\s*:/.exec(buffer);
        if (m) names.push(m[1]);
      }
      buffer = "";
      atLineStart = true;
      continue;
    }
    buffer += ch;
  }
  const m = /^\s*([A-Za-z_$][\w$]*)\s*\??\s*:/.exec(buffer);
  if (m) names.push(m[1]);
  return names;
}

const SKIP_DIR = new Set(["node_modules", ".next", ".git", "dist", "build", "coverage", "__tests__"]);
const SOURCE_EXT = new Set([".ts", ".tsx"]);

function productFiles(roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIR.has(entry)) continue;
      const full = path.join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!SOURCE_EXT.has(path.extname(entry))) continue;
      if (/\.(test|spec)\.[cm]?tsx?$/.test(entry)) continue;
      out.push(full);
    }
  };
  for (const root of roots) {
    const abs = path.join(REPO_ROOT, root);
    if (existsSync(abs)) walk(abs);
  }
  return out;
}

describe("E2 — one request builder, carrying no narrowing parameter", () => {
  it("the builder takes no parameters at all", () => {
    const params = parameterListOf(read(BUILDER_MODULE), BUILDER_NAME).trim();
    expect(
      params,
      `${BUILDER_NAME} must take no parameter — a parameter here is how one ` +
        `caller gets a smaller world than another (cinatra#3487).`,
    ).toBe("");
  });

  it("every call site calls it with no argument", () => {
    const offenders: string[] = [];
    for (const file of productFiles(["src", "packages"])) {
      const text = readFileSync(file, "utf8");
      if (!text.includes(`${BUILDER_NAME}(`)) continue;
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
      const calls = text.match(new RegExp(`${BUILDER_NAME}\\(([^)]*)\\)`, "g")) ?? [];
      for (const call of calls) {
        const arg = call.slice(BUILDER_NAME.length + 1, -1).trim();
        if (arg !== "") offenders.push(`${rel}: ${call}`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("the chat composer's road and the window's road call the same builder", () => {
    const chat = read(CHAT_RUNNER_MODULE);
    const window_ = read(WINDOW_TURN_MODULE);
    expect(chat).toContain(`runAssistantTurn(${BUILDER_NAME}()`);
    expect(window_).toContain(`runAssistantTurn(${BUILDER_NAME}()`);
  });

  it("the window turn's input carries no allowlist, filter or mode field", () => {
    const source = read(WINDOW_TURN_MODULE);
    const fields = fieldNamesOf(typeBodyOf(source, "RunWindowTurnInput"));
    expect(fields.length).toBeGreaterThan(0);
    const narrowing = fields.filter((f) => NARROWING.test(f));
    expect(
      narrowing,
      `RunWindowTurnInput must carry no narrowing field; found: ${narrowing.join(", ")}`,
    ).toEqual([]);
    // The screen's context is ADDITIVE and named: the surface it is, the run it
    // belongs to, the card it sits under. Nothing else may be added here
    // without this literal moving, which is a high-risk path.
    expect(fields.sort()).toEqual(["boundCard", "prompt", "runId", "surface"]);
  });

  it("there is exactly one client bridge that sends a window turn", () => {
    const bridge = read(WINDOW_BRIDGE_MODULE);
    const senders = [...bridge.matchAll(/export\s+async\s+function\s+(\w*[Tt]urn\w*)\s*\(/g)].map(
      (m) => m[1],
    );
    expect(senders).toEqual(["sendRunWindowTurn"]);
    const params = parameterListOf(bridge, "sendRunWindowTurn");
    const fields = fieldNamesOf(params.replace(/^[^{]*\{/, "").replace(/\}[^}]*$/, ""));
    const narrowing = fields.filter((f) => NARROWING.test(f));
    expect(narrowing, `sendRunWindowTurn narrows by: ${narrowing.join(", ")}`).toEqual([]);
  });

  it("no second module answers a prompt window's turn", () => {
    const offenders: string[] = [];
    for (const file of productFiles(["src", "packages"])) {
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
      if (rel === WINDOW_TURN_MODULE) continue;
      const text = readFileSync(file, "utf8");
      if (/\bexport\s+(async\s+)?function\s+runWindowTurn\b/.test(text)) offenders.push(rel);
    }
    expect(offenders, offenders.join(", ")).toEqual([]);
  });

  it("every prompt-window mount reaches the bridge through the one controller", () => {
    // The panel is mounted in exactly one place (E1); that module reaches the
    // network through `use-run-window-conversation`, which is the only module
    // that imports the bridge's sender.
    const importers: string[] = [];
    for (const file of productFiles(["src", "packages"])) {
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
      if (rel === WINDOW_BRIDGE_MODULE) continue;
      const text = readFileSync(file, "utf8");
      if (/sendRunWindowTurn/.test(text)) importers.push(rel);
    }
    expect(importers).toEqual(["packages/agents/src/use-run-window-conversation.ts"]);
  });

  it("carries no waiver flag, environment switch or skip list (E6)", () => {
    const self = readFileSync(
      path.join(__dirname, "run-window-request-builder.invariant.test.ts"),
      "utf8",
    );
    expect(/\b(it|describe|test)\.(skip|todo)\b/.test(self)).toBe(false);
  });
});
