// cinatra#1214 S3 — in-admin CMS assistant MCP-only egress: the cinatra-side
// STANDING guard.
//
// The house rule (#1214 / epic #1037): the in-admin CMS assistant (the embedded
// widget in the WordPress or Drupal admin) reaches the CMS ONLY through that
// CMS's MCP integration — never a direct REST / JSON:API call with a stored
// credential. The WordPress in-admin read/update was rerouted onto the site's
// MCP content server (S1, wordpress-mcp-connector#66); Drupal's one remaining
// direct read was inverted to an MCP-primary read (S2, drupal-mcp-connector#64).
//
// The connector repos each carry their OWN code-path egress guard (S4 — the
// "D2" sibling that proves absence in the connector's handler at that repo's
// CI). What no per-connector guard can catch is the DISTINCT cinatra-side
// regression: **cinatra core adopting (via the extension lock) a connector
// version that reintroduced direct CMS REST on the agent path.** This guard
// closes exactly that gap — it asserts the invariant over the connector
// integration surfaces cinatra ACTUALLY HOSTS (the workspace-resolved connector
// handler sources) plus core's own CMS-connection surfaces:
//
//   (a) no direct WordPress `/wp/v2/*` or Drupal `/jsonapi/*` REST egress in the
//       agent-path handler code cinatra hosts (no direct fetch, no deleted
//       direct-REST helper, no legacy direct-REST DI call), and
//   (b) the sanctioned MCP transports are the routing — asserted at the SPECIFIC
//       handler->governed-invoker edges for WordPress and the MCP-helper edges
//       for Drupal, not merely file-wide symbol presence. Connector #114
//       removed WordPress's connector-owned snapshot/review/read-back helpers.
//       Connector #119 split the site tool into the read-only
//       wordpress_site_tool_call and the new wordpress_site_tool_write; both
//       handlers forward through the one shared forwardSiteTool, which holds
//       the governed invoker edge, so the guard asserts both handler edges
//       and that shared function.
//
// It is a pure static/AST-shaped source assertion: hermetic, Docker-free, and
// runs in the always-on `pnpm test:root` suite (build-image.yml) where
// `clone-extensions` has resolved the connector handler sources cinatra hosts.
// It turns RED the moment the hosted connector agent path carries a direct-REST
// call again, and GREEN on the compliant MCP-only path.
//
// SCOPE NOTE: this covers the two in-admin editing primitives rerouted by
// S1/S2 (post read+update / node read) — the ratified #1214 reroute scope. The
// adjacent WordPress primitives (status/list/delete/media/draft/meta) remain
// direct-REST-backed and are NOT rerouted; whether the in-admin agent's tool
// access must be allowlisted so it cannot REACH them is a distinct #1214 fix
// question (surfaced on the issue), out of this guard's assertion scope.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import ts from "typescript";

// Shared single-pass LEXICAL comment stripper — comment-context-aware, so a
// `/wp/v2` inside a URL string literal (`"https://host/wp/v2/..."`) is PRESERVED
// and correctly caught, and a `//` inside a protocol-relative URL is not
// mistaken for a line comment. A naive regex stripper would drop the tail of
// such a URL and let a real direct-REST call slip through the guard.
// The .mjs audit helper resolves under the test tsconfig (same import the
// sibling toast-banner guard uses); no ts-expect-error needed.
import { stripComments } from "../../../scripts/audit/lib/strip-comments.mjs";

import {
  resolveWordPressMcpEndpoint,
  resolveWordPressMcpFallbackEndpoint,
} from "@/lib/wordpress-mcp-connection";

const require = createRequire(import.meta.url);

/** Read the connector handler SOURCE cinatra hosts via its published export. */
function readHostedHandlerCode(mcpHandlersSpecifier: string): string {
  const resolved = require.resolve(mcpHandlersSpecifier);
  return stripComments(readFileSync(resolved, "utf8"));
}

