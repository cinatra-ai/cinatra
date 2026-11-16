import { expect, it } from "vitest";
import * as mod from "../build-only-heads.mjs";

// red-first gate pilot (cinatra-ai/ci#132): fails before the fix, passes with it.
it("red-first pilot: the fix adds the constant", () => {
  expect(mod.RED_FIRST_PILOT).toBe(42);
});
