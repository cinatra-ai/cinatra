// cinatra#1062 — the run-start actions turn an actionable enqueue preflight
// failure (connector OR LLM provider) into a deep-linkable result instead of a
// generic "enqueue failed". This locks the duck-typed mapping.
import { describe, it, expect } from "vitest";
import {
  asActionablePreflightError,
  ACTIONABLE_RUN_PREFLIGHT_CODES,
} from "../actionable-preflight-error";

describe("asActionablePreflightError (cinatra#1056/#1062)", () => {
  it("maps an LLM-provider preflight failure (with settingsHref)", () => {
    expect(
      asActionablePreflightError({
        name: "LlmProviderNotConfiguredError",
        code: "LLM_PROVIDER_NOT_CONFIGURED",
        message: "no configured LLM provider supports media_input",
        settingsHref: "/configuration/llm",
      }),
    ).toEqual({
      error: "no configured LLM provider supports media_input",
      code: "LLM_PROVIDER_NOT_CONFIGURED",
      settingsHref: "/configuration/llm",
    });
  });

  it("maps a connector preflight failure (sibling code)", () => {
    expect(
      asActionablePreflightError({
        code: "CONNECTOR_NOT_CONFIGURED",
        message: "Agent run blocked: @cinatra-ai/x not configured",
        settingsHref: "/connectors/cinatra-ai/x/setup",
      }),
    ).toMatchObject({
      code: "CONNECTOR_NOT_CONFIGURED",
      settingsHref: "/connectors/cinatra-ai/x/setup",
    });
  });

  it("returns null for a generic error (no code) so the caller keeps its fallback", () => {
    expect(asActionablePreflightError(new Error("enqueue failed"))).toBeNull();
  });

  it("returns null for an unrecognized code", () => {
    expect(asActionablePreflightError({ code: "SOME_OTHER_ERROR", message: "x" })).toBeNull();
  });

  it("falls back to a generic message when the error carries no message", () => {
    expect(asActionablePreflightError({ code: "LLM_PROVIDER_NOT_CONFIGURED" })).toEqual({
      error: "Agent run blocked",
      code: "LLM_PROVIDER_NOT_CONFIGURED",
      settingsHref: undefined,
    });
  });

  it("returns null for non-object throwables", () => {
    expect(asActionablePreflightError("boom")).toBeNull();
    expect(asActionablePreflightError(undefined)).toBeNull();
    expect(asActionablePreflightError(null)).toBeNull();
  });

  it("keeps both preflight codes in the actionable set", () => {
    expect([...ACTIONABLE_RUN_PREFLIGHT_CODES]).toEqual([
      "CONNECTOR_NOT_CONFIGURED",
      "LLM_PROVIDER_NOT_CONFIGURED",
    ]);
  });
});


describe("connector identity at the preflight boundary (cinatra#4041)", () => {
  it("retains the actual canonical package only with its exact setup address", () => {
    expect(asActionablePreflightError({ code: "CONNECTOR_NOT_CONFIGURED", message: "Blocked", packageId: "@cinatra-ai/apollo-connector", settingsHref: "/connectors/cinatra-ai/apollo-connector/setup" })).toMatchObject({ packageId: "@cinatra-ai/apollo-connector" });
  });
  it.each([
    ["@cinatra-ai/../apollo", "/connectors/cinatra-ai/../apollo/setup"],
    ["@cinatra-ai/apollo-connector", "https://untrusted.example/setup"],
    ["@cinatra-ai/apollo-connector", "/connectors/other/apollo-connector/setup"],
    ["apollo-connector", "/connectors/cinatra-ai/apollo-connector/setup"],
  ])("does not promote unsafe or mismatched identity %s", (packageId, settingsHref) => {
    expect(asActionablePreflightError({ code: "CONNECTOR_NOT_CONFIGURED", packageId, settingsHref })).not.toHaveProperty("packageId");
  });
  it("does not turn an LLM refusal into a connector identity", () => {
    expect(asActionablePreflightError({ code: "LLM_PROVIDER_NOT_CONFIGURED", packageId: "@cinatra-ai/apollo-connector", settingsHref: "/connectors/cinatra-ai/apollo-connector/setup" })).not.toHaveProperty("packageId");
  });
});
