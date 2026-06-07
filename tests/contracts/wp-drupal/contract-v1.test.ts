import { Validator } from "@cfworker/json-schema";
import { describe, expect, it } from "vitest";

import {
  CURRENT_CONTRACT_VERSION,
  SUPPORTED_CONTRACT_VERSIONS,
  isSupportedContractVersion,
  validateAuthInitRequest,
  validateContractVersion,
} from "@/lib/wp-drupal-contract";

import authInitSchema from "../../../contracts/wp-drupal-assistant/v1/auth-init.schema.json";
import bundleConfigSchema from "../../../contracts/wp-drupal-assistant/v1/bundle-config.schema.json";
import sseEventSchema from "../../../contracts/wp-drupal-assistant/v1/sse-event.schema.json";
import assistantActionSchema from "../../../contracts/wp-drupal-assistant/v1/assistant-action.schema.json";

import authInitWordpress from "../../../contracts/wp-drupal-assistant/v1/fixtures/auth-init.wordpress.json";
import authInitDrupal from "../../../contracts/wp-drupal-assistant/v1/fixtures/auth-init.drupal.json";
import bundleConfigWordpress from "../../../contracts/wp-drupal-assistant/v1/fixtures/bundle-config.wordpress.json";
import bundleConfigDrupal from "../../../contracts/wp-drupal-assistant/v1/fixtures/bundle-config.drupal.json";
import sseEventText from "../../../contracts/wp-drupal-assistant/v1/fixtures/sse-event.text.json";
import sseEventChanges from "../../../contracts/wp-drupal-assistant/v1/fixtures/sse-event.changes.json";
import sseEventError from "../../../contracts/wp-drupal-assistant/v1/fixtures/sse-event.error.json";
import sseEventDone from "../../../contracts/wp-drupal-assistant/v1/fixtures/sse-event.done.json";
import assistantActionStructured from "../../../contracts/wp-drupal-assistant/v1/fixtures/assistant-action.structured.json";
import assistantActionText from "../../../contracts/wp-drupal-assistant/v1/fixtures/assistant-action.text.json";

function makeValidator(schema: unknown): Validator {
  return new Validator(schema as Record<string, unknown>, "2020-12");
}

function assertValid(schema: unknown, instance: unknown, label: string): void {
  const result = makeValidator(schema).validate(instance);
  expect(result.valid, `${label}: ${JSON.stringify(result.errors)}`).toBe(true);
}

describe("wp-drupal contract v1 — golden fixtures conform to schemas", () => {
  it("auth-init fixtures (WordPress + Drupal) validate", () => {
    assertValid(authInitSchema, authInitWordpress, "auth-init.wordpress");
    assertValid(authInitSchema, authInitDrupal, "auth-init.drupal");
  });

  it("bundle-config fixtures (WordPress + Drupal) validate", () => {
    assertValid(bundleConfigSchema, bundleConfigWordpress, "bundle-config.wordpress");
    assertValid(bundleConfigSchema, bundleConfigDrupal, "bundle-config.drupal");
  });

  it("sse-event fixtures (all four frozen event names) validate", () => {
    assertValid(sseEventSchema, sseEventText, "sse-event.text");
    assertValid(sseEventSchema, sseEventChanges, "sse-event.changes");
    assertValid(sseEventSchema, sseEventError, "sse-event.error");
    assertValid(sseEventSchema, sseEventDone, "sse-event.done");
  });

  it("assistant-action fixtures (structured edit + text fallback) validate", () => {
    assertValid(assistantActionSchema, assistantActionStructured, "assistant-action.structured");
    assertValid(assistantActionSchema, assistantActionText, "assistant-action.text");
  });

  it("assistant-action rejects the wire `fields` key (that key belongs to the SSE frame, not the tool result)", () => {
    expect(makeValidator(assistantActionSchema).validate({ fields: [] }).valid).toBe(false);
  });

  it("assistant-action rejects mixing structured + text variants", () => {
    expect(makeValidator(assistantActionSchema).validate({ changes: [], result: "x" }).valid).toBe(false);
  });
});

