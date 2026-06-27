/**
 * Regression: no "Better Auth" library name in user-facing auth copy (issue #591).
 *
 * "Better Auth" is the underlying auth library — an implementation detail that
 * must never leak into rendered UI. The fresh-install bootstrap screen
 * (`PermissionsAuthPage` in `@cinatra-ai/permissions` `pages.tsx`) previously
 * rendered: "This workspace has no Better Auth users yet. …".
 *
 * Two leaks were found & fixed:
 *   1. the fresh-install bootstrap <p> copy in `pages.tsx`, and
 *   2. the impersonation-panel <p> copy in `user-impersonation-panel.tsx`
 *      ("Better Auth keeps the original admin session available…").
 *
 * Strategy: source-text invariant, matching this repo's render-test convention
 * (see packages/agents/.../agent-approval-inbox-requested-column.test.ts) — read
 * the component source and assert on its RENDERED prose only. This does not
 * import the heavy server-component module graph. Assertions are scoped to the
 * specific <p> prose blocks, so they never false-fail on the surfaces explicitly
 * out of scope per #591 (internal, non-user-visible): the
 * `@daveyplate/better-auth-ui` import path, code identifiers like
 * `hasAnyBetterAuthUsers()`, and developer comments.
 *
 * Library branding note: the `@daveyplate/better-auth-ui` package (AuthView /
 * AuthCard / AuthUIProvider) renders NO "Powered by better-auth" footer — the
 * compiled dist contains no such credits/branding string (its only "Better Auth"
 * literal is a dev-only console.warn). No suppression is required for the auth
 * card, so this regression guards the places the name actually leaked: the
 * bootstrap and impersonation-panel copy.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

// This test lives at src/app/configuration/permissions/, four levels under the
// repo root → packages/permissions/src/*.
const PERMISSIONS_SRC = path.resolve(
  __dirname,
  "../../../../packages/permissions/src",
);

function readSrc(file: string): string {
  return readFileSync(path.join(PERMISSIONS_SRC, file), "utf8");
}

/** The literal text inside a <p> paragraph that starts with `marker` — the prose
 *  a user reads. Extracted by slicing between the paragraph open/close tags and
 *  stripping any nested {expr} fragments. */
function paragraphFrom(src: string, marker: string): string {
  const start = src.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = src.indexOf("</p>", start);
  expect(end).toBeGreaterThan(start);
  return src
    .slice(start, end)
    .replace(/\{[^{}]*\}/g, " ")
    .trim();
}

describe("auth UI copy has no 'Better Auth' library branding (issue #591)", () => {
  it("the fresh-install bootstrap message no longer names 'Better Auth'", () => {
    const para = paragraphFrom(readSrc("pages.tsx"), "This workspace has no");
    // The repurposed, neutral copy is present …
    expect(para).toMatch(/^This workspace has no users yet\./);
    // … and the library name is gone from the rendered paragraph.
    expect(para).not.toMatch(/better[ -]?auth/i);
  });

  it("the bootstrap copy keeps the rest of its first-admin guidance", () => {
    const para = paragraphFrom(readSrc("pages.tsx"), "This workspace has no");
    expect(para).toMatch(
      /The first account registered here becomes the initial full-access admin automatically\./,
    );
  });

  it("the impersonation-panel copy no longer names 'Better Auth'", () => {
    const para = paragraphFrom(
      readSrc("user-impersonation-panel.tsx"),
      "Platform admins can temporarily sign in",
    );
    // Library name is gone from the rendered paragraph …
    expect(para).not.toMatch(/better[ -]?auth/i);
    // … and the original-session guidance is preserved (neutral wording).
    expect(para).toMatch(/original admin session stays available/);
  });
});
