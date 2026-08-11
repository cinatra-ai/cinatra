// THE BROKER HEADER SEAM — client and server must name the same headers
// (cinatra#2577, epic #2564 S8d).
//
// The defect this exists for was real and silent (codex round 0, finding 1). The
// lifecycle refetch has no request BODY the server can read the assistant handle
// from — the turn does, which is why the handle lived in the turn's body and in
// only one header seam — so the resolve route reads it from a header. The embed
// did not send that header, every widget refetch 401'd, and NOTHING showed it: a
// lifecycle card renders no DOM on a failed resolve, by design, so the surface
// looked exactly like "you have nothing waiting".
//
// A unit test of either side alone cannot catch that; it is a mismatch BETWEEN
// them. So this reads both sources and asserts the client's one broker-header
// builder names every header the server-side widget branch reads. It is a source
// pin, deliberately: the alternative is an E2E that has to boot a CMS.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");

const EMBED_SRC = readFileSync(
  path.join(REPO_ROOT, "src/app/embed/assistant/embed-assistant-client.tsx"),
  "utf8",
);
const RESOLVE_SRC = readFileSync(
  path.join(REPO_ROOT, "src/app/api/lifecycle-views/resolve/route.ts"),
  "utf8",
);

/** The body of the embed's single broker-header builder. */
function authHeadersBody(): string {
  const start = EMBED_SRC.indexOf("const authHeaders = useCallback(");
  expect(start).toBeGreaterThan(-1);
  const end = EMBED_SRC.indexOf("\n  }, [", start);
  expect(end).toBeGreaterThan(start);
  return EMBED_SRC.slice(start, end);
}

/** Every `X-Cinatra-Widget-*` header the resolve route reads from a request. */
function headersReadByResolveRoute(): string[] {
  return [
    ...new Set(
      [...RESOLVE_SRC.matchAll(/"(X-Cinatra-Widget-[A-Za-z-]+)"/g)].map((m) => m[1]),
    ),
  ].sort();
}

describe("the embed sends every widget header the resolve route reads", () => {
  it("the route reads a non-trivial set (the premise)", () => {
    // Without this, an empty set would make the assertion below vacuous.
    const read = headersReadByResolveRoute();
    expect(read.length).toBeGreaterThanOrEqual(3);
    expect(read).toContain("X-Cinatra-Widget-User-Token");
    expect(read).toContain("X-Cinatra-Widget-Assistant");
    expect(read).toContain("X-Cinatra-Widget-Origin");
  });

  it.each(headersReadByResolveRoute())("the embed's authHeaders names '%s'", (header) => {
    expect(authHeadersBody()).toContain(`"${header}"`);
  });

  it("the lifecycle card's credential reuses THAT builder — one seam, not a copy", () => {
    // A second, slightly different header set is how the two drift apart again.
    expect(EMBED_SRC).toMatch(/headers:\s*authHeaders/);
    // …and it omits cookies, because the embed is same-origin to the app.
    expect(EMBED_SRC).toMatch(/credentials:\s*"omit"/);
  });

  it("the surface provider is declared for the widget host", () => {
    expect(EMBED_SRC).toContain('host="site_widget"');
  });
});
