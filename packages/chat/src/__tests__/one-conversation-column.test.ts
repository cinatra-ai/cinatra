// ---------------------------------------------------------------------------
// THE STRUCTURAL TEST for the owner's architecture bar (cinatra#2683, S8f).
// ---------------------------------------------------------------------------
// "Exactly one conversation-column component exists (exported from the shared
// chat package); both routes consume it; a structural test fails if the embed
// ever mounts a different column implementation."
//
// This is that test, and it is the load-bearing one in the slice. Every other
// check here can only prove that the widget looks right TODAY. This one proves
// there is nowhere for the widget to diverge TOMORROW — a `/chat` conversation
// change is a widget change because both routes render the same module.
//
// It is a SOURCE-LEVEL check on purpose. What it forbids is a shape (a second
// column, a route that mounts something else), and a shape is visible in the
// source of the two routes; a runtime check could only observe whatever the two
// routes happened to mount in the fixture it was given.
//
// The rules are expressed once in `auditConversationColumnUse` and applied to
// the REAL sources. The same function is then applied to deliberately broken
// stand-ins — the negative control — so a green run here is evidence the rules
// can go red, not evidence that they never look.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PKG_ROOT = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "..", "..");

const COLUMN_MODULE = path.join(PKG_ROOT, "src", "conversation-column.tsx");
const CHAT_ROUTE = path.join(PKG_ROOT, "src", "chat-page.tsx");
const EMBED_ROUTE = path.join(
  REPO_ROOT,
  "src",
  "app",
  "embed",
  "assistant",
  "embed-assistant-client.tsx",
);

const read = (p: string) => readFileSync(p, "utf8");

/** The one column's export name, and the specifier a host must import it by. */
const COLUMN = "ConversationColumn";
const COLUMN_SPECIFIER = "@cinatra-ai/chat/conversation-column";

/**
 * Every module that renders conversation UI, and the ONE component allowed to
 * compose them. A route may mount `ConversationColumn`; it may NOT mount these
 * directly, because doing so is how a second column starts.
 *
 * `ConversationTurn` is on the list because it IS the shape S8f deleted: the
 * reduced single-message renderer the embed used to mount, from which every
 * measured gap followed.
 */
const COLUMN_INTERNALS = [
  "ChatMessagesView",
  "PromptField",
  "ConversationTurn",
  "LifecycleCardSurfaceProvider",
];

export type ColumnAuditInput = {
  /** The module that defines the column. */
  columnSource: string;
  /** Every route that renders a conversation, by name. */
  routes: Record<string, string>;
  /**
   * The ONE named, bounded exception, declared here rather than hidden in a
   * looser rule.
   *
   * `/chat`'s EMPTY-STATE START SCREEN mounts a `PromptField` of its own. That
   * screen is frame — the issue lists "empty-state entry points" as explicitly
   * out of scope for the conversation column, and it renders before any thread
   * exists, so there is no conversation for it to be part of. The allowance is
   * therefore POSITIONAL, not blanket: the internal may appear only ABOVE the
   * marker where the conversation return begins. A `PromptField` that drifted
   * down into the conversation branch fails, which is exactly the regression
   * the rule exists to catch.
   */
  frameAllowances?: Record<string, { internal: string; onlyBefore: string }[]>;
};

export type ColumnAuditFinding = { rule: string; detail: string };

/**
 * The bar, as a function. Returns every violation it finds; an empty array is
 * "one column, consumed by both routes, mounted nowhere else".
 */
export function auditConversationColumnUse(input: ColumnAuditInput): ColumnAuditFinding[] {
  const findings: ColumnAuditFinding[] = [];

  // (a) The column exists, exactly once, in the shared package.
  const definitions = input.columnSource.match(
    new RegExp(`export function ${COLUMN}\\b`, "g"),
  ) ?? [];
  if (definitions.length !== 1) {
    findings.push({
      rule: "one-definition",
      detail: `expected exactly 1 \`export function ${COLUMN}\`, found ${definitions.length}`,
    });
  }

  for (const [name, source] of Object.entries(input.routes)) {
    // (b) Every route MOUNTS it...
    if (!new RegExp(`<${COLUMN}\\b`).test(source)) {
      findings.push({ rule: "route-mounts-column", detail: `${name} mounts no <${COLUMN}>` });
    }
    // ...exactly once, so a route cannot mount the shared column beside a
    // second one and still look compliant.
    const mounts = source.match(new RegExp(`<${COLUMN}\\b`, "g")) ?? [];
    if (mounts.length > 1) {
      findings.push({
        rule: "route-mounts-column-once",
        detail: `${name} mounts <${COLUMN}> ${mounts.length} times`,
      });
    }

    // (c) A route outside the package imports it by the PUBLIC specifier — not
    // by a deep relative path that would let a copy be swapped in unnoticed.
    const insidePackage = source === input.columnSource || name === "chat-page.tsx";
    if (!insidePackage && !source.includes(COLUMN_SPECIFIER)) {
      findings.push({
        rule: "route-imports-shared-column",
        detail: `${name} does not import from "${COLUMN_SPECIFIER}"`,
      });
    }

    // (d) A route mounts NO conversation internals of its own. This is the
    // clause that fails when the embed points at a different column.
    const allowances = input.frameAllowances?.[name] ?? [];
    for (const internal of COLUMN_INTERNALS) {
      const pattern = new RegExp(`<${internal}\\b`, "g");
      const positions: number[] = [];
      for (const m of source.matchAll(pattern)) positions.push(m.index ?? 0);
      if (positions.length === 0) continue;
      const allowance = allowances.find((a) => a.internal === internal);
      if (!allowance) {
        findings.push({
          rule: "route-mounts-no-column-internals",
          detail: `${name} mounts <${internal}> directly`,
        });
        continue;
      }
      const boundary = source.indexOf(allowance.onlyBefore);
      if (boundary < 0) {
        findings.push({
          rule: "frame-allowance-boundary-missing",
          detail: `${name}: cannot find the marker "${allowance.onlyBefore}" the <${internal}> allowance is bounded by`,
        });
        continue;
      }
      for (const at of positions) {
        if (at > boundary) {
          findings.push({
            rule: "route-mounts-no-column-internals",
            detail: `${name} mounts <${internal}> inside the conversation branch`,
          });
        }
      }
    }
  }

  return findings;
}

