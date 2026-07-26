import { describe, expect, it } from "vitest";
import { isDelegatedChatMcpToolAllowed } from "./delegated-chat-tool-policy";
import { isDelegatedWidgetMcpToolAllowed } from "./delegated-widget-tool-policy";

// cinatra#2017 S2 — ship-dark invariant (design §0 / §1.5). The two governed
// invoker primitives MUST be denied on BOTH delegated perimeters (deny-by-
// default, untouched) so no live model surface reaches the invoker until S7.

const PRIMITIVES = ["wordpress_site_tool_call", "wordpress_site_tools_list"];

describe("ship-dark: governed invoker primitives are denied on every delegated perimeter", () => {
  it("delegated-chat perimeter denies both primitives", () => {
    for (const name of PRIMITIVES) {
      expect(isDelegatedChatMcpToolAllowed(name)).toBe(false);
    }
  });

  it("delegated-widget perimeter (both kinds) denies both primitives", () => {
    for (const kind of ["wordpress", "drupal"] as const) {
      for (const name of PRIMITIVES) {
        expect(isDelegatedWidgetMcpToolAllowed(kind, name)).toBe(false);
      }
    }
  });
});
