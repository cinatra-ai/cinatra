import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The sdk-ui vitest env is `node` (no DOM render — see vitest.config.ts). Like
// the connectors-grid design-system contract tests, this is a module-load smoke
// + source-text contract over the Tabs primitive: the accessible tab SEMANTICS
// are delegated to Radix (roles / aria-selected / roving arrow-key focus / tab
// order), so the contract we assert here is (a) that delegation, (b) the
// design-system underline visual language, (c) portability + connector-agnostic
// invariants, and (d) the consumer export wiring.

const SRC_DIR = join(__dirname, "..");
const PKG_DIR = join(SRC_DIR, "..");
const tabsSrc = readFileSync(join(SRC_DIR, "ui", "tabs.tsx"), "utf8");
const marketplaceSrc = readFileSync(join(SRC_DIR, "marketplace.ts"), "utf8");
const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")) as {
  exports: Record<string, string>;
};

describe("sdk-ui Tabs primitive — module load", () => {
  it("loads in node without throwing and exports the four parts", async () => {
    const mod = await import("../ui/tabs");
    for (const name of ["Tabs", "TabsList", "TabsListRow", "TabsTrigger", "TabsContent"]) {
      expect(typeof (mod as Record<string, unknown>)[name]).toBe("function");
    }
  });
});

describe("sdk-ui Tabs primitive — under-header paired rule (design spec §Tabs)", () => {
  it("exports TabsListRow — the tablist row that pairs with the etched rule", () => {
    expect(tabsSrc).toMatch(/function TabsListRow/);
    expect(tabsSrc).toMatch(/export \{[^}]*\bTabsListRow\b[^}]*\}/);
  });

  it("lays the row out as tabs-left / rule-right (grid auto,1fr) and drops the list hairline", () => {
    // The tablist takes the left (auto) portion; the rule fills the 1fr to the
    // page edge. In the row the list drops its own bottom hairline so only the
    // etched paired-line reads (spec §Dividers: never stack two rules).
    expect(tabsSrc).toContain("grid-cols-[auto_1fr]");
    expect(tabsSrc).toMatch(/TabsList className=\{cn\("border-b-0"/);
  });

  it("draws the rule with the design etched paired-line, not a plain hairline", () => {
    expect(tabsSrc).toContain("divider-etched");
  });

  it("keeps the rule decorative (role=none / aria-hidden — it is not a tab stop)", () => {
    expect(tabsSrc).toMatch(/role="none"/);
    expect(tabsSrc).toMatch(/aria-hidden/);
  });

  it("stays dependency-light: the rule is inlined, NOT the host `@/` Separator", () => {
    // Portability contract for bundled-react connectors — the host composes
    // TabsListRow from a Separator component (an `@/components/ui/separator`
    // import), which this package cannot reach. The etched utility is inlined,
    // so there is no such import and no rendered <Separator/> JSX element (a
    // rendered one would require the forbidden import guarded here).
    expect(tabsSrc).not.toMatch(/from ["']@\/components\/ui\/separator["']/);
    expect(tabsSrc).not.toMatch(/<Separator[ />]/);
  });
});

describe("sdk-ui Tabs primitive — accessible semantics via Radix", () => {
  it("delegates tab semantics to the Radix Tabs primitive", () => {
    expect(tabsSrc).toMatch(/from "radix-ui"/);
    expect(tabsSrc).toMatch(/TabsPrimitive\.Root/);
    expect(tabsSrc).toMatch(/TabsPrimitive\.List/);
    expect(tabsSrc).toMatch(/TabsPrimitive\.Trigger/);
    expect(tabsSrc).toMatch(/TabsPrimitive\.Content/);
  });

  it("marks each part with a data-slot for styling hooks", () => {
    for (const slot of ["tabs", "tabs-list", "tabs-trigger", "tabs-content"]) {
      expect(tabsSrc).toContain(`data-slot="${slot}"`);
    }
  });
});

describe("sdk-ui Tabs primitive — design-system underline language", () => {
  it("is 13px medium sans", () => {
    expect(tabsSrc).toContain("text-[13px]");
    expect(tabsSrc).toContain("font-medium");
  });

  it("is underline-only: bottom hairline on the list, no pill background", () => {
    expect(tabsSrc).toMatch(/border-b border-line/);
    expect(tabsSrc).not.toMatch(/rounded-(full|lg|md)[^;]*bg-(background|card|muted)/);
  });

  it("uses the 2px indigo (--primary) active underline + indigo active label", () => {
    expect(tabsSrc).toContain("data-[state=active]:after:bg-primary");
    expect(tabsSrc).toContain("after:h-[2px]");
    expect(tabsSrc).toContain("data-[state=active]:text-primary");
  });

  it("keeps a visible keyboard focus ring", () => {
    expect(tabsSrc).toMatch(/focus-visible:ring/);
  });
});

describe("sdk-ui Tabs primitive — portability + connector-agnostic invariants", () => {
  it("imports only within the package (no host `@/` app-local alias, no root barrel)", () => {
    expect(tabsSrc).not.toMatch(/from ["']@\//);
    expect(tabsSrc).not.toMatch(/from ["']\.\.\/index["']/);
    expect(tabsSrc).toContain('from "../lib/utils"');
  });

  it("names no connector (pure UI infra — the extension owns content + Help policy)", () => {
    for (const connector of [
      "github",
      "gmail",
      "google-calendar",
      "wordpress",
      "openai",
      "anthropic",
      "help",
      "Setup",
    ]) {
      expect(tabsSrc.toLowerCase()).not.toContain(connector.toLowerCase() + '"');
    }
  });
});

describe("sdk-ui Tabs primitive — consumer export wiring", () => {
  it("has a dedicated `./tabs` subpath export (NOT added to the ratchet-locked root barrel)", () => {
    expect(pkg.exports["./tabs"]).toBe("./src/ui/tabs.tsx");
    const indexSrc = readFileSync(join(SRC_DIR, "index.ts"), "utf8");
    expect(indexSrc).not.toMatch(/from ["']\.\/ui\/tabs["']/);
  });

  it("is NOT re-exported from the marketplace barrel (keeps it off the app-route graph / route-graph ratchet)", () => {
    // Re-exporting Tabs from /marketplace would add it to the reachable-module
    // graph of every app route that transitively imports the barrel (via a
    // connector), tripping the no-new-rot ratchet. It ships only from ./tabs.
    expect(marketplaceSrc).not.toMatch(/from "\.\/ui\/tabs"/);
    expect(marketplaceSrc).not.toMatch(/export \{[^}]*Tabs[^}]*\}/);
  });

  it("README documents Tabs as the deliberate export (and drops it from the NOT-vendored list)", () => {
    const readme = readFileSync(join(PKG_DIR, "README.md"), "utf8");
    // The stance is reconciled: Tabs is documented as the one exported primitive.
    expect(readme).toMatch(/deliberately-exported primitive:\s*`Tabs`/);
    expect(readme).toContain(
      'import { Tabs, TabsList, TabsTrigger, TabsContent } from "@cinatra-ai/sdk-ui/tabs";',
    );
    // The "NOT vendored" bullet must no longer name Tabs (else it self-contradicts).
    const notVendored = readme
      .split("\n")
      .find((l) => l.includes("are NOT vendored here"));
    expect(notVendored).toBeTruthy();
    expect(notVendored).not.toMatch(/`Tabs`/);
  });
});
