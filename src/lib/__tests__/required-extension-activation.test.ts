import { describe, it, expect } from "vitest";
import type { ActivationResult } from "@cinatra-ai/sdk-extensions";
import { findRequiredActivationFailures } from "@/lib/required-extension-activation";

const SERVER_ENTRY = new Set([
  "@cinatra-ai/email-connector",
  "@cinatra-ai/gmail-connector",
  "@cinatra-ai/resend-connector",
]);

const REQUIRED = [
  "@cinatra-ai/email-connector",
  "@cinatra-ai/gmail-connector",
  "@cinatra-ai/resend-connector",
  // Required but declares NO serverEntry — never asserted.
  "@cinatra-ai/connectors-shell",
];

function ok(packageName: string): ActivationResult {
  return { packageName, status: "registered" } as ActivationResult;
}

describe("findRequiredActivationFailures", () => {
  it("passes when every required serverEntry package activated", () => {
    const results = [...SERVER_ENTRY].map(ok);
    expect(findRequiredActivationFailures(results, REQUIRED, SERVER_ENTRY)).toEqual([]);
  });

  it("treats `bootstrapped` as activated", () => {
    const results: ActivationResult[] = [
      ok("@cinatra-ai/email-connector"),
      ok("@cinatra-ai/resend-connector"),
      { packageName: "@cinatra-ai/gmail-connector", status: "bootstrapped" } as ActivationResult,
    ];
    expect(findRequiredActivationFailures(results, REQUIRED, SERVER_ENTRY)).toEqual([]);
  });

  it("flags a required serverEntry package with NO activation result as missing", () => {
    const results = [ok("@cinatra-ai/email-connector"), ok("@cinatra-ai/resend-connector")];
    expect(findRequiredActivationFailures(results, REQUIRED, SERVER_ENTRY)).toEqual([
      { packageName: "@cinatra-ai/gmail-connector", status: "missing" },
    ]);
  });

  it("flags a failed/skipped activation with its status + reason", () => {
    const results: ActivationResult[] = [
      ok("@cinatra-ai/email-connector"),
      ok("@cinatra-ai/resend-connector"),
      {
        packageName: "@cinatra-ai/gmail-connector",
        status: "failed",
        reason: "register-threw",
      } as ActivationResult,
    ];
    expect(findRequiredActivationFailures(results, REQUIRED, SERVER_ENTRY)).toEqual([
      { packageName: "@cinatra-ai/gmail-connector", status: "failed", reason: "register-threw" },
    ]);
  });

  it("a later ok result for the same package clears an earlier failure (dual loaders)", () => {
    const results: ActivationResult[] = [
      ok("@cinatra-ai/email-connector"),
      ok("@cinatra-ai/resend-connector"),
      {
        packageName: "@cinatra-ai/gmail-connector",
        status: "failed",
        reason: "register-threw",
      } as ActivationResult,
      ok("@cinatra-ai/gmail-connector"),
    ];
    expect(findRequiredActivationFailures(results, REQUIRED, SERVER_ENTRY)).toEqual([]);
  });

  it("ignores non-required packages entirely", () => {
    const results: ActivationResult[] = [
      ...[...SERVER_ENTRY].map(ok),
      {
        packageName: "@vendor/optional-connector",
        status: "failed",
        reason: "register-threw",
      } as ActivationResult,
    ];
    expect(findRequiredActivationFailures(results, REQUIRED, SERVER_ENTRY)).toEqual([]);
  });
});
