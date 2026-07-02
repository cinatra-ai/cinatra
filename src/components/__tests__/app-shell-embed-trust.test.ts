import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Source-guard for the embed trust boundaries in app-shell.tsx.
//
// The behavioral contracts live in `src/lib/client-trust.ts` and are unit-
// tested in `src/lib/__tests__/client-trust.test.ts`. This guard proves the
// shell actually WIRES those helpers into the two client-supplied surfaces —
// the cross-frame message listener and the `?section=` selector — so a future
// refactor cannot silently re-introduce an unvalidated origin or an unescaped
// section interpolation while the isolated helper tests keep passing.
//
// Follows the repo convention of readFileSync + regex assertions against
// source text (root vitest env is "node"; no DOM render). See
// `src/components/__tests__/app-shell-flyout-state-import.test.ts`.
// ---------------------------------------------------------------------------

const APP_SHELL_PATH = path.join(__dirname, "..", "app-shell.tsx");
const APP_SHELL = readFileSync(APP_SHELL_PATH, "utf-8");

// Narrow to the EmbedMessageListener function body so unrelated code can't
// false-positive the ordering assertion.
const LISTENER_SLICE = (() => {
  const start = APP_SHELL.indexOf("function EmbedMessageListener");
  if (start < 0) return "";
  const rest = APP_SHELL.slice(start);
  const end = rest.indexOf("\n}\n");
  return end < 0 ? rest : rest.slice(0, end);
})();

describe("app-shell embed trust wiring", () => {
  it("imports the trust helpers from @/lib/client-trust", () => {
    expect(APP_SHELL).toMatch(
      /import\s*\{[\s\S]*?\bisTrustedEmbedOrigin\b[\s\S]*?\bparseAllowedEmbedOrigins\b[\s\S]*?\bsanitizeEmbedSection\b[\s\S]*?\}\s*from\s*["']@\/lib\/client-trust["']/,
    );
  });

  it("validates the message origin before acting on an embed command", () => {
    expect(LISTENER_SLICE.length).toBeGreaterThan(0);
    // Guards present.
    expect(LISTENER_SLICE).toMatch(
      /if\s*\(\s*!isTrustedEmbedOrigin\(\s*e\.origin\s*,/,
    );
    expect(LISTENER_SLICE).toMatch(/e\.source\s*!==\s*window\.parent/);
    // The origin guard must come BEFORE the submit action, not after.
    const guardIdx = LISTENER_SLICE.indexOf("isTrustedEmbedOrigin");
    const actionIdx = LISTENER_SLICE.indexOf("cinatra:embed:submit");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(actionIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(actionIdx);
  });

  it("builds the allowlist from same-origin plus configured embed origins", () => {
    expect(LISTENER_SLICE).toMatch(/window\.location\.origin/);
    expect(LISTENER_SLICE).toMatch(
      /parseAllowedEmbedOrigins\(\s*process\.env\.NEXT_PUBLIC_CINATRA_EMBED_ORIGINS\s*\)/,
    );
  });

  it("sanitizes the ?section= param before interpolating it into <style>", () => {
    // The raw param is read into a separate variable and passed through the
    // sanitizer; the sanitized result is what feeds the selector.
    expect(APP_SHELL).toMatch(
      /const\s+embedSection\s*=\s*sanitizeEmbedSection\(\s*rawEmbedSection\s*\)/,
    );
    // Regression guard: the raw param must NOT be assigned straight to
    // `embedSection` (the pre-fix shape that fed the selector unescaped).
    expect(APP_SHELL).not.toMatch(
      /const\s+embedSection\s*=\s*isEmbedMode[\s\S]*?\.get\(\s*["']section["']\s*\)/,
    );
  });
});
