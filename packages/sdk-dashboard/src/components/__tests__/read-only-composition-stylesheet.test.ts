// cinatra#3092: the read-only composition loads drizzle-cube's stylesheet
// itself, because the pages that draw it outside the dashboards shell
// (`/artifacts/<id>`, the review island) load it nowhere else. Without it the
// card collapses to its title bar while it loads, fails or has no data.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("the read-only composition carries the library's stylesheet", () => {
  it("imports drizzle-cube/client/styles.css as a side effect", () => {
    const source = readFileSync(join(__dirname, "..", "read-only-composition.tsx"), "utf8");
    expect(source).toMatch(/^import\s+["']drizzle-cube\/client\/styles\.css["'];?\s*$/m);
  });
});
