import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The sdk-ui vitest env is `node` (no DOM render — see vitest.config.ts). Like
// the Tabs + connectors-grid contract tests, this is a module-load smoke +
// source-text contract over the connection-status setup primitives, asserting
// their conformance to design/specs/app-connectors.html §II: the connection(s)
// status card (single + multi), the Connections list, the two-column setup
// body, and the shared status badge — plus the portability + export wiring the
// bundled-react connectors depend on.

const SRC_DIR = join(__dirname, "..");
const PKG_DIR = join(SRC_DIR, "..");
const read = (rel: string) => readFileSync(join(SRC_DIR, rel), "utf8");

const badgeSrc = read("connection-status-badge.tsx");
const cardSrc = read("connection-status-card.tsx");
const listSrc = read("connections-list.tsx");
const columnsSrc = read("connector-setup-columns.tsx");
const indexSrc = read("index.ts");
const marketplaceSrc = read("marketplace.ts");
const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")) as {
  exports: Record<string, string>;
};

describe("connection-status primitives — module load", () => {
  it("badge loads and exports ConnectionStatusBadge", async () => {
    const mod = await import("../connection-status-badge");
    expect(typeof mod.ConnectionStatusBadge).toBe("function");
  });
  it("card loads and exports both single + multi variants", async () => {
    const mod = await import("../connection-status-card");
    expect(typeof mod.ConnectionStatusCard).toBe("function");
    expect(typeof mod.ConnectionsStatusCard).toBe("function");
  });
  it("connections list loads and exports ConnectionsList + ConnectionRow", async () => {
    const mod = await import("../connections-list");
    expect(typeof mod.ConnectionsList).toBe("function");
    expect(typeof mod.ConnectionRow).toBe("function");
  });
  it("setup columns loads and exports ConnectorSetupColumns", async () => {
    const mod = await import("../connector-setup-columns");
    expect(typeof mod.ConnectorSetupColumns).toBe("function");
  });
});

describe("ConnectionStatusBadge — solid green/red language + Checking transient (§II)", () => {
  it("has the three connection statuses", () => {
    expect(badgeSrc).toMatch(
      /"connected"\s*\|\s*"disconnected"\s*\|\s*"checking"/,
    );
  });
  it("connected is a SOLID green chip with a plug — byte-parity with ConnectorBadge", () => {
    expect(badgeSrc).toContain("bg-success text-success-foreground");
    expect(badgeSrc).toContain("PlugZap");
  });
  it("disconnected is a SOLID red chip with an unplug — byte-parity with ConnectorBadge", () => {
    expect(badgeSrc).toContain("bg-destructive text-destructive-foreground");
    expect(badgeSrc).toContain("Unplug");
  });
  it("checking is the transient indigo-tint chip with a SPINNING loader", () => {
    expect(badgeSrc).toContain("bg-primary/10 text-primary");
    expect(badgeSrc).toContain("LoaderCircle");
    expect(badgeSrc).toContain("animate-spin");
  });
  it("carries BOTH icon and label, and a data-status hook for each state", () => {
    expect(badgeSrc).toContain('data-slot="connection-status-badge"');
    expect(badgeSrc).toContain("data-status={status}");
    // label defaults per status; a count can prefix it for the roll-up card.
    expect(badgeSrc).toContain("`${count} ${text}`");
  });
});

