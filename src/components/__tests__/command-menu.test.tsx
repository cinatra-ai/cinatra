/**
 * Command palette nav data (cinatra #851 findings 1).
 *
 * The palette renders <CommandItem key={item.title}> per group, so titles are
 * the React-key identity: they MUST be unique within a group. Historically
 * "Chat" and "New agent" both carried href "/chat" while keyed by href — a
 * duplicate-key collision AND a wrong destination ("New agent" must open chat
 * in create-agent mode, matching the app-shell "Create agent" action).
 */
import { describe, expect, it } from "vitest";

import { navGroups } from "../command-menu";

describe("command palette navGroups", () => {
  it("titles (the React keys) are unique within each group", () => {
    for (const group of navGroups) {
      const titles = group.items.map((item) => item.title);
      expect(new Set(titles).size, `duplicate title key in "${group.heading}"`).toBe(
        titles.length,
      );
    }
  });

  it('"New agent" opens chat in create-agent mode (same destination as the app-shell action)', () => {
    const navigate = navGroups.find((g) => g.heading === "Navigate");
    const newAgent = navigate?.items.find((item) => item.title === "New agent");
    expect(newAgent?.href).toBe("/chat?mode=create-agent");
  });

  it('"Chat" and "New agent" no longer collide on the same href', () => {
    for (const group of navGroups) {
      const hrefs = group.items.map((item) => item.href);
      expect(new Set(hrefs).size, `duplicate href in "${group.heading}"`).toBe(hrefs.length);
    }
  });
});
