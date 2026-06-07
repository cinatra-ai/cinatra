// -----------------------------------------------------------------------------
// Single-export-site assertion.
//
// Locks the policy: validateInstanceNamespace must be imported from the same
// barrel by every consumer (client island + 3 server actions + the post-freeze
// rename modal + the administration page that mounts the editable form). No parallel
// implementations, no inline copy of the format regex. A future change that adds a
// new endpoint with its own regex will fail this test.
//
// CONSUMER_FILES and assertion targets cover all known validator consumers:
//   - CONSUMER_FILES covers administration/instance/page.tsx and
//     administration/instance/rename-confirmation.tsx so parallel
//     new RegExp(namePattern).test(...) checks in those files are caught.
//   - Forbidden literals include the JS regex form
//     /^[a-z0-9][a-z0-9-]{1,38}$/, any `new RegExp(` call,
//     and the bare-string constant form `= "^[a-z0-9][a-z0-9-]{1,38}$"`
//     (a string fed to new RegExp() elsewhere — the dangerous pattern).
//   - The HTML `pattern="^[a-z0-9][a-z0-9-]{1,38}$"` attribute on
//     <Input> is intentional defense-in-depth and is excluded by
//     assertion design (we look for ` = "^...` const assignment, not
//     just the pattern body, and we look for `new RegExp(` not the
//     pattern body in isolation).
//
// Static source-grep test (filesystem read, no module imports). Runs in
// vitest's node environment.
// -----------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(__dirname, "..", "..", "..", "..");

const CONSUMER_FILES = [
  "src/app/setup/name/instance-namespace-input.tsx",
  "src/app/setup/name/actions.ts",
  "src/app/setup/name/page.tsx",
  "src/app/configuration/instance/actions.ts",
  "src/app/configuration/environment/page.tsx",
  "src/app/configuration/instance/rename-confirmation.tsx",
] as const;

// JS regex literal as it would appear in source (Zod or `.test()` style):
//   /^[a-z0-9][a-z0-9-]{1,38}$/
// The HTML `pattern="^[a-z0-9][a-z0-9-]{1,38}$"` attribute is a string
// literal that does NOT contain the leading slash, so it is correctly
// excluded by this search.
const FORBIDDEN_REGEX_LITERAL = "/^[a-z0-9][a-z0-9-]{1,38}$/";

// Forbid runtime-constructed regex from the pattern body. This catches
// `new RegExp(namePattern)` (where namePattern is a string) and
// `new RegExp("^[a-z0-9]...")` literally. Validator.ts uses a regex
// literal, not new RegExp(), so it is unaffected.
const FORBIDDEN_REGEX_CONSTRUCTOR = "new RegExp(";

// Forbid the bare-string CONSTANT form of the pattern. This would catch
// `const X = "^[a-z0-9][a-z0-9-]{1,38}$";` and any equivalent
// `= "^[a-z0-9]..."` assignment. The HTML attribute form
// `<Input pattern="^[a-z0-9]..."/>` does NOT include the `= ` token (JSX
// renders attributes as `pattern="..."`, not `pattern = "..."`), so the
// attribute form is correctly excluded by this assertion.
const FORBIDDEN_PATTERN_CONST_ASSIGNMENT = '= "^[a-z0-9][a-z0-9-]{1,38}$"';

// Forbid the INLINE HTML/JSX `pattern="^..."` attribute form. Consumers
// must import the source string from the barrel via
// NAMESPACE_FORMAT_REGEX_SOURCE instead of inlining the literal.
// validator.ts is NOT in CONSUMER_FILES, so the export there is
// unaffected by this assertion.
const FORBIDDEN_INLINE_PATTERN_ATTR = 'pattern="^[a-z0-9]';

const BARREL_IMPORT = 'from "@/lib/instance-namespace"';

const VERBATIM_RESERVED_COPY = "Cinatra.ai-affiliated instances and require pre-registration";

