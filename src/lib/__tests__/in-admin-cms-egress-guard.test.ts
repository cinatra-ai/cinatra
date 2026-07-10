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
//       handler->MCP-helper->MCP-client edges (readPostViaMcp / updatePostViaMcp
//       / readNodeViaMcp), not merely file-wide symbol presence.
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

  it("routes the in-admin read/update through the MCP content tools (routing-edge positive control)", () => {
    // The specific handler->MCP-helper->MCP-client edges — not just file-wide
    // symbol presence.
    expect(code).toContain("readPostViaMcp");
    expect(code).toContain("updatePostViaMcp");
    expect(code).toContain("callWordPressMcp");
    expect(code).toContain("CINATRA_POST_GET_TOOL");
    expect(code).toContain("CINATRA_POST_UPDATE_TOOL");
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
