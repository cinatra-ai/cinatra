import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// cinatra#4131: the design check of the upload form's "loading" state typed
// the link before the form had hydrated. That first fill never reached the
// form's state, refilling the same link changed nothing, and Continue stayed
// disabled for the whole retry. This suite executes the exact committed
// loading driver and hydration helper against deterministic doubles of the
// form: no page, application, server or database.
const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const contractPath = path.join(rootPath, "tests/e2e/design/conformance/contract.ts");
const contract = ts.createSourceFile(contractPath, readFileSync(contractPath, "utf8"), ts.ScriptTarget.Latest, true);

function declaration(source, name) {
  return source.statements.flatMap((node) => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
    .find((node) => ts.isIdentifier(node.name) && node.name.text === name);
}

function property(objectLiteral, name) {
  if (!objectLiteral || !ts.isObjectLiteralExpression(objectLiteral)) throw new Error(`Expected an object literal holding ${name}`);
  const found = objectLiteral.properties.find((node) => ts.isPropertyAssignment(node) && node.name.getText(contract) === name);
  if (!found) throw new Error(`The actual driver property ${name} is missing`);
  return found.initializer;
}

function literal(source, name) {
  const found = declaration(source, name);
  if (!found || !ts.isStringLiteral(found.initializer)) throw new Error(`Expected the driver's actual string binding for ${name}`);
  return found.initializer.text;
}

const driver = declaration(contract, "UPLOAD_GITHUB_FORM_DRIVER");
if (!driver?.initializer) throw new Error("The actual upload form driver is missing");
const loading = property(property(driver.initializer, "states"), "loading");
if (!ts.isArrowFunction(loading)) throw new Error("The actual loading driver is not an arrow function");
const hydrationHelper = contract.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "waitForControlHydration");
if (!hydrationHelper) throw new Error("The actual driver helper waitForControlHydration is missing");
const hydrationPath = path.join(rootPath, "tests/e2e/config/hydration.ts");
const hydration = ts.createSourceFile(hydrationPath, readFileSync(hydrationPath, "utf8"), ts.ScriptTarget.Latest, true);
const hydrationTimeout = declaration(hydration, "HYDRATION_TIMEOUT_MS");
if (!hydrationTimeout?.initializer) throw new Error("The actual hydration timeout binding is missing");

const fixturePath = path.join(rootPath, "src/app/design-fixtures/conformance/upload-extension-fixture-data.ts");
const fixture = ts.createSourceFile(fixturePath, readFileSync(fixturePath, "utf8"), ts.ScriptTarget.Latest, true);
const url = literal(fixture, "UPLOAD_CONFORMANCE_REPO_URL");
const formSelector = literal(contract, "UPLOAD_FORM_NODE");
const clickSelector = literal(contract, "UPLOAD_RESOLVE_CONTROL");
const mountSelector = "upload form mount";