// Files in CONSUMER_FILES that import the validator directly — used by the
// barrel-import assertion. Files that mount components/server actions but
// never call validateInstanceNamespace themselves (page.tsx) are tested
// only against the no-parallel-implementation assertions.
const VALIDATOR_IMPORTERS = [
  "src/app/setup/name/instance-namespace-input.tsx",
  "src/app/setup/name/actions.ts",
  "src/app/configuration/instance/actions.ts",
  "src/app/configuration/instance/rename-confirmation.tsx",
] as const;

function readConsumer(relPath: string): string {
  return readFileSync(join(repoRoot, relPath), "utf-8");
}

describe("single export site for instance-namespace validation", () => {
  it.each(VALIDATOR_IMPORTERS)(
    "%s imports validateInstanceNamespace from the @/lib/instance-namespace barrel",
    (relPath) => {
      const source = readConsumer(relPath);
      expect(source).toContain(BARREL_IMPORT);
      // Reject sub-path imports — they bypass the barrel and the future
      // surface guarantees it provides.
      expect(source).not.toContain('from "@/lib/instance-namespace/validator"');
      expect(source).not.toContain('from "@/lib/instance-namespace/types"');
      expect(source).not.toContain('from "@/lib/instance-namespace/reserved-patterns"');
      expect(source).not.toContain(
        'from "@/lib/instance-namespace/compose-error-message"',
      );
    },
  );

  it.each(CONSUMER_FILES)(
    "%s does NOT contain a parallel JS regex literal /^[a-z0-9][a-z0-9-]{1,38}$/",
    (relPath) => {
      const source = readConsumer(relPath);
      expect(source).not.toContain(FORBIDDEN_REGEX_LITERAL);
    },
  );

  it.each(CONSUMER_FILES)(
    "%s does NOT call new RegExp(...) (parallel runtime regex construction)",
    (relPath) => {
      const source = readConsumer(relPath);
      expect(source).not.toContain(FORBIDDEN_REGEX_CONSTRUCTOR);
    },
  );

  it.each(CONSUMER_FILES)(
    "%s does NOT declare the pattern body as a bare string constant",
    (relPath) => {
      const source = readConsumer(relPath);
      // Forbid `= "^[a-z0-9][a-z0-9-]{1,38}$"` (const/var assignment).
      // The HTML attribute form `pattern="^..."` is excluded because JSX
      // emits attributes without a space-equals-space pattern.
      expect(source).not.toContain(FORBIDDEN_PATTERN_CONST_ASSIGNMENT);
    },
  );

  // No inline `pattern="^[a-z0-9]..."` JSX attribute. Consumers must use
  // `pattern={NAMESPACE_FORMAT_REGEX_SOURCE}` imported from the barrel.
  it.each(CONSUMER_FILES)(
    "%s does NOT contain an inline pattern=\"^[a-z0-9] attribute (use NAMESPACE_FORMAT_REGEX_SOURCE)",
    (relPath) => {
      const source = readConsumer(relPath);
      expect(source).not.toContain(FORBIDDEN_INLINE_PATTERN_ATTR);
    },
  );

  it("validator.ts is the single owner of the format regex literal", () => {
    const validatorSource = readConsumer("src/lib/instance-namespace/validator.ts");
    expect(validatorSource).toContain(FORBIDDEN_REGEX_LITERAL);
  });

  // The verbatim reserved-substring copy must live in EXACTLY ONE place:
  // the shared composeNamespaceErrorMessage module. Centralizing this copy
  // prevents typos from drifting the user-facing message across surfaces.
  it("verbatim reserved-substring copy lives only in compose-error-message.ts", () => {
    const composeSource = readConsumer(
      "src/lib/instance-namespace/compose-error-message.ts",
    );
    expect(composeSource).toContain(VERBATIM_RESERVED_COPY);

    const setupActionSource = readConsumer("src/app/setup/name/actions.ts");
    const settingsActionSource = readConsumer(
      "src/app/configuration/instance/actions.ts",
    );
    expect(setupActionSource).not.toContain(VERBATIM_RESERVED_COPY);
    expect(settingsActionSource).not.toContain(VERBATIM_RESERVED_COPY);
  });
});
