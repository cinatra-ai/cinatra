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
 *     --out  scripts/audit/chat-hitl-capture-index.json
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
import { dirname, join, resolve } from "node:path";

import {
  CAPTURE_INDEX_SCHEMA_VERSION,
  RECORDER_ID,
  hashFile,
  observeCapture,
  validateCaptureRecord,
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
 * CARD-SCOPED READS TAKE AN INDEX, and the recorder pins it once per capture.
 * The earlier `.first()` answered every card-relative count from whichever root
 * led the DOM: on a transcript holding two cards of one kind that silently
 * measures a card the record never names, and the record carried nothing a
 * reader could check the screenshot against. `identifyWithin` is the other half
 * — it hands the recorder the matches' own attributes so the pin is recorded.
 */
export function playwrightPage(page) {
  const nthRoot = async (scope, root, index) => {
    if ((await scope.locator(root).count()) <= index) return null;
    return scope.locator(root).nth(index);
  };
  const readerFor = (scope, urlOf) => ({
    url: urlOf,
    count: async (selector) => scope.locator(selector).count(),
    countVisible: async (selector) => paintedCount(scope.locator(selector)),
    identifyWithin: async (selector) => attributesOfMatches(scope.locator(selector)),
    countWithin: async (root, selector, index = 0) => {
      const el = await nthRoot(scope, root, index);
      return el === null ? 0 : el.locator(selector).count();
    },
    countWithinVisible: async (root, selector, index = 0) => {
      const el = await nthRoot(scope, root, index);
      return el === null ? 0 : paintedCount(el.locator(selector));
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
    screenshot: async (absPath) => {
      mkdirSync(dirname(absPath), { recursive: true });
      await page.screenshot({ path: absPath, fullPage: true });
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
        const violations = validateCaptureRecord(record, {
          hashOf: (rel) => hashFile(resolve(repoRoot, rel)),
        });
        if (violations.length > 0) {
          log(`FAILED ${cell.cell}:`);
          for (const v of violations) log(`  ${v}`);
          throw new Error(`cell ${cell.cell} did not satisfy its declared host`);
        }
        log(`observed ${cell.cell} (${record.declaredHost}/${record.kind}/${record.state})`);
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

async function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const planPath = arg("--plan");
  const outPath = arg("--out") ?? join("scripts", "audit", "chat-hitl-capture-index.json");
  if (!planPath) {
    console.error("usage: chat-hitl-capture-driver.mjs --plan <plan.json> [--out <index.json>]");
    return 1;
  }
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  const records = await driveCapture({ plan: Array.isArray(plan) ? plan : plan.cells });
  const index = {
    note: JSON.parse(readFileSync(resolve(outPath), "utf8")).note,
    schemaVersion: CAPTURE_INDEX_SCHEMA_VERSION,
    recorder: RECORDER_ID,
    records,
  };
  writeFileSync(resolve(outPath), `${JSON.stringify(index, null, 2)}\n`);
  console.log(`wrote ${records.length} record(s) to ${outPath}`);
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
