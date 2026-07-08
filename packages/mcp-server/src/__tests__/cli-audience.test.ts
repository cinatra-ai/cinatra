import { describe, expect, it } from "vitest";

import {
  CLI_OAUTH_SCOPES,
  CLI_RESOURCE_BASE_PATH,
  cliAudienceClaimIsAcceptable,
  cliAudienceForOrigin,
  cliValidAudiences,
  combineOriginAndPath,
  isCliOAuthScope,
  mcpAudienceForOrigin,
} from "../cli-audience";

const ORIGINS = ["http://localhost:3000", "https://app.example.com"];

describe("cli-audience constants", () => {
  it("exposes the three dedicated CLI scopes, none of which are mcp:connect", () => {
    expect([...CLI_OAUTH_SCOPES]).toEqual([
      "cli:status",
      "cli:agent:read",
      "cli:agent:write",
    ]);
    expect(CLI_OAUTH_SCOPES).not.toContain("mcp:connect");
  });

  it("recognizes only CLI scopes", () => {
    expect(isCliOAuthScope("cli:agent:write")).toBe(true);
    expect(isCliOAuthScope("mcp:connect")).toBe(false);
    expect(isCliOAuthScope("openid")).toBe(false);
  });
});

describe("audience builders", () => {
  it("builds <origin>/api/cli", () => {
    expect(cliAudienceForOrigin("https://app.example.com")).toBe(
      "https://app.example.com/api/cli",
    );
    expect(CLI_RESOURCE_BASE_PATH).toBe("/api/cli");
  });

  it("mirrors combineOriginAndPath exactly (bare / collapses to origin)", () => {
    expect(combineOriginAndPath("https://h", "/")).toBe("https://h");
    expect(combineOriginAndPath("https://h", "/api/cli")).toBe(
      "https://h/api/cli",
    );
  });

  it("maps every trusted origin to its /api/cli audience", () => {
    expect(cliValidAudiences(ORIGINS)).toEqual([
      "http://localhost:3000/api/cli",
      "https://app.example.com/api/cli",
    ]);
  });
});

describe("cliAudienceClaimIsAcceptable — the audience-confusion guard", () => {
  it("accepts a single CLI audience", () => {
    expect(
      cliAudienceClaimIsAcceptable("https://app.example.com/api/cli", ORIGINS),
    ).toBe(true);
  });

  it("accepts a CLI audience alongside a non-resource audience (e.g. userinfo)", () => {
    expect(
      cliAudienceClaimIsAcceptable(
        ["https://app.example.com/api/cli", "https://app.example.com/api/auth/oauth2/userinfo"],
        ORIGINS,
      ),
    ).toBe(true);
  });

  it("REJECTS a token that carries the /api/mcp audience too (cross-surface)", () => {
    expect(
      cliAudienceClaimIsAcceptable(
        ["https://app.example.com/api/cli", mcpAudienceForOrigin("https://app.example.com")],
        ORIGINS,
      ),
    ).toBe(false);
  });

  it("REJECTS an MCP-only token", () => {
    expect(
      cliAudienceClaimIsAcceptable(
        mcpAudienceForOrigin("https://app.example.com"),
        ORIGINS,
      ),
    ).toBe(false);
  });

  it("REJECTS a token with no CLI audience", () => {
    expect(
      cliAudienceClaimIsAcceptable("https://other.example.com/api/cli", ORIGINS),
    ).toBe(false);
    expect(cliAudienceClaimIsAcceptable(undefined, ORIGINS)).toBe(false);
    expect(cliAudienceClaimIsAcceptable([], ORIGINS)).toBe(false);
  });
});