describe("ConnectionStatusCard (single) — spec §II 'One connection' right column", () => {
  it("reuses the info-card chrome: --surface panel, hairline, heading over a divider", () => {
    expect(cardSrc).toContain("border border-line bg-surface");
    expect(cardSrc).toContain("border-b border-line"); // heading divider
  });
  it("heads 'Connection status' (singular) and renders the status badge", () => {
    expect(cardSrc).toContain('"Connection status"');
    expect(cardSrc).toContain("ConnectionStatusBadge");
    expect(cardSrc).toContain('data-variant="single"');
  });
  it("renders the Check action full-width beneath the badge (spec: 100% wide, centered)", () => {
    expect(cardSrc).toMatch(/w-full[^"]*justify-center/);
  });
});

describe("ConnectionsStatusCard (multi) — spec §II 'Multiple connections' roll-up", () => {
  it("heads the PLURAL 'Connections status'", () => {
    expect(cardSrc).toContain('"Connections status"');
    expect(cardSrc).toContain('data-variant="multi"');
  });
  it("shows one count badge per status IN PLAY (count > 0), never an empty one", () => {
    expect(cardSrc).toMatch(/counts\[s\]\s*\?\?\s*0\)\s*>\s*0/);
    expect(cardSrc).toContain("count={counts[s]}");
  });
  it("bakes in NO full-width Check control — that affordance is single-card only", () => {
    // Precise contract: the ConnectionsStatusCard FUNCTION body carries no
    // full-width Check button wrapper (`justify-center`) — the single card's
    // affordance. The multi card's only action is the passed "All connections"
    // link (spec §II: "no Check").
    const multiFn = cardSrc.slice(
      cardSrc.indexOf("export function ConnectionsStatusCard"),
    );
    expect(multiFn).not.toContain("justify-center");
    // and it does render one count badge per status in play
    expect(multiFn).toContain("count={counts[s]}");
  });
});

describe("ConnectionsList / ConnectionRow — spec §II Connections tab", () => {
  it("emits the connector-connections conformance id + a driven data-state", () => {
    expect(listSrc).toContain('data-conformance-id="connector-connections"');
    expect(listSrc).toContain("data-state={state}");
  });
  it("supports the empty + loading states, each with its own visible affordance", () => {
    expect(listSrc).toMatch(/"ready"\s*\|\s*"empty"\s*\|\s*"loading"/);
    expect(listSrc).toMatch(/state === "empty"/);
    expect(listSrc).toMatch(/state === "loading"/);
    expect(listSrc).toContain("emptyLabel");
    expect(listSrc).toContain("loadingLabel");
  });
  it("each row stacks name + URL + the solid status badge + a per-row action slot", () => {
    expect(listSrc).toContain("ConnectionStatusBadge");
    expect(listSrc).toContain("{name}");
    expect(listSrc).toContain("{url}");
    expect(listSrc).toContain("{action}");
    expect(listSrc).toContain('data-slot="connection-row"');
  });
});

describe("ConnectorSetupColumns — spec §II two-column setup body", () => {
  it("is the minmax(0,1fr) 236px grid (fields wider left, status card 236px right)", () => {
    expect(columnsSrc).toContain("minmax(0,1fr)_236px");
  });
  it("collapses to a single column on narrow viewports (responsive)", () => {
    expect(columnsSrc).toMatch(/grid-cols-1[^"]*sm:grid-cols-/);
  });
  it("emits connector-setup / connector-multi-setup + a driven data-state", () => {
    expect(columnsSrc).toMatch(
      /"connector-setup"\s*\|\s*"connector-multi-setup"/,
    );
    expect(columnsSrc).toContain("data-conformance-id={conformanceId}");
    expect(columnsSrc).toContain("data-state={state}");
  });
});

describe("connection-status primitives — portability (bundled-react safe)", () => {
  for (const [name, src] of [
    ["badge", badgeSrc],
    ["card", cardSrc],
    ["list", listSrc],
    ["columns", columnsSrc],
  ] as const) {
    it(`${name}: imports only within the package + design deps (no host @/ alias, no root barrel)`, () => {
      expect(src).not.toMatch(/from ["']@\//);
      expect(src).not.toMatch(/from ["']\.\.\/index["']/);
      expect(src).toContain('from "./lib/utils"');
    });
    it(`${name}: names no specific connector (pure setup-page infra)`, () => {
      for (const connector of [
        "github",
        "gmail",
        "openai",
        "anthropic",
        "wordpress",
      ]) {
        expect(src.toLowerCase()).not.toContain(connector);
      }
    });
  }
});

describe("connection-status primitives — export wiring", () => {
  it("each ships from its own dedicated subpath", () => {
    expect(pkg.exports["./connection-status-badge"]).toBe(
      "./src/connection-status-badge.tsx",
    );
    expect(pkg.exports["./connection-status-card"]).toBe(
      "./src/connection-status-card.tsx",
    );
    expect(pkg.exports["./connections-list"]).toBe(
      "./src/connections-list.tsx",
    );
    expect(pkg.exports["./connector-setup-columns"]).toBe(
      "./src/connector-setup-columns.tsx",
    );
  });
  it("is NOT added to the ratchet-locked root barrel nor the marketplace route graph", () => {
    for (const mod of [
      "connection-status-badge",
      "connection-status-card",
      "connections-list",
      "connector-setup-columns",
    ]) {
      expect(indexSrc).not.toContain(`./${mod}`);
      expect(marketplaceSrc).not.toContain(`./${mod}`);
    }
  });
});
