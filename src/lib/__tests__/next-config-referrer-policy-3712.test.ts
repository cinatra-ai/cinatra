/**
 * cinatra#3712 — the Referrer-Policy each authenticated one-shot screen sends.
 *
 * The Connect consent screen (`/connect/authorize`) and the hosted widget
 * sign-in (`/widget-auth`) both run a server action from their own document:
 * Approve / Deny on the consent, and the unattended grant call on the widget
 * sign-in. A server action is a same-origin POST. Under the Fetch standard's
 * "append a request `Origin` header" rule a non-`cors` request (a form the
 * browser submits itself, as before the page hydrates) whose referrer policy
 * is `no-referrer` serializes its `Origin` as `null`, and the framework's
 * server-action protection compares `Origin` with the forwarded host and
 * aborts on `null` — the refusal cinatra#3712 measured on the consent.
 * `same-origin` lets such a POST carry its real `Origin` and still sends no
 * `Referer` on any cross-origin hop (the consent's 302 to a CMS callback on
 * another origin among them), so neither the authorization code nor the
 * screen nonce reaches another origin through a Referer.
 *
 * The review-target island (`/lifecycle/review-island`) is the boundary of
 * this change: cinatra#2674 tightened it to `no-referrer` for its in-URL
 * credential, and it stays exactly as it was.
 *
 * The test reads the REAL configuration the framework loads: it imports
 * next.config.ts's default export and awaits its `headers()`. The root suite
 * supplies the one variable the file's fail-fast guard requires
 * (SUPABASE_DB_URL, vitest.config.ts `test.env`).
 */
import { describe, it, expect } from "vitest";

type HeaderEntry = { key: string; value: string };
type HeaderRule = { source: string; headers: HeaderEntry[] };

async function loadHeaderRules(): Promise<HeaderRule[]> {
  const mod = await import("../../../next.config");
  const config = mod.default as { headers?: () => Promise<HeaderRule[]> };
  expect(typeof config.headers).toBe("function");
  return (await config.headers!()) as HeaderRule[];
}

function rule(rules: HeaderRule[], source: string): HeaderRule {
  const matches = rules.filter((r) => r.source === source);
  expect(matches, `exactly one headers() entry for ${source}`).toHaveLength(1);
  return matches[0];
}

function values(entry: HeaderRule, key: string): string[] {
  return entry.headers
    .filter((h) => h.key.toLowerCase() === key.toLowerCase())
    .map((h) => h.value);
}

describe("next.config.ts headers() — Referrer-Policy (cinatra#3712)", () => {
  // A `no-referrer` page sends `Origin: null` on its own server-action POST when the browser submits it as a form (a non-`cors` request), which the framework refuses, while `same-origin` still keeps the Referer off every cross-origin hop.
  it("/connect/authorize sends Referrer-Policy: same-origin so Approve and Deny carry their Origin", async () => {
    const entry = rule(await loadHeaderRules(), "/connect/authorize");
    expect(values(entry, "Referrer-Policy")).toEqual(["same-origin"]);
  });

  // A `no-referrer` page sends `Origin: null` on its own server-action POST when the browser submits it as a form (a non-`cors` request), which the framework refuses, while `same-origin` still keeps the Referer off every cross-origin hop.
  it("/widget-auth sends Referrer-Policy: same-origin so its grant action carries its Origin, and stays no-store", async () => {
    const entry = rule(await loadHeaderRules(), "/widget-auth");
    expect(values(entry, "Referrer-Policy")).toEqual(["same-origin"]);
    expect(values(entry, "Cache-Control")).toEqual(["no-store"]);
  });

  it("/lifecycle/review-island keeps Referrer-Policy: no-referrer and Cache-Control: no-store (cinatra#2674, unchanged)", async () => {
    const entry = rule(await loadHeaderRules(), "/lifecycle/review-island");
    expect(values(entry, "Referrer-Policy")).toEqual(["no-referrer"]);
    expect(values(entry, "Cache-Control")).toEqual(["no-store"]);
  });
});
