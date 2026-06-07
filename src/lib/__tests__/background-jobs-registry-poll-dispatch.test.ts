// Structural regression test for the REGISTRY_POLL dispatcher case in
// `src/lib/background-jobs.ts`.
//
// We can't drive the BullMQ worker switch without Redis + a real Worker
// instance, but we CAN assert the dispatcher case has the right shape:
//   - the case label exists
//   - the handler is dynamically imported from "@/lib/registry-poll-job"
//   - the handler is called as `runRegistryPollJob`
//   - the payload cast matches the published handler signature
//   - the existing REGISTRY_POLL constant is still in place
//
// These shape gates prevent silent removal or rename of the dispatcher
// integration.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SOURCE = readFileSync(
  resolve(__dirname, "../background-jobs.ts"),
  "utf8",
);

describe("background-jobs.ts — REGISTRY_POLL dispatcher", () => {
  it("preserves the REGISTRY_POLL constant", () => {
    expect(SOURCE).toContain('REGISTRY_POLL: "registry-poll"');
  });

  it("registers a dispatcher case for BACKGROUND_JOB_NAMES.REGISTRY_POLL", () => {
    expect(SOURCE).toMatch(/case BACKGROUND_JOB_NAMES\.REGISTRY_POLL\s*:/);
  });

  it("dynamically imports runRegistryPollJob from @/lib/registry-poll-job", () => {
    // Either single or double quotes are acceptable.
    const importMatch = SOURCE.match(
      /await import\(["']@\/lib\/registry-poll-job["']\)/,
    );
    expect(importMatch).not.toBeNull();
  });

  it("invokes runRegistryPollJob with the expected payload shape", () => {
    expect(SOURCE).toContain("runRegistryPollJob");
    // Payload cast must include both required + optional fields.
    expect(SOURCE).toMatch(
      /runRegistryPollJob\(\s*job\.data as \{[^}]*requestId:\s*string[^}]*scheduledFor\?\s*:\s*number[^}]*\}/,
    );
  });
});
