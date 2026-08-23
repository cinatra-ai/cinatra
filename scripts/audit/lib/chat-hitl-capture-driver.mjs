#!/usr/bin/env node
/**
 * THE CAPTURE DRIVER — the one path from a real browser to a record in the
 * canonical index.
 *
 * WHY IT EXISTS. `observeCapture` is deliberately driver-free: it takes a small
 * `CapturePage` port so the audit tier stays dependency-free and its own tests
 * can run without a browser. That leaves exactly one gap worth closing here:
 * something has to implement that port against a real page, or the observer has
 * no production caller and the index has no honest way to grow. This is it.
 *
 * WHAT IT REFUSES TO DO. It takes no assertions, no counts, no frame URLs from
 * its caller. A cell says WHICH page to open, which host it claims and which
 * kind and state it photographs; everything written down after that is read off
 * the page by `observeCapture`. That is the whole point: a record is a
 * measurement, not a submission.
 *
 * Playwright is imported LAZILY, so requiring this file costs nothing in the
 * audit tier and a machine without browsers can still run every gate test.
 *
 * USAGE, from a checkout with a running app and a signed-in storage state:
 *
 *   node scripts/audit/lib/chat-hitl-capture-driver.mjs \
 *     --plan evidence/<slice>/capture-plan.json \
 *     --out  scripts/ci/chat-hitl-capture-index.json   # the default
 *
 * The plan is a JSON array of cells:
 *   { cell, declaredHost, kind, state, url, screenshot, waitFor?, build?,
 *     storageState?, instance? }
 *
 * `instance` is required only when the page holds SEVERAL cards of the declared
 * kind: it names a value the intended card renders in one of its own attributes,
 * and the recorder refuses an ambiguous page rather than measuring the first
 * match. It selects a card; it never describes one.
 *
 * Exit 0 -> every cell observed and the index written; 1 -> a cell failed its
 * own validation, and the index is NOT written.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { CAPTURE_INDEX_RELATIVE_PATH } from "../../ci/lib/capture-record-contract.mjs";
import {
  CAPTURE_INDEX_SCHEMA_VERSION,
  RECORDER_ID,
  hashFile,
  mergeWalkRecords,
  observeCapture,
  observeWalkCell,
  validateCaptureRecord,
  validateWalkPlan,
  walkCellsOf,
} from "./chat-hitl-capture-recorder.mjs";

/**
 * How many of a locator's matches are actually PAINTED.
 *
 * `locator.count()` counts what is ATTACHED. A card inside a collapsed panel,
 * behind `display:none`, or sized to nothing is attached, satisfies every
 * selector this gate looks for, and appears in no screenshot — so a record built
 * on attachment alone can describe a screen its own image does not show.
 * Playwright's own `isVisible()` is the definition used, per element, rather
 * than a bounding box this file would have to define visibility for itself.
 */
async function paintedCount(locator) {
  const n = await locator.count();
  let painted = 0;
  for (let i = 0; i < n; i += 1) {
    if (await locator.nth(i).isVisible()) painted += 1;
  }
  return painted;
}

/**
 * The attributes each match renders, in DOM order — the raw material the
 * recorder pins a card instance with.
 *
 * EVERY attribute, not a blessed identity list. A closed list of identity
 * spellings (`data-run-id`, `data-entity-id`, …) is a list a rename walks past,
 * and this file has no business deciding which attribute a card slice will use
 * to identify itself. What it can do honestly is write down what the element
 * carries and let the record be checked against it.
 */
async function attributesOfMatches(locator) {
  const n = await locator.count();
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(
      await locator.nth(i).evaluate((el) =>
        Object.fromEntries(Array.from(el.attributes).map((a) => [a.name, a.value])),
      ),
    );
  }
  return out;
}

/**
 * Adapt a Playwright page to the `CapturePage` port.
 *
 * `frame(selector)` resolves the frame BEHIND an element and returns a reader
 * scoped to it, which is what lets the widget host be checked where it actually
 * lives instead of in the embedding page.
 *
 * CARD-SCOPED READS ARE PINNED TO AN ELEMENT, once per capture, by `pinWithin`.
 * The earlier `.first()` answered every card-relative count from whichever root
 * led the DOM: on a transcript holding two cards of one kind that silently
 * measures a card the record never names, and the record carried nothing a
 * reader could check the screenshot against. `identifyWithin` is the other half
 * — it hands the recorder the matches' own attributes so the pin is recorded.
 */