describe("exactly one conversation column, consumed by both routes (#2683)", () => {
  const columnSource = read(COLUMN_MODULE);
  const routes = {
    "chat-page.tsx": read(CHAT_ROUTE),
    "embed-assistant-client.tsx": read(EMBED_ROUTE),
  };
  /** See `frameAllowances` — the one bounded exception, and where it ends. */
  const frameAllowances = {
    "chat-page.tsx": [
      { internal: "PromptField", onlyBefore: "// ----- Conversation state -----" },
    ],
  };

  it("holds for the real /chat and /embed/assistant sources", () => {
    expect(auditConversationColumnUse({ columnSource, routes, frameAllowances })).toEqual([]);
  });

  it("the shared package EXPORTS the column under a public subpath", () => {
    const pkg = JSON.parse(read(path.join(PKG_ROOT, "package.json"))) as {
      exports: Record<string, string>;
    };
    expect(pkg.exports["./conversation-column"]).toBe("./src/conversation-column.tsx");
  });

  it("the embed's own conversation UI is GONE, not merely unused", () => {
    const embed = routes["embed-assistant-client.tsx"];
    // The bespoke single-line composer and its send button.
    expect(embed).not.toContain("EmbedComposer");
    expect(embed).not.toContain("data-embed-composer-submit");
    // The plain-markdown path that bypassed the rich-rendering stack. Matched
    // as a CALL, so the file may still explain in prose what it used to do.
    expect(embed).not.toMatch(/renderMarkdown\s*\(/);
    // The empty widget detector that guaranteed no extension chat widget could
    // ever be found on this surface.
    expect(embed).not.toContain("NO_WIDGETS");
    // The reduced single-message renderer and its reducer state.
    expect(embed).not.toMatch(/<ConversationTurn\b|\bConversationTurn[,}\s]*from/);
    expect(embed).not.toContain("initialConversationState");
  });

  // -------------------------------------------------------------------------
  // NEGATIVE CONTROL — point the embed at a different column and watch it red.
  // -------------------------------------------------------------------------
  describe("negative control", () => {
    it("goes RED when the embed mounts a different column", () => {
      const stubbedEmbed = routes["embed-assistant-client.tsx"]
        .replace(new RegExp(`<${COLUMN}\\b`), "<WidgetOwnColumn")
        .replaceAll(COLUMN_SPECIFIER, "./widget-own-column");
      const findings = auditConversationColumnUse({
        columnSource,
        routes: { ...routes, "embed-assistant-client.tsx": stubbedEmbed },
        frameAllowances,
      });
      expect(findings.map((f) => f.rule)).toContain("route-mounts-column");
      expect(findings.map((f) => f.rule)).toContain("route-imports-shared-column");
    });

    it("goes RED when a route re-grows its own composer or message list", () => {
      for (const internal of COLUMN_INTERNALS) {
        const regrown = `${routes["embed-assistant-client.tsx"]}\nconst leak = <${internal} />;\n`;
        const findings = auditConversationColumnUse({
          columnSource,
          routes: { ...routes, "embed-assistant-client.tsx": regrown },
          frameAllowances,
        });
        expect(
          findings.some(
            (f) => f.rule === "route-mounts-no-column-internals" && f.detail.includes(internal),
          ),
        ).toBe(true);
      }
    });

    it("goes RED when a SECOND column definition appears", () => {
      const twoColumns = `${columnSource}\nexport function ${COLUMN}() { return null; }\n`;
      const findings = auditConversationColumnUse({
        columnSource: twoColumns,
        routes,
        frameAllowances,
      });
      expect(findings.map((f) => f.rule)).toContain("one-definition");
    });

    it("goes RED when a route mounts the shared column TWICE", () => {
      const doubled = routes["embed-assistant-client.tsx"].replace(
        new RegExp(`<${COLUMN}\\b`),
        `<${COLUMN} /><${COLUMN}`,
      );
      const findings = auditConversationColumnUse({
        columnSource,
        routes: { ...routes, "embed-assistant-client.tsx": doubled },
        frameAllowances,
      });
      expect(findings.map((f) => f.rule)).toContain("route-mounts-column-once");
    });
  });
});
