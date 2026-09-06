/**
 * cinatra#3035 / #2960 — the proof round's own switch for the framework's
 * development indicator.
 *
 * Every dev boot paints the framework's development indicator over the page.
 * A graded proof frame may not carry it, and may not be cropped or DOM-edited
 * to take it off, so a round has to turn it off through the framework's OWN
 * means. Next's only supported switch is `devIndicators: false` in
 * next.config.ts, so the config reads one environment variable —
 * `CINATRA_DEV_INDICATOR=off` — and hands the framework `false` for that boot.
 *
 * Every ordinary dev boot leaves the variable unset and keeps the indicator
 * exactly where it was; an unrecognised value keeps it too (the switch fails
 * closed towards SHOWING the indicator, so a typo can never silently hide a
 * dev boot's own warning surface).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

type LoadedConfig = { devIndicators?: unknown };

const PRIOR = process.env.CINATRA_DEV_INDICATOR;

async function loadNextConfig(value: string | undefined): Promise<LoadedConfig> {
  vi.resetModules();
  if (value === undefined) delete process.env.CINATRA_DEV_INDICATOR;
  else process.env.CINATRA_DEV_INDICATOR = value;
  const mod = await import("../../next.config");
  return mod.default as LoadedConfig;
}

afterEach(() => {
  if (PRIOR === undefined) delete process.env.CINATRA_DEV_INDICATOR;
  else process.env.CINATRA_DEV_INDICATOR = PRIOR;
});

describe("the development indicator's own switch", () => {
  it("keeps the indicator on an ordinary dev boot (the variable unset)", async () => {
    const config = await loadNextConfig(undefined);
    expect(config.devIndicators).toEqual({ position: "bottom-right" });
  });

  it("hands the framework `false` when a proof round asks for it", async () => {
    const config = await loadNextConfig("off");
    expect(config.devIndicators).toBe(false);
  });

  it("keeps the indicator for any other value (fails closed to showing it)", async () => {
    for (const value of ["on", "", "false", "OFF"]) {
      const config = await loadNextConfig(value);
      expect(config.devIndicators, `value ${JSON.stringify(value)}`).toEqual({
        position: "bottom-right",
      });
    }
  });
});