export function playwrightPage(page) {
  /**
   * THE APP PATH, never the origin.
   *
   * A record's `finalUrl` is read for its URL CLASS, and the canonical contract
   * strips the origin before it classifies — so the host and the port carry no
   * meaning here at all. What they do carry is the LANE: the machine the walk
   * ran on and the port it happened to boot the app on, written into a file that
   * is committed and read for years. Every one of the index's existing records
   * stores a path for exactly that reason, and a driver that wrote an absolute
   * URL would make the newest round the only one naming somebody's laptop.
   */
  const pathOnly = (value) => {
    try {
      const u = new URL(value);
      return `${u.pathname}${u.search}${u.hash}`;
    } catch {
      return value;
    }
  };
  const readerFor = (scope, urlOf) => ({
    url: async () => pathOnly(await urlOf()),
    count: async (selector) => scope.locator(selector).count(),
    countVisible: async (selector) => paintedCount(scope.locator(selector)),
    identifyWithin: async (selector) => attributesOfMatches(scope.locator(selector)),
    /**
     * Resolve the `index`-th `root` ONCE and hand back a reader bound to that
     * ELEMENT. Two defects close here, and they close together because they are
     * the same mistake seen from two sides.
     *
     * THE PIN IS AN ELEMENT, NOT AN INDEX. The previous reader re-resolved
     * `locator(root).nth(index)` on every single call. Between the recorder's two
     * measurements a transcript can reorder — a card streams in above another, an
     * optimistic row settles — and `.nth(index)` then answers from a DIFFERENT
     * card. Because the counts are equal, nothing downstream notices. An
     * ElementHandle keeps pointing at the element it resolved to.
     *
     * THE COUNT IS `:scope`-INCLUSIVE. The previous reader counted DESCENDANTS
     * only. The shipped review-gate card renders `data-lifecycle-card`,
     * `data-lifecycle-card-host`, `data-lifecycle-card-state` and its conformance
     * id on ONE element, so a root-scoped count of the card's own declaration
     * came back zero and an HONEST pending capture was refused. Counting the root
     * itself when it matches is what `:scope` means in CSS, and it is what the
     * canonical contract's `root` scope has always meant — its own committed
     * records carry `[data-lifecycle-card-state]` at `root` with a count of 1.
     */
    pinWithin: async (root, index = 0) => {
      const handles = await scope.$$(root);
      const el = handles[index];
      if (!el) return null;
      const matchesSelf = (selector) =>
        el.evaluate((node, sel) => node.matches(sel), selector);
      return {
        count: async (selector) => {
          const descendants = await el.$$(selector);
          return descendants.length + ((await matchesSelf(selector)) ? 1 : 0);
        },
        countVisible: async (selector) => {
          let painted = 0;
          if ((await matchesSelf(selector)) && (await el.isVisible())) painted += 1;
          for (const descendant of await el.$$(selector)) {
            if (await descendant.isVisible()) painted += 1;
          }
          return painted;
        },
      };
    },
  });

  return {
    ...readerFor(page, async () => page.url()),
    frame: async (selector) => {
      const handle = await page.$(selector);
      if (!handle) return null;
      const frame = await handle.contentFrame();
      if (!frame) return null;
      return readerFor(frame, async () => frame.url());
    },
    /**
     * THE SHUTTER, framed as the cell declares.
     *
     * `fullPage: true` was the only framing this file could produce, and it is
     * the WRONG one for a card in a conversation: it scrolls the document out
     * and loses the browser window the maintainer asked to see around the card
     * ("close ups of the card, but I cannot tell the surrounding"). `window`
     * shoots the viewport as the operator sees it. The default stays `page`,
     * so every capture round written before this argument existed frames
     * exactly as it did.
     */
    screenshot: async (absPath, { framing = "page" } = {}) => {
      mkdirSync(dirname(absPath), { recursive: true });
      await page.screenshot({ path: absPath, fullPage: framing !== "window" });
    },
  };
}