const compiled = ts.transpileModule([
  `const HYDRATION_TIMEOUT_MS = ${hydrationTimeout.initializer.getText(hydration)};`,
  hydrationHelper.getText(contract),
  `const loading = ${loading.getText(contract)};`,
].join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const instantiate = new Function("expect", "UPLOAD_RESOLVE_CONTROL", "UPLOAD_FORM_NODE", "UPLOAD_GITHUB_FORM_MOUNT", "UPLOAD_CONFORMANCE_REPO_URL",
  `${compiled}\nreturn { loading, hydrationTimeoutMs: HYDRATION_TIMEOUT_MS };`);

// The form's controls hydrate at `hydratesAt` simulated milliseconds. A fill
// before that sets the field's text but never the form's state; React then
// adopts that text as the field's tracked value, so a later fill of the SAME
// link is no change and Continue stays disabled (the issue's CI logs: 'element
// is not enabled' through the whole 30 s retry).
function harness({ hydratesAt = 0, disabled = false } = {}) {
  const events = [];
  let elapsed = 0;
  let deadline = Infinity;
  let fills = 0;
  let clicks = 0;
  let typed = "";
  let state = "";
  let lostFill = false;
  let lookingUp = false;
  const hydrated = () => elapsed >= hydratesAt;
  const enabled = () => !disabled && state !== "";
  function waitThenFail(options, reason) {
    const remaining = deadline - elapsed;
    elapsed += options?.timeout > 0 ? Math.min(options.timeout, remaining) : remaining;
    throw new Error(reason);
  }
  const hydrationProbe = (control) => async (predicate) => {
    const isHydrated = predicate(hydrated() ? { "__reactFiber$double": {} } : {});
    events.push({ kind: "evaluate", control, hydrated: isHydrated });
    return isHydrated;
  };
  const input = {
    evaluate: hydrationProbe("input"),
    async fill(next, options) {
      fills += 1;
      events.push({ kind: "fill", value: next, options, hydrated: hydrated() });
      if (!hydrated()) {
        typed = next;
        lostFill = true;
        return;
      }
      if (lostFill && next === typed) return;
      typed = next;
      state = next;
    },
  };
  const submit = {
    evaluate: hydrationProbe("submit"),
    async click(options) {
      events.push({ kind: "click", options });
      if (options?.force) throw new Error("A forced Continue would bypass the acceptance contract");
      if (!enabled()) waitThenFail(options, "Continue is disabled");
      clicks += 1;
      lookingUp = true;
    },
  };
  const form = {
    async evaluate(_fn, arg) {
      if (arg && typeof arg === "object" && "mountSelector" in arg) {
        events.push({ kind: "observe" });
        return undefined;
      }
      if (arg && typeof arg === "object" && "formSelector" in arg) {
        return lookingUp ? { state: "loading", text: "Looking up…" } : null;
      }
      return undefined;
    },
    async dispose() {},
  };
  const root = {
    locator(selector) {
      if (selector === "#github-repo-url") return input;
      if (selector === clickSelector) return submit;
      if (selector === formSelector) return { elementHandle: async () => form };
      throw new Error(`Unexpected upload selector ${selector}`);
    },
  };
  const containing = (text) => ({ containing: text });
  const matches = (actual, wanted) => actual !== null && typeof actual === "object"
    && Object.entries(wanted).every(([key, value]) => value && typeof value === "object" && "containing" in value
      ? typeof actual[key] === "string" && actual[key].includes(value.containing)
      : actual[key] === value);
  const browserExpect = (actual) => typeof actual === "function" ? {
    async toPass(options) {
      events.push({ kind: "retry", options });
      deadline = elapsed + options.timeout;
      let failure;
      do {
        try { await actual(); return; } catch (error) { failure = error; }
        elapsed += Math.min(100, deadline - elapsed);
      } while (elapsed < deadline);
      throw failure;
    },
  } : {
    async toBeEnabled(options) {
      if (actual !== submit) throw new Error("The driver must read Continue itself");
      events.push({ kind: "enabled", options });
      if (!enabled()) waitThenFail(options, "Continue is not enabled");
    },
  };
  browserExpect.stringContaining = containing;
  browserExpect.poll = (sample, options) => {
    const run = async (accept, message) => {
      events.push({ kind: "poll", options });
      const pollDeadline = elapsed + options.timeout;
      do {
        if (accept(await sample())) return;
        elapsed += Math.min(100, pollDeadline - elapsed);
      } while (elapsed < pollDeadline);
      throw new Error(message);
    };
    return {
      toBe: (expected) => run((value) => value === expected, options.message),
      toEqual: (expected) => run((value) => matches(value, expected), "The loading witness was not seen"),
    };
  };
  const { loading: run, hydrationTimeoutMs } = instantiate(browserExpect, clickSelector, formSelector, mountSelector, url);
  return {
    run: () => run(undefined, root),
    events,
    fills: () => fills,
    clicks: () => clicks,
    elapsed: () => elapsed,
    hydrationTimeoutMs,
  };
}

describe("upload form loading driver presses a ready Continue (cinatra#4131)", () => {
  it("waits for hydration, so a form that hydrates late still reaches its loading state", async () => {
    const h = harness({ hydratesAt: 500 });
    await expect(h.run()).resolves.toBeUndefined();
    expect(h.events.filter((event) => event.kind === "fill").map((event) => event.hydrated)).toEqual([true]);
    expect(h.clicks()).toBe(1);
  });

  it("reads Continue enabled inside the retry, after the fill and before the press", async () => {
    const h = harness();
    await expect(h.run()).resolves.toBeUndefined();
    const order = h.events.filter((event) => ["retry", "fill", "enabled", "click"].includes(event.kind));
    expect(order.map((event) => event.kind)).toEqual(["retry", "fill", "enabled", "click"]);
    expect(order[2].options).toEqual({ timeout: 2_000 });
  });

  it("refuses a form that never hydrates before any fill or press", async () => {
    const h = harness({ hydratesAt: Infinity });
    await expect(h.run()).rejects.toThrow("the control did not hydrate before interaction");
    expect(h.fills()).toBe(0);
    expect(h.events.some((event) => event.kind === "click")).toBe(false);
  });

  it("still fails a Continue that never enables, at the retry's own 30 s", async () => {
    const h = harness({ disabled: true });
    await expect(h.run()).rejects.toThrow(/Continue is (not enabled|disabled)/);
    expect(h.elapsed()).toBe(30_000);
    expect(h.clicks()).toBe(0);
  });

  it("keeps the retry, press and witness bounds", async () => {
    const h = harness();
    await h.run();
    expect(h.events.find((event) => event.kind === "retry").options).toEqual({ timeout: 30_000 });
    for (const event of h.events.filter((event) => ["fill", "click"].includes(event.kind))) {
      expect(event.options).toEqual({ timeout: 5_000 });
    }
    expect(h.events.filter((event) => event.kind === "poll").at(-1).options).toEqual({ timeout: 2_000 });
  });
});
