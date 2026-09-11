/**
 * Connector setup page — the drawn shape, on a REAL setup page (cinatra#3214).
 *
 * The ratified drawing ("Connector setup page") draws ONE shape for every
 * schema-config connector: the generated form "splits into two columns: a wider
 * left column holding the configuration fields, and a narrower right column
 * holding the Connection status card", and that card "carries the status badge
 * with both icon and label plus the Check action beneath it".
 *
 * The host used to draw that only for a connector that DECLARES a `status-probe`
 * field; every other schema-config connector rendered a bare single-column form
 * with no card, no badge and no Check — invisible to every unit suite that
 * mounted the form directly with an `aside` the route never passed. This spec
 * drives the real dispatch route under the same platform-admin session as the
 * all-routes render-smoke and pins the shape on TWO connectors of different
 * shapes (acceptance item 10): one that declares no status-probe, and one that
 * does.
 *
 * PRECONDITION, ASSERTED — NEVER SKIPPED. Both connectors are bundled in the
 * image, so the boot seeder (src/lib/static-bundle-lifecycle.ts) ensures a live
 * platform-scoped anchor install row for each, which the platform-admin smoke
 * session addresses; the generated form therefore MUST render. An earlier
 * revision of this spec called `test.skip` when the form was absent: on a lane
 * whose database schema sat behind the branch the boot instrumentation crashed,
 * no anchor row was seeded, the Install / Activate CTA rendered instead, and
 * BOTH cases skipped — a vacuous green that asserted nothing about the drawn
 * shape. The absent form is now a FAILURE that names the precondition, so that
 * environment defect can never again read as a proof of the drawing.
 */
import { test, expect } from "@playwright/test";

type Case = { name: string; route: string; shape: string };

const CASES: Case[] = [
  {
    name: "google-appointment-schedules-connector",
    route: "/connectors/cinatra-ai/google-appointment-schedules-connector/setup",
    shape: "declares NO status-probe (the shape the old probe gate excluded)",
  },
  {
    name: "openai-connector",
    route: "/connectors/cinatra-ai/openai-connector/setup",
    shape: "declares its own status-probe",
  },
];

for (const c of CASES) {
  test(`connector setup draws the two columns + Connection status card — ${c.name}`, async ({
    page,
  }) => {
    await page.goto(c.route, { waitUntil: "domcontentloaded" });

    await test.info().attach(`${c.name}.txt`, {
      body: [
        `route:   ${c.route}`,
        `shape:   ${c.shape}`,
        "asserting the two-column body + Connection status card",
      ].join("\n"),
      contentType: "text/plain",
    });

    // The precondition, ASSERTED. A failure here means no live install row was
    // addressable for this session — the boot seeder did not run (a crashed
    // instrumentation hook, e.g. a database schema behind the branch) or the
    // row was archived. Fix the environment; never soften this back to a skip.
    const form = page.locator('[data-testid="schema-config-form"]');
    await expect(
      form,
      `${c.name} rendered the Install / Activate CTA instead of its generated setup form — ` +
        "no live bundled anchor install row was addressable, so the boot seeder did not run " +
        "against this database (apply the migrations and check the boot instrumentation)",
    ).toHaveCount(1);

    // The two columns of the drawing, in the ready state.
    const columns = page.locator('[data-conformance-id="connector-setup"]');
    await expect(columns).toHaveCount(1);
    await expect(columns).toHaveAttribute("data-state", "ready");

    // The right column's Connection status card, its badge (icon AND label),
    // and the Check action beneath it.
    const card = columns.locator('[data-slot="connection-status-card"]');
    await expect(card).toBeVisible();
    await expect(card).toContainText("Connection status");
    const badge = card.locator('[data-slot="connection-status-badge"]');
    await expect(badge).toBeVisible();
    await expect(badge.locator("svg").first()).toBeVisible();
    await expect(badge).not.toHaveText("");
    await expect(card.getByRole("button", { name: "Check" })).toBeVisible();
  });
}