/** Open each cell's page and observe it. Returns the records. */
export async function driveCapture({ plan, repoRoot = process.cwd(), log = console.log }) {
  const { chromium } = await import("@playwright/test");
  const records = [];
  const browser = await chromium.launch();
  try {
    for (const cell of plan) {
      const context = await browser.newContext(
        cell.storageState ? { storageState: cell.storageState } : {},
      );
      const page = await context.newPage();
      try {
        await page.goto(cell.url, { waitUntil: "networkidle" });
        if (cell.waitFor) {
          await page.waitForSelector(cell.waitFor, { timeout: 15_000 });
        }
        const record = await observeCapture({
          page: playwrightPage(page),
          cell: cell.cell,
          declaredHost: cell.declaredHost,
          kind: cell.kind,
          state: cell.state,
          // WHICH card, when the page holds more than one of the kind. It
          // selects; it does not describe — the attributes written into the
          // record are the ones read off the card that was found.
          instance: cell.instance ?? null,
          screenshot: cell.screenshot,
          build: cell.build ?? "development",
          repoRoot,
        });
        // Hash the file from disk RATHER than echoing the record: comparing a
        // value to itself proves nothing, and the promise this driver makes is
        // that it never writes an index it has not checked.
        // THE AUDIT TIER, on this driver's OWN output. The validator grades its
        // extras when it reads a committed index, because the canonical driver
        // writes honest records that claim none of them; what THIS driver
        // produces owes every one, and owes it here, before anything is written.
        const violations = validateCaptureRecord(record, {
          hashOf: (rel) => hashFile(resolve(repoRoot, rel)),
          tier: "audit",
        });
        if (violations.length > 0) {
          log(`FAILED ${cell.cell}:`);
          for (const v of violations) log(`  ${v}`);
          throw new Error(`cell ${cell.cell} did not satisfy its declared host`);
        }
        log(
          `observed ${cell.cell} ` +
            `(${record.declaredHost}/${record.declaredKind}/${record.declaredState})`,
        );
        records.push(record);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return records;
}

/**
 * SUBSTITUTE `${NAME}` from the environment, in the strings a walk step uses to
 * navigate.
 *
 * A walk names a run id, a template id and a base URL that belong to the LANE it
 * is driven on, not to the plan — a committed plan carrying a host, a port or a
 * session is a leak, and a committed plan carrying one lane's ids is a plan the
 * next lane cannot run. So the plan names them and the operator's environment
 * supplies them. An unset name is a hard failure rather than an empty string:
 * navigating to "/agents/cinatra-ai/planner-agent/" and photographing whatever
 * answers is exactly the mislabel this tier exists to refuse.
 */
export function resolveWalkString(value, env = process.env) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
    const resolved = env[name];
    if (resolved === undefined || resolved === "") {
      throw new Error(`the walk plan needs \`\${${name}}\`, and it is not set in the environment`);
    }
    return resolved;
  });
}

/** Run ONE walk action on a live page. The vocabulary is closed; see WALK_ACTIONS. */
export async function runWalkAction(page, action, { env = process.env, pageOf = () => null } = {}) {
  const selector = resolveWalkString(action.selector, env);
  switch (action.action) {
    case "goto":
      await page.goto(resolveWalkString(action.url, env), {
        waitUntil: action.waitUntil ?? "domcontentloaded",
        timeout: action.timeout ?? 300_000,
      });
      await page.waitForLoadState("load").catch(() => {});
      return;
    case "followContext": {
      const other = pageOf(action.context);
      if (!other) {
        throw new Error(
          `the walk follows context "${action.context}", which has no live page yet — a context ` +
            "is followed only after a step has driven it somewhere",
        );
      }
      await page.goto(other.url(), {
        waitUntil: action.waitUntil ?? "domcontentloaded",
        timeout: action.timeout ?? 300_000,
      });
      await page.waitForLoadState("load").catch(() => {});
      return;
    }
    case "reload":
      await page.reload({ waitUntil: action.waitUntil ?? "domcontentloaded" });
      return;
    case "click":
      await page.click(selector, { timeout: action.timeout ?? 180_000 });
      return;
    case "type":
      await page.click(selector);
      await page.type(selector, resolveWalkString(action.text, env), { delay: action.delay ?? 8 });
      return;
    case "press":
      await page.keyboard.press(action.key);
      return;
    case "waitForSelector":
      await page.waitForSelector(selector, { timeout: action.timeout ?? 420_000 });
      return;
    case "waitForTimeout":
      await page.waitForTimeout(action.ms);
      return;
    case "scrollIntoView":
      // The card's floor has to be IN the window for a `window`-framed capture
      // to show the control the record is about to assert. Scrolling moves the
      // operator's eye; it does not touch the DOM, which is why it is in the
      // vocabulary at all.
      //
      // `block` IS THE SECOND HALF OF THAT SENTENCE, and it is here because the
      // default was not enough on one cell. `scrollIntoViewIfNeeded` performs
      // the MINIMUM scroll: it parks the element flush against the edge of the
      // scroller and stops, and the chat composer is pinned OVER that edge. The
      // browser calls such an element in view — the recorder counted the expired
      // card's Confirm visible, correctly — while the picture showed a sliver of
      // it behind the composer, which is the one thing a `window`-framed capture
      // exists to prevent. A step that knows its card is taller than the window
      // asks for `"block": "center"` and gets the floor in the middle of it.
      if (action.block) {
        await page
          .locator(selector)
          .first()
          .evaluate((el, block) => el.scrollIntoView({ block, behavior: "instant" }), action.block);
        return;
      }
      await page.locator(selector).first().scrollIntoViewIfNeeded();
      return;
    default:
      throw new Error(`unknown walk action "${action.action}"`);
  }
}