describe("wp-drupal contract v1 — schemas reject malformed payloads", () => {
  it("auth-init rejects an unknown contractVersion", () => {
    const bad = { ...(authInitWordpress as object), contractVersion: "v2" };
    expect(makeValidator(authInitSchema).validate(bad).valid).toBe(false);
  });

  it("auth-init rejects a missing contractVersion", () => {
    const { contractVersion: _omit, ...rest } = authInitWordpress as Record<string, unknown>;
    expect(makeValidator(authInitSchema).validate(rest).valid).toBe(false);
  });

  it("auth-init rejects an empty messages array", () => {
    const bad = { ...(authInitDrupal as object), messages: [] };
    expect(makeValidator(authInitSchema).validate(bad).valid).toBe(false);
  });

  it("sse-event rejects a data shape that does not match its event name", () => {
    expect(makeValidator(sseEventSchema).validate({ event: "text", data: { message: "x" } }).valid).toBe(false);
    expect(makeValidator(sseEventSchema).validate({ event: "changes", data: { content: "x" } }).valid).toBe(false);
  });

  it("sse-event rejects an unknown event name", () => {
    expect(makeValidator(sseEventSchema).validate({ event: "thinking", data: {} }).valid).toBe(false);
  });

  it("bundle-config rejects a missing apiKey", () => {
    const { apiKey: _omit, ...rest } = bundleConfigWordpress as Record<string, unknown>;
    expect(makeValidator(bundleConfigSchema).validate(rest).valid).toBe(false);
  });
});

describe("wp-drupal contract v1 — runtime validator (src/lib/wp-drupal-contract)", () => {
  it("schema const stays in lock-step with CURRENT_CONTRACT_VERSION", () => {
    expect((authInitSchema as { properties: { contractVersion: { const: string } } }).properties.contractVersion.const).toBe(
      CURRENT_CONTRACT_VERSION,
    );
    expect(SUPPORTED_CONTRACT_VERSIONS).toContain(CURRENT_CONTRACT_VERSION);
  });

  it("isSupportedContractVersion accepts v1, rejects others", () => {
    expect(isSupportedContractVersion("v1")).toBe(true);
    expect(isSupportedContractVersion("v2")).toBe(false);
    expect(isSupportedContractVersion(1)).toBe(false);
    expect(isSupportedContractVersion(undefined)).toBe(false);
  });

  it("validateContractVersion: supported version is ok and not legacy", () => {
    const r = validateContractVersion("v1");
    expect(r.ok).toBe(true);
    expect(r.ok && r.legacy).toBe(false);
  });

  it("validateContractVersion: absent version is ok and legacy", () => {
    const r = validateContractVersion(undefined);
    expect(r.ok).toBe(true);
    expect(r.ok && r.legacy).toBe(true);
  });

  it("validateContractVersion: unknown version is a structured admin-visible error", () => {
    const r = validateContractVersion("v9");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("unsupported_contract_version");
      expect(r.error.supportedVersions).toEqual([...SUPPORTED_CONTRACT_VERSIONS]);
      expect(r.error.received).toBe("v9");
      expect(r.error.message).toContain("v1");
    }
  });

  it("validateAuthInitRequest: golden fixtures round-trip ok", () => {
    expect(validateAuthInitRequest(authInitWordpress).ok).toBe(true);
    expect(validateAuthInitRequest(authInitDrupal).ok).toBe(true);
  });

  it("validateAuthInitRequest: unknown version → unsupported_contract_version", () => {
    const r = validateAuthInitRequest({ ...(authInitWordpress as object), contractVersion: "v2" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("unsupported_contract_version");
  });

  it("validateAuthInitRequest: versioned-but-malformed body → invalid_request_shape", () => {
    const r = validateAuthInitRequest({ contractVersion: "v1", messages: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("invalid_request_shape");
  });

  it("validateAuthInitRequest: unversioned legacy body is not hard-broken", () => {
    const r = validateAuthInitRequest({ messages: [{ role: "user", content: "hi" }] });
    expect(r.ok).toBe(true);
    expect(r.ok && r.legacy).toBe(true);
  });
});