function namedFunction(source: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const declaration = source.statements.find(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  if (!declaration?.body) throw new Error(`Missing hosted function: ${name}`);
  return declaration;
}

function callsNamed(node: ts.Node, name: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  function visit(child: ts.Node) {
    if (ts.isCallExpression(child) && child.expression.getText() === name) calls.push(child);
    ts.forEachChild(child, visit);
  }
  visit(node);
  return calls;
}

// The two hosted site tools that forward a site ability call to the site.
const SITE_TOOL_HANDLERS = ["wordpress_site_tool_call", "wordpress_site_tool_write"] as const;

function propertyName(node: ts.ObjectLiteralElementLike): string {
  const name = (node as { name?: ts.PropertyName }).name;
  return name && (ts.isStringLiteral(name) || ts.isIdentifier(name)) ? name.text : node.getText();
}

function assertGovernedWordPressRouting(code: string): void {
  const source = ts.createSourceFile("hosted-handlers.ts", code, ts.ScriptTarget.Latest, true);
  const factory = namedFunction(source, "createWordPressPrimitiveHandlers");
  const returned = factory.body!.statements.find(ts.isReturnStatement)?.expression;
  const handlers = returned && ts.isAsExpression(returned) ? returned.expression : returned;
  if (!handlers || !ts.isObjectLiteralExpression(handlers)) throw new Error("Missing hosted handler map");
  // The entries of the handler map whose source names the shared forward or
  // the invoker are exactly the two site tools: a further entry that names
  // either one, or a site tool that no longer forwards, fails here.
  const forwarding = handlers.properties
    .filter((node) => /\b(?:forwardSiteTool|invokeSiteTool)\b/.test(node.getText()))
    .map(propertyName)
    .sort();
  expect(forwarding).toEqual([...SITE_TOOL_HANDLERS].sort());
  for (const name of SITE_TOOL_HANDLERS) {
    const property = handlers.properties.find(
      (node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node) && propertyName(node) === name,
    );
    if (!property || !ts.isArrowFunction(property.initializer)) {
      throw new Error(`Missing WordPress site-tool handler: ${name}`);
    }
    // Each site tool reaches the site only through the shared governed
    // forward, once, as its result, naming itself as the calling tool (the
    // name the write-authority record carries).
    const body = property.initializer.body;
    const bodyText = body.getText().replace(/\s+/g, "");
    expect(bodyText).not.toContain("invokeSiteTool");
    const forwards = callsNamed(body, "forwardSiteTool");
    expect(forwards).toHaveLength(1);
    expect(forwards[0] === body || ts.isReturnStatement(forwards[0].parent)).toBe(true);
    if (ts.isBlock(body)) expect(bodyText).toContain("constinput=siteToolCallSchema.parse(request.input);");
    expect(forwards[0].arguments.map((arg) => arg.getText().replace(/\s+/g, ""))).toEqual([
      ts.isBlock(body) ? "input" : "siteToolCallSchema.parse(request.input)",
      JSON.stringify(name),
    ]);
  }

  const forward = namedFunction(source, "forwardSiteTool");
  expect(forward.parameters.map((parameter) => parameter.name.getText())).toEqual(["input", "tool"]);
  const handler = forward.body!;
  const compact = handler.getText().replace(/\s+/g, "");
  expect(compact).toContain("constinvoke=getWordPressDeps().invokeSiteTool;");
  // The unavailable-channel branch must throw; unrelated strings elsewhere
  // in the connector cannot stand in for the actual handler edge.
  const unavailable = handler.statements.find(
    (node): node is ts.IfStatement => ts.isIfStatement(node)
      && node.expression.getText().replace(/\s+/g, "") === 'typeofinvoke!=="function"',
  );
  expect(unavailable?.thenStatement.getText()).toMatch(/^\{\s*throw new Error\(/);
  const updateBranch = handler.statements.find(
    (node): node is ts.IfStatement => ts.isIfStatement(node)
      && node.expression.getText().replace(/\s+/g, "") === "CONTENT_REVIEW_TARGET_ABILITIES.has(input.toolName)",
  );
  expect(updateBranch?.thenStatement.getText().replace(/\s+/g, ""))
    .toBe("{returncallReviewGatedSiteTool(invoke,input,tool);}");
  expect(code).toMatch(/const EWPA_UPDATE_POST_ABILITY\s*=\s*["']ewpa\/update-post["']/);
  expect(code).toMatch(/CONTENT_REVIEW_TARGET_ABILITIES[^;]*new Set\(\[EWPA_UPDATE_POST_ABILITY\]\)/);
  const genericCalls = callsNamed(handler, "invoke");
  expect(genericCalls).toHaveLength(1);
  expect(ts.isReturnStatement(genericCalls[0].parent)).toBe(true);

  const reviewGated = namedFunction(source, "callReviewGatedSiteTool");
  expect(reviewGated.parameters[2]?.name.getText()).toBe("tool");
  const update = reviewGated.body!;
  const updateCalls = callsNamed(update, "invoke");
  expect(updateCalls).toHaveLength(1);
  const authority = callsNamed(update, "requireWriteAuthority");
  expect(authority).toHaveLength(1);
  expect(ts.isAwaitExpression(authority[0].parent)).toBe(true);
  expect(authority[0].getText()).toBe("requireWriteAuthority(instanceId, tool)");
  expect(authority[0].getStart()).toBeLessThan(updateCalls[0].getStart());
  expect(update.getText()).toMatch(/if\s*\(!instanceId\)\s*\{\s*throw/);
  expect(update.getText()).toMatch(/if\s*\(!Number\.isInteger\(postId\)\s*\|\|\s*postId\s*<=\s*0\)\s*\{\s*throw/);
  for (const call of [...genericCalls, ...updateCalls]) {
    const args = call.arguments[0];
    if (!args || !ts.isObjectLiteralExpression(args)) throw new Error("Missing governed invocation coordinates");
    const fields = args.properties.filter(ts.isPropertyAssignment);
    expect(fields.find((field) => field.name.getText() === "toolName")?.initializer.getText()).toBe("input.toolName");
    expect(fields.find((field) => field.name.getText() === "args")?.initializer.getText()).toBe("input.args");
    expect(fields.some((field) => ["actor", "connectorKey", "kind"].includes(field.name.getText()))).toBe(false);
  }
}

const FORWARD_ANCHOR = "async function forwardSiteTool(";
const HANDLERS_ANCHOR = "export function createWordPressPrimitiveHandlers()";

// Replace the first `before` that follows `anchor` (anchor must occur once).
function mutateHandler(code: string, anchor: string, before: string, after: string): string {
  const start = code.indexOf(anchor);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(code.indexOf(anchor, start + 1)).toBe(-1);
  const handlerSource = code.slice(start);
  expect(handlerSource).toContain(before);
  return code.slice(0, start) + handlerSource.replace(before, after);
}

// ---------------------------------------------------------------------------
// WordPress — the connector agent-path handler cinatra hosts routes the
// in-admin read/update through the MCP content tools, never a direct /wp/v2 call.
// ---------------------------------------------------------------------------
describe("in-admin CMS egress guard — hosted WordPress connector", () => {
  const code = readHostedHandlerCode("@cinatra-ai/wordpress-mcp-connector/mcp-handlers");

  it("makes no direct fetch() call on the hosted agent path", () => {
    expect(code).not.toMatch(/\bfetch\s*\(/);
  });

  it("references no direct /wp/v2 REST path in code (string literals included)", () => {
    expect(code).not.toMatch(/\/wp\/v2/);
  });

  it("does not host the deleted direct-REST helpers", () => {
    for (const deleted of ["readWordPressPost", "updateWordPressPost"]) {
      expect(code).not.toContain(deleted);
    }
  });

  it("makes no legacy direct-REST DI call on the in-admin read/update path", () => {
    // The pre-reroute handler read/wrote via `getWordPressDeps().readPost(...)`
    // / `.updatePost(...)` (direct /wp/v2). Ban those exact DI edges so a
    // restored client method cannot coexist with an unused MCP symbol.
    // `.readPostStatus(` is a DISTINCT (non-rerouted) primitive and does not
    // match `\.readPost\(`.
    expect(code).not.toMatch(/\.readPost\s*\(/);
    expect(code).not.toMatch(/\.updatePost\s*\(/);
  });

  it("routes the in-admin read/update through the governed invoker (routing-edge positive control)", () => {
    // Both the old connector composition and #114's own-result forwarding
    // use these governed edges. This is an egress guard, not proof that the
    // separately ordered agent snapshot/review lifecycle is complete.
    assertGovernedWordPressRouting(code);
  });

  it("rejects an ungoverned handler even when the invoker name remains elsewhere", () => {
    const changed = mutateHandler(code, FORWARD_ANCHOR, "const invoke = getWordPressDeps().invokeSiteTool;", "const invoke = ungovernedCall;");
    expect(() => assertGovernedWordPressRouting(changed)).toThrow();
  });

  it("rejects a missing-invoker fallback instead of a refusal", () => {
    const changed = mutateHandler(code, FORWARD_ANCHOR, 'if (typeof invoke !== "function")', 'if (typeof invoke === "function")');
    expect(() => assertGovernedWordPressRouting(changed)).toThrow();
  });

  it("rejects an update branch that bypasses argument and authority checks", () => {
    const changed = mutateHandler(code, FORWARD_ANCHOR, "return callReviewGatedSiteTool(invoke, input, tool);", "return invoke(input);");
    expect(() => assertGovernedWordPressRouting(changed)).toThrow();
  });

  it("rejects an update that forwards before its write-authority gate", () => {
    const before = "await requireWriteAuthority(instanceId, tool);";
    expect(code).toContain(before);
    expect(() => assertGovernedWordPressRouting(code.replace(before, ""))).toThrow();
  });

  it("rejects transformed tool arguments on the generic invocation", () => {
    const changed = mutateHandler(code, FORWARD_ANCHOR, "args: input.args,", "args: {},");
    expect(() => assertGovernedWordPressRouting(changed)).toThrow();
  });

  it("rejects a write handler that calls the invoker past the shared governed forward", () => {
    const changed = mutateHandler(
      code,
      HANDLERS_ANCHOR,
      'forwardSiteTool(siteToolCallSchema.parse(request.input), "wordpress_site_tool_write")',
      "getWordPressDeps().invokeSiteTool!(siteToolCallSchema.parse(request.input))",
    );
    expect(() => assertGovernedWordPressRouting(changed)).toThrow();
  });

  it("rejects a write handler that forwards through an ungoverned call", () => {
    const changed = mutateHandler(
      code,
      HANDLERS_ANCHOR,
      'forwardSiteTool(siteToolCallSchema.parse(request.input), "wordpress_site_tool_write")',
      "ungovernedCall(siteToolCallSchema.parse(request.input))",
    );
    expect(() => assertGovernedWordPressRouting(changed)).toThrow();
  });

  it("rejects a write handler that forwards under the read tool's name", () => {
    const changed = mutateHandler(
      code,
      HANDLERS_ANCHOR,
      'forwardSiteTool(siteToolCallSchema.parse(request.input), "wordpress_site_tool_write")',
      'forwardSiteTool(siteToolCallSchema.parse(request.input), "wordpress_site_tool_call")',
    );
    expect(() => assertGovernedWordPressRouting(changed)).toThrow();
  });

  it("rejects a read handler that calls the invoker past the shared governed forward", () => {
    const changed = mutateHandler(
      code,
      HANDLERS_ANCHOR,
      'return forwardSiteTool(input, "wordpress_site_tool_call");',
      "return getWordPressDeps().invokeSiteTool!(input);",
    );
    expect(() => assertGovernedWordPressRouting(changed)).toThrow();
  });

  it("rejects a further handler that reaches the invoker", () => {
    const changed = mutateHandler(
      code,
      HANDLERS_ANCHOR,
      "return {",
      'return {\n    "wordpress_site_tool_extra": async (request: unknown) => getWordPressDeps().invokeSiteTool!(request),',
    );
    expect(() => assertGovernedWordPressRouting(changed)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Drupal — the connector agent-path handler cinatra hosts routes the in-admin
// read through the Drupal MCP module, never a direct /jsonapi call.
// ---------------------------------------------------------------------------
describe("in-admin CMS egress guard — hosted Drupal connector", () => {
  const code = readHostedHandlerCode("@cinatra-ai/drupal-mcp-connector/mcp-handlers");

  it("makes no direct fetch() call on the hosted agent path", () => {
    expect(code).not.toMatch(/\bfetch\s*\(/);
  });

  it("references no direct /jsonapi REST path in code (the MCP tool mcp_jsonapi_* is not a path)", () => {
    // A leading-slash JSON:API path is the deleted direct-REST egress; the MCP
    // read tool `mcp_jsonapi_list_entities` uses `_jsonapi`, not `/jsonapi`.
    expect(code).not.toMatch(/\/jsonapi/);
  });

  it("does not host the deleted JSON:API direct-REST helpers", () => {
    for (const deleted of ["readNodeViaJsonApi", "jsonApiGet", "flattenJsonApiNode", "JsonApiResource"]) {
      expect(code).not.toContain(deleted);
    }
  });

  it("routes the in-admin read through the Drupal MCP module (routing-edge positive control)", () => {
    expect(code).toContain("readNodeViaMcp");
    expect(code).toContain("callDrupalMcp");
    expect(code).toContain("mcp_jsonapi_list_entities");
  });
});

// ---------------------------------------------------------------------------
// Core-owned surfaces — cinatra's own WordPress / Drupal MCP-connection helpers
// only ever target the sanctioned MCP route, never a direct CMS content path.
// These halves are independent of the connector lock and stand on their own.
// ---------------------------------------------------------------------------
describe("in-admin CMS egress guard — core WordPress MCP-connection surface", () => {
  const code = stripComments(
    readFileSync(new URL("../wordpress-mcp-connection.ts", import.meta.url), "utf8"),
  );

  it("references no /wp/v2 REST path in code", () => {
    expect(code).not.toMatch(/\/wp\/v2/);
  });

  it("keeps the sanctioned MCP adapter route as the only WP REST target", () => {
    expect(code).toContain("/mcp/mcp-adapter-default-server");
  });

  it("resolves only MCP-adapter endpoints, never a /wp/v2 content URL", () => {
    const site = "https://example.test";
    const pretty = resolveWordPressMcpEndpoint(site);
    const fallback = resolveWordPressMcpFallbackEndpoint(site);
    expect(pretty).toBe(`${site}/wp-json/mcp/mcp-adapter-default-server`);
    expect(fallback).toBe(`${site}/index.php?rest_route=/mcp/mcp-adapter-default-server`);
    expect(pretty).not.toContain("/wp/v2");
    expect(fallback).not.toContain("/wp/v2");
  });
});

describe("in-admin CMS egress guard — core Drupal MCP-connection surface", () => {
  const code = stripComments(
    readFileSync(new URL("../drupal-mcp-connection.ts", import.meta.url), "utf8"),
  );

  it("references no /jsonapi REST path in code", () => {
    expect(code).not.toMatch(/\/jsonapi/);
  });

  it("keeps the sanctioned Drupal MCP tools route as the CMS target", () => {
    expect(code).toContain("/_mcp_tools");
  });
});