/**
 * DRIVE A WALK: contexts that persist, steps that act, cells that are observed.
 *
 * The page belongs to the CONTEXT and survives every step that names it, which
 * is the whole difference from `driveCapture`: C1 and C2 are one card before and
 * after one press, and there is no URL that means "after the press".
 *
 * `session` is the operator's, never the plan's: cookies or a storage state
 * handed in at drive time. A committed plan holds no credential.
 */
export async function driveWalk({
  plan,
  repoRoot = process.cwd(),
  session = {},
  env = process.env,
  /**
   * WHERE THE APP IS, which the plan is not allowed to say.
   *
   * A walk step navigates with an app-relative path (`/chat`) because a
   * committed plan carrying a host and a port is a leak and a plan the next lane
   * cannot run. Playwright resolves such a path against the context's `baseURL`
   * and throws without one, so the plan's own note — `export WALK_BASE=...` —
   * has to be READ somewhere, and this is the only place that can read it
   * without writing an origin into the plan.
   */
  baseURL = env.WALK_BASE ?? null,
  /**
   * WHERE EACH CONTEXT ENDED UP, written out when the walk finishes.
   *
   * A walk whose clock is real is driven in more than one pass, and the later
   * pass has to reach a page the earlier one MINTED: the expired proposal lives
   * in a thread the product addressed, so neither the plan nor the operator
   * knows its URL until a browser has been there. `followContext` answers this
   * inside one invocation and cannot answer it across two. So the walk writes
   * down where it stood — a URL per context, nothing else — and the next pass
   * supplies it back as the environment value the plan names.
   */
  contextsOut = null,
  /**
   * WHICH STEPS THIS INVOCATION DRIVES, by `id`. A walk whose clock is real —
   * S9d's proposal expires after a shipped 30 minutes — is driven in more than
   * one pass, and the ids are how a pass says which part of the one plan it ran.
   * Empty means every step.
   */
  steps = [],
  log = console.log,
}) {
  const planViolations = validateWalkPlan(plan);
  if (planViolations.length > 0) {
    for (const violation of planViolations) log(`  ${violation}`);
    throw new Error(`the walk plan is malformed (${planViolations.length} violation(s))`);
  }
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  const live = new Map();
  const records = [];
  try {
    const wanted = new Set(steps);
    for (const [i, step] of plan.steps.entries()) {
      if (wanted.size > 0 && !wanted.has(step.id)) continue;
      let open = live.get(step.context);
      if (!open) {
        const declared = plan.contexts[step.context] ?? {};
        const context = await browser.newContext({
          viewport: declared.viewport ?? { width: 1440, height: 900 },
          deviceScaleFactor: declared.deviceScaleFactor ?? 2,
          colorScheme: declared.colorScheme ?? "light",
          ...(baseURL ? { baseURL } : {}),
          ...(session.storageState ? { storageState: session.storageState } : {}),
        });
        if (session.cookies) await context.addCookies(session.cookies);
        if (declared.theme) {
          await context.addInitScript((t) => {
            try {
              window.localStorage.setItem("theme", t);
            } catch {
              /* the RECORD says which theme resolved; this only asks */
            }
          }, declared.theme);
        }
        open = { context, page: await context.newPage() };
        open.page.on("pageerror", (e) => log(`  pageerror: ${String(e).slice(0, 200)}`));
        live.set(step.context, open);
      }
      for (const action of step.actions ?? []) {
        await runWalkAction(open.page, action, {
          env,
          pageOf: (name) => live.get(name)?.page ?? null,
        });
      }
      for (const cell of step.cells ?? []) {
        const record = await observeWalkCell({
          page: playwrightPage(open.page),
          cell: { ...cell, screenshot: resolveWalkString(cell.screenshot, env) },
          repoRoot,
        });
        log(
          `observed ${record.cell} ` +
            `(${record.declaredHost}/${record.declaredKind}/${record.declaredState}, ` +
            `${record.framing}-framed, step ${i} on "${step.context}")`,
        );
        records.push(record);
      }
    }
  } finally {
    if (contextsOut) {
      const where = {};
      for (const [name, { page }] of live.entries()) where[name] = page.url();
      mkdirSync(dirname(resolve(contextsOut)), { recursive: true });
      writeFileSync(resolve(contextsOut), `${JSON.stringify(where, null, 2)}\n`);
      log(`wrote where each context stood -> ${contextsOut}`);
    }
    for (const { context } of live.values()) await context.close();
    await browser.close();
  }
  return records;
}

