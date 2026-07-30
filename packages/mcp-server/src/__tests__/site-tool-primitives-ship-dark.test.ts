import { describe, expect, it } from "vitest";
import { isDelegatedChatMcpToolAllowed } from "../delegated-chat-tool-policy";
import { isDelegatedWidgetMcpToolAllowed } from "../delegated-widget-tool-policy";

// cinatra#2017 S2 — ship-dark invariant. The two governed invoker primitives
// were DENIED on every delegated perimeter (deny-by-default) so no live model
// surface reached the invoker until S7 cut over.
//
// cinatra#2022 S7 PR-δ: the CHAT perimeter cutover flips here —
// `wordpress_site_tool_call` / `wordpress_site_tools_list` move from denied
// to ALLOWED on chat (delegated-chat-tool-policy.ts's amended ALLOWED_EXACT).
// The WIDGET perimeter is untouched by this change — its minimal allowlist is
// intentionally out of scope — and stays ship-dark permanently, not just
// until this PR.

const PRIMITIVES = ["wordpress_site_tool_call", "wordpress_site_tools_list"];

describe("chat perimeter: governed invoker primitives are now reachable (cinatra#2022 S7 PR-δ)", () => {
  it("delegated-chat perimeter ALLOWS both primitives post-δ", () => {
    for (const name of PRIMITIVES) {
      expect(isDelegatedChatMcpToolAllowed(name), name).toBe(true);
    }
  });
});

describe("widget perimeter: governed invoker primitives stay ship-dark PERMANENTLY (intentionally out of S7's scope)", () => {
  it("delegated-widget perimeter (both kinds) still denies both primitives", () => {
    for (const kind of ["wordpress", "drupal"] as const) {
      for (const name of PRIMITIVES) {
        expect(isDelegatedWidgetMcpToolAllowed(kind, name), `${kind}/${name}`).toBe(false);
      }
    }
  });
});
