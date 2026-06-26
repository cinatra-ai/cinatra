// Structural regression test for the REGISTRY_POLL dispatcher entry.
//
// We can't drive the BullMQ worker without Redis + a real Worker instance, but
// we CAN assert the registered handler has the right shape:
//   - the REGISTRY_POLL constant still exists (now in background-jobs-names.ts)
//   - a registry entry is keyed by BACKGROUND_JOB_NAMES.REGISTRY_POLL
//   - the handler is dynamically imported from "@/lib/registry-poll-job"
//   - the handler is called as `runRegistryPollJob`
//   - the payload cast matches the published handler signature
//
// These shape gates prevent silent removal or rename of the dispatcher
// integration. The handler table moved from a `switch` in background-jobs.ts to
// the name-keyed registry in background-jobs-registry.ts (cinatra#304), so the
// case-label assertion is now an entry-key assertion against the registry.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const NAMES_SOURCE = readFileSync(
  resolve(__dirname, "../background-jobs-names.ts"),
  "utf8",
);
const REGISTRY_SOURCE = readFileSync(
  resolve(__dirname, "../background-jobs-registry.ts"),
  "utf8",
);

describe("background-jobs — REGISTRY_POLL dispatcher", () => {
  it("preserves the REGISTRY_POLL constant", () => {
    expect(NAMES_SOURCE).toContain('REGISTRY_POLL: "registry-poll"');
  });

  it("registers a registry entry for BACKGROUND_JOB_NAMES.REGISTRY_POLL", () => {
    expect(REGISTRY_SOURCE).toMatch(
      /\[BACKGROUND_JOB_NAMES\.REGISTRY_POLL\]\s*:/,
    );
  });

  it("dynamically imports runRegistryPollJob from @/lib/registry-poll-job", () => {
    // Either single or double quotes are acceptable.
    const importMatch = REGISTRY_SOURCE.match(
      /await import\(["']@\/lib\/registry-poll-job["']\)/,
    );
    expect(importMatch).not.toBeNull();
  });

  it("invokes runRegistryPollJob with the expected payload shape", () => {
    expect(REGISTRY_SOURCE).toContain("runRegistryPollJob");
    // Payload cast must include both required + optional fields.
    expect(REGISTRY_SOURCE).toMatch(
      /runRegistryPollJob\(\s*job\.data as \{[^}]*requestId:\s*string[^}]*scheduledFor\?\s*:\s*number[^}]*\}/,
    );
  });
});
