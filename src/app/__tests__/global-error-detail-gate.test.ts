import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Source-guard for the production error-detail gate in global-error.tsx.
//
// The decision lives in `shouldExposeErrorDetails` (src/lib/client-trust.ts),
// unit-tested in `src/lib/__tests__/client-trust.test.ts`. This guard proves
// the root error boundary actually gates the internal error name/message/stack
// behind that decision, so production never renders a raw stack to end users
// (only the opaque digest survives). Source-text assertion because the root
// vitest env is "node" (no DOM render).
// ---------------------------------------------------------------------------

const GLOBAL_ERROR_PATH = path.join(__dirname, "..", "global-error.tsx");
const GLOBAL_ERROR = readFileSync(GLOBAL_ERROR_PATH, "utf-8");

describe("global-error production detail gate", () => {
  it("imports shouldExposeErrorDetails from @/lib/client-trust", () => {
    expect(GLOBAL_ERROR).toMatch(
      /import\s*\{[\s\S]*?\bshouldExposeErrorDetails\b[\s\S]*?\}\s*from\s*["']@\/lib\/client-trust["']/,
    );
  });

  it("derives the visibility flag from NODE_ENV", () => {
    expect(GLOBAL_ERROR).toMatch(
      /shouldExposeErrorDetails\(\s*process\.env\.NODE_ENV\s*\)/,
    );
  });

  it("gates the raw stack render behind the visibility flag", () => {
    expect(GLOBAL_ERROR).toMatch(
      /showErrorDetails\s*&&\s*error\?\.stack\s*&&/,
    );
    // The stack <pre> must not render unconditionally.
    expect(GLOBAL_ERROR).not.toMatch(
      /\{\s*error\?\.stack\s*&&\s*\(\s*<pre/,
    );
  });

  it("gates the raw name/message render behind the visibility flag", () => {
    expect(GLOBAL_ERROR).toMatch(
      /\{\s*showErrorDetails\s*&&\s*\(\s*<div[\s\S]*?error\?\.name/,
    );
  });

  it("still shows the opaque digest (audience-safe) independent of the gate", () => {
    expect(GLOBAL_ERROR).toMatch(/error\?\.digest\s*&&/);
  });
});
