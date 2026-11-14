import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const contractPath = path.join(rootPath, "tests/e2e/design/conformance/contract.ts");
const contract = ts.createSourceFile(contractPath, readFileSync(contractPath, "utf8"), ts.ScriptTarget.Latest, true);
const helpers = ["waitForControlHydration", "resolveUploadReference"].map((name) => {
  const helper = contract.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!helper) throw new Error(`The actual driver helper ${name} is missing`);
  return helper;
});
const hydrationPath = path.join(rootPath, "tests/e2e/config/hydration.ts");
const hydration = ts.createSourceFile(hydrationPath, readFileSync(hydrationPath, "utf8"), ts.ScriptTarget.Latest, true);
const hydrationTimeout = hydration.statements.flatMap((node) => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
  .find((node) => ts.isIdentifier(node.name) && node.name.text === "HYDRATION_TIMEOUT_MS");
if (!hydrationTimeout?.initializer) throw new Error("The actual hydration timeout binding is missing");

function literal(source, name) {
  const declaration = source.statements.flatMap((node) => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
    .find((node) => ts.isIdentifier(node.name) && node.name.text === name);
  if (!declaration || !ts.isStringLiteral(declaration.initializer)) {
    throw new Error(`Expected the driver's actual string binding for ${name}`);
  }
  return declaration.initializer.text;
}

const fixturePath = path.join(rootPath, "src/app/design-fixtures/conformance/upload-extension-fixture-data.ts");
const fixture = ts.createSourceFile(fixturePath, readFileSync(fixturePath, "utf8"), ts.ScriptTarget.Latest, true);
const url = literal(fixture, "UPLOAD_CONFORMANCE_REPO_URL");
const panelSelector = literal(contract, "UPLOAD_PANEL_NODE");
const clickSelector = literal(contract, "UPLOAD_RESOLVE_CONTROL");

// Execute both exact committed helpers and the imported timeout initializer,
// including the real React-fiber predicate. Only their locator and expectation
// ports are deterministic doubles: no page, application, server or database.
const compiledHelpers = ts.transpileModule([
  `const HYDRATION_TIMEOUT_MS = ${hydrationTimeout.initializer.getText(hydration)};`,
  ...helpers.map((helper) => helper.getText(contract)),
].join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const instantiate = new Function("expect", "UPLOAD_PANEL_NODE", "UPLOAD_RESOLVE_CONTROL", "UPLOAD_CONFORMANCE_REPO_URL", `${compiledHelpers}\nreturn { resolveUploadReference, hydrationTimeoutMs: HYDRATION_TIMEOUT_MS };`);

function harness({ lostFirstFill = false, firstFillTimeout = false, swallowedFirstClick = false, disabled = false, missingPanel = false, initiallyVisible = false, inputHydratesAfter = 0, submitHydratesAfter = 0, inputReactKey = "__reactFiber$input", submitReactKey = "__reactFiber$submit" } = {}) {
  const events = [];
  let elapsed = 0;
  let deadline = Infinity;
  let fills = 0;
  let clicks = 0;
  let value = "";
  let visible = initiallyVisible;
  function waitThenFail(options, reason) {
    const remaining = deadline - elapsed;
    // Playwright timeout=0 (including its unconfigured default) leaves this
    // action waiting until the enclosing test/retry budget is consumed.
    elapsed += options?.timeout > 0 ? Math.min(options.timeout, remaining) : remaining;
    throw new Error(reason);
  }
  function evaluateControl(control, hydratesAfter, reactKey) {
    let samples = 0;
    return async (predicate) => {
      samples += 1;
      const element = samples > hydratesAfter ? { [reactKey]: {} } : {};
      const hydrated = predicate(element);
      events.push({ kind: "evaluate", control, hydrated });
      return hydrated;
    };
  }
  const panel = { kind: "actual panel locator" };
  const input = {
    evaluate: evaluateControl("input", inputHydratesAfter, inputReactKey),
    async fill(next, options) {
      fills += 1;
      events.push({ kind: "fill", value: next, options });
      if (firstFillTimeout && fills === 1) waitThenFail(options, "field not ready");
      value = lostFirstFill && fills === 1 ? "" : next;
      visible = false; // The real form's refill clears a previous resolution.
    },
  };
  const submit = {
    evaluate: evaluateControl("submit", submitHydratesAfter, submitReactKey),
    async click(options) {
      clicks += 1;
      events.push({ kind: "click", options });
      if (options?.force) throw new Error("A forced Continue would bypass the acceptance contract");
      if (disabled || !value) waitThenFail(options, "Continue is disabled");
      visible = !missingPanel && !(swallowedFirstClick && clicks === 1);
    },
  };
  const root = {
    locator(selector) {
      if (selector === panelSelector) return panel;
      if (selector === clickSelector) return submit;
      if (selector === "#github-repo-url") return input;
      throw new Error(`Unexpected upload selector ${selector}`);
    },
  };
  const browserExpect = (actual) => typeof actual === "function" ? {
    async toPass(options) {
      events.push({ kind: "retry", options });
      deadline = elapsed + options.timeout;
      let failure;
      do {
        try { await actual(); return; } catch (error) { failure = error; }
        // Account for the real retry scheduler's delay without sleeping.
        elapsed += Math.min(100, deadline - elapsed);
      } while (elapsed < deadline);
      throw failure;
    },
  } : {
    async toBeVisible(options) {
      if (actual !== panel) throw new Error("The driver must assert its resolved panel");
      events.push({ kind: "visible", options });
      if (!visible) waitThenFail(options, "Resolved panel is not visible");
    },
  };
  browserExpect.poll = (sample, options) => ({
    async toBe(expected) {
      events.push({ kind: "poll", options });
      const pollDeadline = elapsed + options.timeout;
      do {
        if (await sample() === expected) return;
        elapsed += Math.min(100, pollDeadline - elapsed);
      } while (elapsed < pollDeadline);
      throw new Error(options.message);
    },
  });
  const { resolveUploadReference: run, hydrationTimeoutMs } = instantiate(browserExpect, panelSelector, clickSelector, url);
  return { run: () => run(root), events, panel, fills: () => fills, clicks: () => clicks, elapsed: () => elapsed, hydrationTimeoutMs };
}

describe("upload reference retry retains its acceptance and overall budget", () => {
  it("refills after a lost first fill leaves Continue disabled", async () => {
    const h = harness({ lostFirstFill: true });
    await expect(h.run()).resolves.toBe(h.panel);
    expect(h.fills()).toBe(2);
    expect(h.events.filter((event) => event.kind === "fill").map((event) => event.value)).toEqual([url, url]);
  });

  it("retries when the field's first fill itself times out", async () => {
    const h = harness({ firstFillTimeout: true });
    await expect(h.run()).resolves.toBe(h.panel);
    expect(h.fills()).toBe(2);
  });

  it("bounds both browser actions inside the existing retry budget", async () => {
    const h = harness();
    await h.run();
    for (const event of h.events.filter((event) => ["fill", "click"].includes(event.kind))) {
      expect(event.options?.timeout ?? 0).toBeGreaterThan(0);
      expect(event.options.timeout).toBeLessThanOrEqual(5_000);
      expect(event.options.force).not.toBe(true);
    }
    expect(h.events.find((event) => event.kind === "retry").options).toEqual({ timeout: 30_000 });
    expect(h.events.find((event) => event.kind === "visible").options).toEqual({ timeout: 5_000 });
  });

  it("still refills when an enabled click is swallowed before hydration", async () => {
    const h = harness({ swallowedFirstClick: true });
    await expect(h.run()).resolves.toBe(h.panel);
    expect(h.fills()).toBe(2);
  });

  it("still refuses a permanently disabled Continue", async () => {
    const h = harness({ disabled: true });
    await expect(h.run()).rejects.toThrow("Continue is disabled");
    expect(h.elapsed()).toBe(30_000);
    expect(h.events.some((event) => event.kind === "visible")).toBe(false);
  });

  it("still refuses a click that never mounts the resolved panel", async () => {
    const h = harness({ missingPanel: true });
    await expect(h.run()).rejects.toThrow("Resolved panel is not visible");
    expect(h.elapsed()).toBe(30_000);
  });

  it("returns the resolved locator after a normal fill and click", async () => {
    const h = harness();
    await expect(h.run()).resolves.toBe(h.panel);
    expect(h.events.filter((event) => !["poll", "evaluate"].includes(event.kind)).map((event) => event.kind)).toEqual(["retry", "fill", "click", "visible"]);
  });

  it("does not accept a panel left over from an earlier resolution", async () => {
    const h = harness({ initiallyVisible: true, missingPanel: true });
    await expect(h.run()).rejects.toThrow("Resolved panel is not visible");
  });
});


describe("upload reference waits for each control's real React hydration predicate", () => {
  it("polls both controls to hydration before the first fill or click", async () => {
    const h = harness({ inputHydratesAfter: 2, submitHydratesAfter: 1 });
    await expect(h.run()).resolves.toBe(h.panel);
    const firstAction = h.events.findIndex((event) => ["fill", "click"].includes(event.kind));
    const preceding = h.events.slice(0, firstAction);
    expect(preceding.filter((event) => event.kind === "evaluate").map(({ control, hydrated }) => [control, hydrated])).toEqual([
      ["input", false], ["input", false], ["input", true], ["submit", false], ["submit", true],
    ]);
    const polls = preceding.filter((event) => event.kind === "poll");
    expect(polls).toHaveLength(2);
    for (const poll of polls) {
      expect(poll.options).toEqual({ timeout: h.hydrationTimeoutMs, message: "the control did not hydrate before interaction" });
      expect(poll.options.timeout).toBeGreaterThan(0);
    }
    expect(h.fills()).toBe(1);
    expect(h.clicks()).toBe(1);
  });

  it.each([
    ["input", { inputHydratesAfter: Infinity }],
    ["Continue", { submitHydratesAfter: Infinity }],
  ])("refuses an unhydrated %s before any fill or click", async (_name, options) => {
    const h = harness(options);
    await expect(h.run()).rejects.toThrow("the control did not hydrate before interaction");
    expect(h.elapsed()).toBe(h.hydrationTimeoutMs);
    expect(h.fills()).toBe(0);
    expect(h.clicks()).toBe(0);
    expect(h.events.some((event) => ["retry", "visible"].includes(event.kind))).toBe(false);
  });

  it("does not treat a similarly named element key as a React fiber", async () => {
    const h = harness({ inputReactKey: "__reactFiberWithoutDollar" });
    await expect(h.run()).rejects.toThrow("the control did not hydrate before interaction");
    expect(h.fills()).toBe(0);
    expect(h.clicks()).toBe(0);
  });
});
