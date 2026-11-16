import { expect, it } from "vitest";
import { splitBuildOnlyHeadGuard } from "../build-only-heads.mjs";

// red-first gate pilot (cinatra-ai/ci#132), the known bad case: this test
// already passes before the fix, so the gate must fail with NOT-RED-BEFORE.
it("red-first pilot: passes before the fix", () => {
  expect(typeof splitBuildOnlyHeadGuard).toBe("function");
});
