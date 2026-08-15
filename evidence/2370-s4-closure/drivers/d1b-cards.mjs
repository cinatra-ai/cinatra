// D1b — per-card crops + badge assertions on /connectors (the grid card is the
// unit the acceptance item names).
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { authenticate, ensureDir, shot, BASE } from "./lib-auth.mjs";

const OUT = ensureDir(process.env.S4_OUT ?? "<lane-out>/2370-out/d1b");
const steps = [];
const assertions = [];
function A(id, pass, detail) {
  assertions.push({ id, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${id} :: ${detail}`);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();

try {
  await authenticate(context, steps);
  await page.goto(`${BASE}/connectors`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(4000);

  const info = await page.evaluate(() => {
    function cardFor(slug) {
      const node = document.querySelector(`li[data-testid="connector-card"][data-connector-slug="${slug}"]`);
      if (!node) return null;
      const labels = [...node.querySelectorAll("[aria-label],[title]")].map(
        (n) => n.getAttribute("aria-label") ?? n.getAttribute("title"),
      );
      return {
        slug,
        text: (node.textContent ?? "").trim().slice(0, 300),
        ariaLabels: labels.filter(Boolean),
        html: node.outerHTML.replace(/data:image[^"]*/g, "<inline-svg>").slice(0, 1500),
      };
    }
    return {
      appt: cardFor("google-appointment-schedules-connector"),
      gcal: cardFor("google-calendar-connector"),
    };
  });
  steps.push(`cards=${JSON.stringify(info)}`);

  for (const [k, sel] of [
    ["appt", 'li[data-connector-slug="google-appointment-schedules-connector"]'],
    ["gcal", 'li[data-connector-slug="google-calendar-connector"]'],
  ]) {
    const loc = page.locator(sel).first();
    if (await loc.count()) {
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.screenshot({ path: `${OUT}/card-${k}.png` }).catch((e) => steps.push(`crop ${k} failed ${e.message}`));
    }
  }
  await shot(page, OUT, "grid");

  const apptAll = JSON.stringify(info.appt ?? {});
  const gcalAll = JSON.stringify(info.gcal ?? {});
  A("D1b.1-appt-card-not-connected", /Not connected/i.test(apptAll), `appt card=${apptAll.slice(0, 600)}`);
  A(
    "D1b.2-gcal-card-nango-only",
    /Not connected/i.test(gcalAll) && !/\d+\s*appt/i.test(gcalAll),
    `gcal card=${gcalAll.slice(0, 600)}`,
  );
} catch (err) {
  assertions.push({ id: "D1b.FATAL", pass: false, detail: String(err && err.stack ? err.stack : err) });
  console.error(err);
} finally {
  writeFileSync(`${OUT}/assertions.json`, JSON.stringify({ base: BASE, steps, assertions }, null, 2));
  await browser.close();
}
