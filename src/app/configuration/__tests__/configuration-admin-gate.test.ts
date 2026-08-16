/**
 * THE `/configuration` GATE TABLE (cinatra#2700, epic #2699).
 *
 * The epic's rule in one line: **every route under `/configuration` requires the
 * platform-admin session.** This file is the enumerated fixture that holds it —
 * all 34 page routes and all 6 route-handler methods, named one by one.
 *
 * Two properties are asserted together, and the pairing is the point:
 *
 *   1. COMPLETENESS — the routes discovered on disk are EXACTLY the routes in
 *      the table. A new `/configuration` surface (for example the planned
 *      `/configuration/dashboards`) fails this test until it is entered here,
 *      which is how a new route "inherits the rule" instead of quietly opting
 *      out of it.
 *   2. THE GATE — each entry names the file that carries its gate and the gate
 *      it carries. Most pages gate themselves; a handful delegate to the screen
 *      or mount they render, so the entry names THAT file and, where the file
 *      hosts many surfaces, the exact function whose body must open with the
 *      gate.
 *
 * Why source-level assertions: these are async server components whose module
 * graphs reach the generated extension wiring, so they cannot be imported in
 * isolation — the same reason the sibling locks
 * (`packages/agents/src/__tests__/agent-approval-detail-access.test.ts`,
 * `src/components/artifacts/console/__tests__/console-link-retargets.test.ts`)
 * are file-grep contracts. The BEHAVIOUR of `requireAdminSession` itself is
 * covered by `src/lib/__tests__/auth-session.test.ts`, and the live route
 * denials by `tests/e2e/rbac/rbac-authorization.spec.ts`.
 *
 * NOT an authorization boundary, deliberately: `src/app/configuration/layout.tsx`
 * gates too, but only as defense in depth. App Router layouts are not
 * re-rendered on a soft navigation, and server actions and route handlers never
 * pass through a layout at all — hence the per-route table below, the per-action
 * fixtures in `src/app/campaigns/__tests__/configuration-actions-admin-gate.test.ts`,
 * and the handler pins at the end of this file.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const CONFIG_DIR = path.join(REPO_ROOT, "src", "app", "configuration");

const read = (relativePath: string) =>
  readFileSync(path.join(REPO_ROOT, relativePath), "utf8");

/** Every gate that counts as "requires the platform-admin session". */
const ADMIN_GATES = {
  /** The app-wide gate: redirects a non-admin to /not-authorized. */
  requireAdminSession: /await requireAdminSession\(\)/,
  /** The mcp-server mount's own equivalent, used by the surfaces it owns. */
  requireMountedAdminSession: /await requireMountedAdminSession\(/,
  /** The predicate form, paired with an explicit redirect on the same page. */
  isPlatformAdminRedirect: /if \(!isPlatformAdmin\(session\)\) redirect\(/,
} as const;

type GateName = keyof typeof ADMIN_GATES;

type RouteEntry = {
  /** The gate-carrying file, repo-relative. */
  gateFile: string;
  gate: GateName;
  /**
   * For a file that hosts several surfaces, the function whose body must carry
   * the gate. `[startMarker, endMarker]` bounds the slice that is searched.
   */
  scope?: [string, string];
  /** Why the gate lives outside the route file, when it does. */
  note?: string;
};

/**
 * All 34 page routes, keyed by their path under `src/app/configuration`.
 * The 12 entries cinatra#2700 changed are marked SWEPT.
 */
const PAGE_ROUTES: Record<string, RouteEntry> = {
  "page.tsx": { gateFile: "src/app/configuration/page.tsx", gate: "requireAdminSession" },
  "access-control/page.tsx": {
    gateFile: "src/app/configuration/access-control/page.tsx",
    gate: "requireAdminSession",
  },
  // SWEPT — was requireAuthSession (author-readable carve-out).
  "agents/approvals/[id]/page.tsx": {
    gateFile: "src/app/configuration/agents/approvals/[id]/page.tsx",
    gate: "requireAdminSession",
  },
  // SWEPT ×5 — the redirect shims had no gate of their own.
  "apps/page.tsx": { gateFile: "src/app/configuration/apps/page.tsx", gate: "requireAdminSession" },
  "apps/apollo/page.tsx": {
    gateFile: "src/app/configuration/apps/apollo/page.tsx",
    gate: "requireAdminSession",
  },
  "apps/gmail/page.tsx": {
    gateFile: "src/app/configuration/apps/gmail/page.tsx",
    gate: "requireAdminSession",
  },
  "apps/openai/page.tsx": {
    gateFile: "src/app/configuration/apps/openai/page.tsx",
    gate: "requireAdminSession",
  },
  "apps/openai-skills/page.tsx": {
    gateFile: "src/app/configuration/apps/openai-skills/page.tsx",
    gate: "requireAdminSession",
  },
  "artifacts/page.tsx": {
    gateFile: "src/app/configuration/artifacts/page.tsx",
    gate: "requireAdminSession",
  },
  // SWEPT — was getAuthSession only (per-object carve-out). The per-object
  // eligibility check REMAINS, on top of the gate.
  "artifacts/restore/[changeSetId]/page.tsx": {
    gateFile: "src/app/configuration/artifacts/restore/[changeSetId]/page.tsx",
    gate: "requireAdminSession",
  },
  "assistants/page.tsx": {
    gateFile: "src/app/configuration/assistants/page.tsx",
    gate: "requireAdminSession",
  },
  // SWEPT — no gate of its own.
  "development/page.tsx": {
    gateFile: "src/app/configuration/development/page.tsx",
    gate: "requireAdminSession",
  },
  "environment/page.tsx": {
    gateFile: "src/app/configuration/environment/page.tsx",
    gate: "requireAdminSession",
  },
  "execution/page.tsx": {
    gateFile: "src/app/configuration/execution/page.tsx",
    gate: "requireAdminSession",
  },
  // SWEPT — the list was session-only (its screen used requireAuthSession).
  "extensions/page.tsx": {
    gateFile: "src/app/configuration/extensions/page.tsx",
    gate: "requireAdminSession",
  },
  "extensions/settings/[kind]/[...pkg]/page.tsx": {
    gateFile: "packages/extensions/src/screens/extension-settings-screen.tsx",
    gate: "requireAdminSession",
    note: "the route renders ExtensionSettingsScreen, which gates itself",
  },
  "extensions/upload/page.tsx": {
    gateFile: "src/app/configuration/extensions/upload/page.tsx",
    gate: "requireAdminSession",
  },
  "lifecycle-operations/page.tsx": {
    gateFile: "src/app/configuration/lifecycle-operations/page.tsx",
    gate: "requireAdminSession",
  },
  // SWEPT ×2 — neither LLM page had a gate of its own.
  "llm/page.tsx": { gateFile: "src/app/configuration/llm/page.tsx", gate: "requireAdminSession" },
  "llm/[apiSlug]/page.tsx": {
    gateFile: "src/app/configuration/llm/[apiSlug]/page.tsx",
    gate: "requireAdminSession",
  },
  "marketplace/page.tsx": {
    gateFile: "src/app/configuration/marketplace/page.tsx",
    gate: "requireAdminSession",
  },
  "marketplace/[scope]/[name]/page.tsx": {
    gateFile: "src/app/configuration/marketplace/[scope]/[name]/page.tsx",
    gate: "requireAdminSession",
  },
  "marketplace/submissions/page.tsx": {
    gateFile: "src/app/configuration/marketplace/submissions/page.tsx",
    gate: "requireAdminSession",
  },
  "marketplace/submissions/admin/page.tsx": {
    gateFile: "src/app/configuration/marketplace/submissions/admin/page.tsx",
    gate: "requireAdminSession",
  },
  "marketplace/vendor-applications/page.tsx": {
    gateFile: "src/app/configuration/marketplace/vendor-applications/page.tsx",
    gate: "requireAdminSession",
  },
  "mcp/page.tsx": {
    gateFile: "packages/mcp-server/src/index.tsx",
    gate: "requireMountedAdminSession",
    scope: ["async function overviewPage", "async function authPage"],
    note: "the route renders the mount's OverviewPage, which gates itself",
  },
  "mcp/clients/[clientId]/page.tsx": {
    gateFile: "packages/mcp-server/src/index.tsx",
    gate: "requireMountedAdminSession",
    scope: ["async function clientPage", "async function consentPage"],
    note: "the route renders the mount's ClientPage, which gates itself",
  },
  "permissions/page.tsx": {
    gateFile: "src/app/configuration/permissions/page.tsx",
    gate: "isPlatformAdminRedirect",
    note: "pre-existing shape: the predicate plus an explicit redirect",
  },
  "permissions/[path]/page.tsx": {
    gateFile: "packages/permissions/src/organization-page.tsx",
    gate: "requireAdminSession",
    note: "the route renders PermissionsOrganizationPage, which gates itself",
  },
  "skills/page.tsx": {
    gateFile: "src/app/configuration/skills/page.tsx",
    gate: "requireAdminSession",
  },
  // SWEPT — no gate of its own.
  "telemetry/page.tsx": {
    gateFile: "src/app/configuration/telemetry/page.tsx",
    gate: "requireAdminSession",
  },
  "webhooks/page.tsx": {
    gateFile: "src/app/configuration/webhooks/page.tsx",
    gate: "requireAdminSession",
  },
  "workspace/page.tsx": {
    gateFile: "src/app/configuration/workspace/page.tsx",
    gate: "requireAdminSession",
  },
  "workspace/members/page.tsx": {
    gateFile: "src/app/configuration/workspace/members/page.tsx",
    gate: "requireAdminSession",
  },
};

/**
 * The 6 route-handler methods. Handlers bypass BOTH the segment layout and the
 * page gates, so each denies in its own body — and it denies the way its caller
 * can act on: a `fetch()` caller gets JSON, a browser form POST gets a 303 to
 * the sign-in / not-authorized page.
 */
type HandlerEntry = {
  routeFile: string;
  methods: string[];
  gateFile: string;
  /** Fragments the denial arm must contain, in the handler's own body. */
  denials: RegExp[];
  scope?: [string, string];
};

const ROUTE_HANDLERS: Record<string, HandlerEntry> = {
  "mcp/connectivity-check/route.ts": {
    routeFile: "src/app/configuration/mcp/connectivity-check/route.ts",
    methods: ["POST"],
    gateFile: "packages/mcp-server/src/index.tsx",
    scope: ["ConnectivityCheckHandlers: {", "PublicBaseUrlHandlers: {"],
    denials: [
      /if \(!session\) \{\s*return NextResponse\.redirect\(buildSignInHref/,
      /if \(!isAdminSession\(session\)\) \{\s*return NextResponse\.redirect\(new URL\("\/not-authorized"/,
    ],
  },
  "mcp/public-url/route.ts": {
    routeFile: "src/app/configuration/mcp/public-url/route.ts",
    methods: ["POST"],
    gateFile: "packages/mcp-server/src/index.tsx",
    scope: ["PublicBaseUrlHandlers: {", "SelfClientHandlers: {"],
    denials: [
      /if \(!session\) \{\s*return NextResponse\.redirect\(buildSignInHref/,
      /if \(!isAdminSession\(session\)\) \{\s*return NextResponse\.redirect\(new URL\("\/not-authorized"/,
    ],
  },
  "mcp/self-client/route.ts": {
    routeFile: "src/app/configuration/mcp/self-client/route.ts",
    methods: ["POST"],
    gateFile: "packages/mcp-server/src/index.tsx",
    scope: ["SelfClientHandlers: {", "LlmAccessHandlers: {"],
    denials: [
      /if \(!session\) \{\s*return NextResponse\.redirect\(buildSignInHref/,
      /if \(!isAdminSession\(session\)\) \{\s*return NextResponse\.redirect\(new URL\("\/not-authorized"/,
    ],
  },
  "mcp/llm-access/route.ts": {
    routeFile: "src/app/configuration/mcp/llm-access/route.ts",
    methods: ["POST", "DELETE"],
    gateFile: "packages/mcp-server/src/index.tsx",
    scope: ["LlmAccessHandlers: {", "TransportHandlers: {"],
    denials: [
      /if \(!session\) return NextResponse\.json\(\{ error: "Unauthorized" \}, \{ status: 401 \}\);/,
      /if \(!isAdminSession\(session\)\) return NextResponse\.json\(\{ error: "Forbidden" \}, \{ status: 403 \}\);/,
    ],
  },
  "mcp/llm-access/test/route.ts": {
    routeFile: "src/app/configuration/mcp/llm-access/test/route.ts",
    methods: ["POST"],
    gateFile: "src/app/configuration/mcp/llm-access/test/route.ts",
    denials: [
      /if \(!session \|\| !roles\.includes\("admin"\)\) \{\s*return NextResponse\.json\(\{ error: "Unauthorized" \}, \{ status: 401 \}\);/,
    ],
  },
};

/** Every `page.tsx` / `route.ts` under src/app/configuration, path-relative. */
function discoverRouteFiles(): { pages: string[]; handlers: string[] } {
  const pages: string[] = [];
  const handlers: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "__tests__") continue;
        walk(full);
        continue;
      }
      const rel = path.relative(CONFIG_DIR, full);
      if (entry === "page.tsx") pages.push(rel);
      if (entry === "route.ts") handlers.push(rel);
    }
  };
  walk(CONFIG_DIR);
  return { pages, handlers };
}

function sliceScope(source: string, [start, end]: [string, string]): string {
  const from = source.indexOf(start);
  expect(from, `scope start not found: ${start}`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to, `scope end not found: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("cinatra#2700 — the /configuration route table is complete", () => {
  const discovered = discoverRouteFiles();

  it("names every page route on disk — a NEW /configuration page fails until it is entered here", () => {
    expect(discovered.pages.sort()).toEqual(Object.keys(PAGE_ROUTES).sort());
  });

  it("names every route handler on disk", () => {
    expect(discovered.handlers.sort()).toEqual(Object.keys(ROUTE_HANDLERS).sort());
  });

  it("covers the 34 page routes and the 6 handler methods the epic enumerates", () => {
    expect(Object.keys(PAGE_ROUTES)).toHaveLength(34);
    const methodCount = Object.values(ROUTE_HANDLERS).reduce(
      (total, handler) => total + handler.methods.length,
      0,
    );
    expect(methodCount).toBe(6);
  });
});

describe("cinatra#2700 — every /configuration page route requires the platform-admin session", () => {
  for (const [route, entry] of Object.entries(PAGE_ROUTES)) {
    it(`${route} gates via ${entry.gate} in ${entry.gateFile}`, () => {
      const source = read(entry.gateFile);
      const body = entry.scope ? sliceScope(source, entry.scope) : source;
      expect(body).toMatch(ADMIN_GATES[entry.gate]);
      // No route may fall back to the session-only gates the sweep retired.
      if (entry.gate === "requireAdminSession" && !entry.scope) {
        expect(body).not.toMatch(/await requireAuthSession\(\)/);
      }
    });
  }
});

describe("cinatra#2700 — the segment layout gates too, as defense in depth ONLY", () => {
  const layout = read("src/app/configuration/layout.tsx");

  it("the layout carries the admin gate", () => {
    expect(layout).toMatch(ADMIN_GATES.requireAdminSession);
  });

  it("the layout states WHY it cannot be the authorization boundary", () => {
    // The per-route gates above are load-bearing precisely because this is not:
    // layouts do not re-render on a soft navigation, and neither server actions
    // nor route handlers pass through one.
    expect(layout).toMatch(/DEFENSE IN DEPTH ONLY/);
    expect(layout).toMatch(/do not re-render on a soft \(client-side\) navigation/);
    expect(layout).toMatch(/server actions and route handlers never pass through a layout/);
  });
});

/**
 * THE ACTION TABLE — the sweep clause's completeness half.
 *
 * A server action never passes through a layout, so every exported action in
 * the segment has to state its own gate. This walks every `"use server"` module
 * under `src/app/configuration`, extracts each exported async function, and
 * holds it to one of the accepted gates — or to a written-down reason, which is
 * the only way an action may sit here ungated.
 *
 * A NEW ungated action fails this test the moment it is added.
 */
const ACTION_GATES = [
  "requireAdminSession",
  // The predicate form, used where the action answers with a value rather than
  // a redirect.
  "isPlatformAdmin",
  // The lifecycle console's own authorization module — `settings.update`,
  // deliberately org-admin-inclusive and documented as the authoritative
  // boundary on that write in src/lib/artifacts/lifecycle-policy-access.ts.
  "resolvePolicyBoundWriteAccess",
];

/** Ungated exports, each with the reason it is allowed to be. */
const ACTION_EXCEPTIONS: Record<string, string> = {
  // Both delegate to the shared decide helper, whose primitive refuses a
  // non-admin ("admin session required" → the `not_admin` refusal code).
  "src/app/configuration/agents/approvals/[id]/actions.ts::approveAgentCreationRequest":
    "gated in the shared decide helper's primitive (not_admin refusal)",
  "src/app/configuration/agents/approvals/[id]/actions.ts::rejectAgentCreationRequest":
    "gated in the shared decide helper's primitive (not_admin refusal)",
  // The whole body is `redirect("/configuration/llm")` — retired stubs kept for
  // their signature. There is no effect to guard, and the destination is gated.
  "src/app/campaigns/actions.ts::saveAnthropicPromptCachingAction": "no-op redirect stub",
  "src/app/campaigns/actions.ts::setDefaultClaudeModelAction": "no-op redirect stub",
  "src/app/campaigns/actions.ts::setAnthropicMcpModeAction": "no-op redirect stub",
  // Surface is `/connectors/...`, not `/configuration` — out of the epic's
  // scope, and each carries its own connector-manage authorization.
  "src/app/campaigns/actions.ts::saveNangoConnectionAction": "connector surface, gated in the connector",
  "src/app/campaigns/actions.ts::saveTwentyConnectionAction": "connector surface, requireTwentyConnectManager",
  "src/app/campaigns/actions.ts::disconnectTwentyConnectionAction": "connector surface, requireTwentyConnectManager",
  // Surface is `/campaigns`, not `/configuration`.
  "src/app/campaigns/actions.ts::deleteCampaignAction": "campaigns surface, requireAuthSession",
};

/** The `"use server"` modules the sweep covers. */
const ACTION_MODULES = [
  "src/app/campaigns/actions.ts",
  "src/app/configuration/a2a/actions.ts",
  "src/app/configuration/access-control/actions.ts",
  "src/app/configuration/agents/approvals/[id]/actions.ts",
  "src/app/configuration/artifacts/review-policy-actions.ts",
  "src/app/configuration/assistants/actions.ts",
  "src/app/configuration/development/actions.ts",
  "src/app/configuration/environment/marketplace-publish-actions.ts",
  "src/app/configuration/environment/vendor-application-actions.ts",
  "src/app/configuration/execution/actions.ts",
  "src/app/configuration/instance/actions.ts",
  "src/app/configuration/llm/diagnostics-actions.ts",
  "src/app/configuration/marketplace/submissions/actions.ts",
  "src/app/configuration/marketplace/vendor-applications/actions.ts",
  "src/app/configuration/network/actions.ts",
  "src/app/configuration/permissions/actions.ts",
  "src/app/configuration/skills/actions.ts",
];

/**
 * Is this file a server-action module? The `"use server"` directive has to be
 * the first STATEMENT, but leading comments are allowed and several of these
 * modules open with a banner comment — so strip comments and blank lines first
 * rather than testing the raw first character.
 */
function isServerActionModule(source: string): boolean {
  const withoutLeadingComments = source.replace(
    /^(?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*/,
    "",
  );
  return withoutLeadingComments.startsWith('"use server"');
}

/** Exported async functions of a module, each paired with its own body slice. */
function exportedActions(source: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const re = /export\s+async\s+function\s+(\w+)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const from = match.index;
    const next = source.indexOf("\nexport ", from + 1);
    out.push({ name: match[1], body: source.slice(from, next === -1 ? source.length : next) });
  }
  return out;
}

describe("cinatra#2700 — the action sweep: every /configuration server action states a gate", () => {
  for (const modulePath of ACTION_MODULES) {
    it(`${modulePath} — every exported action gates itself`, () => {
      const actions = exportedActions(read(modulePath));
      expect(actions.length, `no exported actions found in ${modulePath}`).toBeGreaterThan(0);
      for (const action of actions) {
        const key = `${modulePath}::${action.name}`;
        if (key in ACTION_EXCEPTIONS) continue;
        const gated = ACTION_GATES.some((gate) => action.body.includes(gate));
        expect(gated, `${key} carries no gate and no documented exception`).toBe(true);
      }
    });
  }

  it("the exception list stays SHORT and every entry carries a reason", () => {
    for (const [key, reason] of Object.entries(ACTION_EXCEPTIONS)) {
      expect(reason.length, `${key} needs a reason`).toBeGreaterThan(10);
    }
    expect(Object.keys(ACTION_EXCEPTIONS)).toHaveLength(9);
  });

  it("names every `use server` module in the segment — a NEW action file fails until it is listed", () => {
    const discovered: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir).sort()) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry === "__tests__") continue;
          walk(full);
          continue;
        }
        if (!entry.endsWith(".ts")) continue;
        const source = readFileSync(full, "utf8");
        if (!isServerActionModule(source)) continue;
        if (!/export\s+async\s+function\s/.test(source)) continue;
        discovered.push(path.relative(REPO_ROOT, full));
      }
    };
    walk(CONFIG_DIR);
    expect(discovered.sort()).toEqual(
      ACTION_MODULES.filter((m) => m.startsWith("src/app/configuration/")).sort(),
    );
  });
});

describe("cinatra#2700 — the MCP route handlers keep their own denials (handlers bypass layouts)", () => {
  for (const [route, handler] of Object.entries(ROUTE_HANDLERS)) {
    it(`${route} (${handler.methods.join(", ")}) denies in its own body`, () => {
      const routeSource = read(handler.routeFile);
      for (const method of handler.methods) {
        expect(routeSource).toMatch(new RegExp(`export async function ${method}\\b`));
      }
      const gateSource = read(handler.gateFile);
      const body = handler.scope ? sliceScope(gateSource, handler.scope) : gateSource;
      for (const denial of handler.denials) {
        expect(body).toMatch(denial);
      }
    });
  }

  it("the two JSON handlers answer 401 unauthenticated and 403 non-admin — never a redirect a fetch() caller cannot follow", () => {
    const llmAccess = sliceScope(
      read("packages/mcp-server/src/index.tsx"),
      ["LlmAccessHandlers: {", "TransportHandlers: {"],
    );
    expect(llmAccess.match(/status: 401/g) ?? []).toHaveLength(2); // POST + DELETE
    expect(llmAccess.match(/status: 403/g) ?? []).toHaveLength(2);
    expect(llmAccess).not.toMatch(/NextResponse\.redirect/);
  });
});
