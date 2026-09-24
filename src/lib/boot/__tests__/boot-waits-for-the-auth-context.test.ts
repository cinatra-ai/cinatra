// The boot waits for the authentication module's context before it starts.
//
// That module reads its boot-time Google OAuth settings lazily, once, while
// Better Auth builds its context — so the context is what carries a read that
// cannot be answered. `startBoot()` is the single place that waits for it, in
// every runtime, before the boot sequence starts: a context that rejects fails
// the boot instead of leaving the process serving one that can only reject.
// A failed read therefore stops the instance exactly as it always did, on the
// development server and in production alike.

import { beforeEach, describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import path from "node:path";

import { resetStartBootForTests, startBoot } from "@/lib/boot/start-boot";

const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");

/** A context that settles only when the case says so. */
function heldContext() {
  let settle: () => void = () => undefined;
  const context = new Promise<void>((resolve) => {
    settle = () => resolve();
  });
  return { context, settle: () => settle() };
}

describe("the boot waits for the auth context before it starts", () => {
  beforeEach(() => {
    resetStartBootForTests();
  });

  for (const NODE_ENV of ["development", "production"]) {
    it(`holds the boot until the auth context is in hand (${NODE_ENV})`, async () => {
      const held = heldContext();
      const started: string[] = [];
      const call = startBoot(
        { NODE_ENV },
        {
          authContext: held.context,
          ensureRouteTree: async () => "resolved",
          boot: async () => {
            started.push("boot");
          },
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(started).toEqual([]);

      held.settle();
      await call;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(started).toEqual(["boot"]);
    });

    it(`fails the boot when the auth context rejects, and never starts it (${NODE_ENV})`, async () => {
      const unreadable = new Error("the boot settings could not be read");
      const started: string[] = [];

      await expect(
        startBoot(
          { NODE_ENV },
          {
            authContext: Promise.reject(unreadable),
            ensureRouteTree: async () => "resolved",
            boot: async () => {
              started.push("boot");
            },
          },
        ),
      ).rejects.toBe(unreadable);

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(started).toEqual([]);
    });
  }

  // The context is handed in rather than imported by the boot module, so the
  // entry point is where the two meet.
  it("is handed the auth context by the framework entry point", () => {
    const entry = readFileSync(path.join(REPO_ROOT, "src", "instrumentation.node.ts"), "utf8");
    expect(entry).toContain("authContext: auth.$context");
  });
});