async function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const planPath = arg("--plan");
  const walkPath = arg("--walk");
  // THE ONE CANONICAL INDEX by default, from the shared constant. The default
  // used to be `scripts/audit/chat-hitl-capture-index.json` — a second file that
  // no gate binds against, so an honest capture run wrote its records where
  // nothing would ever read them.
  const outPath = arg("--out") ?? CAPTURE_INDEX_RELATIVE_PATH;
  if (!planPath && !walkPath) {
    console.error(
      "usage: chat-hitl-capture-driver.mjs (--plan <plan.json> | --walk <walk.json>) " +
        "[--out <index.json>] [--merge] [--steps <stepId,stepId>] [--contexts-out <where.json>]",
    );
    return 1;
  }
  const existing = JSON.parse(readFileSync(resolve(outPath), "utf8"));
  let records;
  let retires = [];
  if (walkPath) {
    const walk = JSON.parse(readFileSync(walkPath, "utf8"));
    retires = walk.retires ?? [];
    records = await driveWalk({
      plan: walk,
      steps: (arg("--steps") ?? "").split(",").map((x) => x.trim()).filter(Boolean),
      contextsOut: arg("--contexts-out") ?? null,
      // THE SESSION IS THE OPERATOR'S. A committed plan holds no credential, so
      // the cookie header comes from the environment of the lane driving it.
      session: process.env.WALK_COOKIE
        ? {
            cookies: process.env.WALK_COOKIE.split("; ").map((c) => {
              const i = c.indexOf("=");
              return {
                name: c.slice(0, i),
                value: c.slice(i + 1),
                domain: process.env.WALK_COOKIE_DOMAIN ?? "localhost",
                path: "/",
              };
            }),
          }
        : {},
    });
    console.log(`walked ${walkCellsOf(walk).length} cell(s)`);
  } else {
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    records = await driveCapture({ plan: Array.isArray(plan) ? plan : plan.cells });
  }
  // The index's PROSE survives a run: it is what the file says about itself, and
  // a capture run has nothing to say about that. `$comment` is the canonical
  // index's own spelling; `note` was the retired audit copy's.
  //
  // AND SO DO THE RECORDS THIS RUN DID NOT WRITE, under --merge. Rewriting
  // `records` with only the run's own output is how a lane adding four cells
  // deletes the other fifty-four, and a smaller index is still a valid index, so
  // nothing downstream notices. --merge replaces each rewritten cell where it
  // stands, drops the cells the walk RETIRES, and leaves every other record
  // untouched and in place.
  const merging = argv.includes("--merge") || walkPath !== undefined;
  const base = {
    ...(existing.$comment !== undefined ? { $comment: existing.$comment } : {}),
    ...(existing.note !== undefined ? { note: existing.note } : {}),
    schemaVersion: CAPTURE_INDEX_SCHEMA_VERSION,
    recorder: RECORDER_ID,
    records: merging ? existing.records ?? [] : [],
  };
  const index = merging
    ? mergeWalkRecords({ index: base, records, retires })
    : { ...base, records };
  writeFileSync(resolve(outPath), `${JSON.stringify(index, null, 2)}\n`);
  console.log(
    `wrote ${records.length} record(s)` +
      (retires.length > 0 ? `, retired ${retires.length}` : "") +
      ` — ${index.records.length} in ${outPath}`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]).endsWith("chat-hitl-capture-driver.mjs")) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err?.message ?? err);
      process.exit(1);
    },
  );
}
