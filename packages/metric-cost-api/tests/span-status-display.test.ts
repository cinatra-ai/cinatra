import { describe, it, expect } from "vitest";
import { spanStatusDisplay } from "../src/span-status-display";

describe("spanStatusDisplay (#414)", () => {
  it("renders ok as a default badge", () => {
    expect(spanStatusDisplay("ok")).toEqual({
      kind: "badge",
      label: "ok",
      variant: "default",
    });
  });

  it("renders error as a destructive badge", () => {
    expect(spanStatusDisplay("error")).toEqual({
      kind: "badge",
      label: "error",
      variant: "destructive",
    });
  });

  it("renders unset as a muted em-dash with an explanatory tooltip", () => {
    const d = spanStatusDisplay("unset");
    expect(d.kind).toBe("muted");
    expect(d.label).toBe("—");
    if (d.kind === "muted") {
      expect(d.title).toMatch(/UNSET/);
      expect(d.title).toMatch(/#492/);
    }
  });

  it("treats any unknown status like unset (muted), never a raw label", () => {
    const d = spanStatusDisplay("weird");
    expect(d.kind).toBe("muted");
    expect(d.label).toBe("—");
  });
});
