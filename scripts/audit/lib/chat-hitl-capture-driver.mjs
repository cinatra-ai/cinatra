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
 *     storageState? }
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
 * Adapt a Playwright page to the `CapturePage` port.
 *
 * `frame(selector)` resolves the frame BEHIND an element and returns a reader
 * scoped to it, which is what lets the widget host be checked where it actually
 * lives instead of in the embedding page.
 */
export function playwrightPage(page) {
  return {
    url: async () => page.url(),
    count: async (selector) => page.locator(selector).count(),
    countWithin: async (root, selector) => {
      const scope = page.locator(root).first();
      if ((await page.locator(root).count()) === 0) return 0;
      return scope.locator(selector).count();
    },
    frame: async (selector) => {
      const handle = await page.$(selector);
      if (!handle) return null;
      const frame = await handle.contentFrame();
      if (!frame) return null;
      return {
        url: async () => frame.url(),
        count: async (sel) => frame.locator(sel).count(),
        countWithin: async (root, sel) => {
          if ((await frame.locator(root).count()) === 0) return 0;
          return frame.locator(root).first().locator(sel).count();
        },
      };
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
