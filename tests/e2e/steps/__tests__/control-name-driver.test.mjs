// Transport failures must refuse the reading; they cannot revive a guessed
// DOM name. These tests exercise the public step's error and cleanup boundary.
import { describe, expect, it } from "vitest";

import { readControlNames } from "../read-control-names.mjs";

describe("control-name platform driver", () => {
  it("explicitly refuses an unsupported browser before any reading", async () => {
    const lines = [];
    let read = false;
    const page = {
      url: () => "about:blank",
      context: () => ({
        browser: () => ({ browserType: () => ({ name: () => "firefox" }) }),
        newCDPSession: () => { read = true; throw new Error("should not read"); },
      }),
    };
    await expect(readControlNames(page, { record: (line) => lines.push(line) })).rejects.toMatchObject({ kind: "driver-failure" });
    expect(read).toBe(false);
    expect(lines).toEqual(["readControlNames refused (driver-failure): the controls on about: could not be read (UnsupportedBrowserError)"]);
  });

  it("detaches and refuses when the platform tree fails, even if handle release also fails", async () => {
    const calls = [];
    const session = {
      send: async (command) => {
        calls.push(command);
        if (command === "DOM.getDocument") return { root: { backendNodeId: 1 } };
        if (command === "DOM.resolveNode") return { object: { objectId: "document" } };
        throw new Error("driver detail that must not enter the step record");
      },
      detach: async () => { calls.push("detach"); },
    };
    const lines = [];
    const page = { url: () => "about:blank", context: () => ({ browser: () => null, newCDPSession: async () => session }) };
    await expect(readControlNames(page, { record: (line) => lines.push(line) })).rejects.toMatchObject({ kind: "driver-failure" });
    expect(calls).toEqual(["DOM.getDocument", "DOM.resolveNode", "Accessibility.getFullAXTree", "Runtime.releaseObjectGroup", "detach"]);
    expect(lines).toEqual(["readControlNames refused (driver-failure): the controls on about: could not be read (Error)"]);
  });
});
