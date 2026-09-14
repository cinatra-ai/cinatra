// The connectors registry logs a connector's packageId when a host-side read
// fails. A packageId is a user-provided value (it reaches the setup page from
// the route), so it must never sit INSIDE the string console receives as its
// format argument: console.* treats that first string as a printf-style
// template, and a slug carrying %s/%d would consume the arguments that follow
// it (CWE-134). These tests pin the safe shape: a CONSTANT format string, with
// the slug and the error passed as separate positional data.

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  registerConnectorReadinessProbe,
  resolveConnectorBadgeState,
} from "@/lib/connectors-registry.server";

const SLUG_WITH_SPECIFIERS = "@vendor/weird%s%d%j-connector";

describe("connectors-registry logging never builds a tainted format string", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs a percent-bearing packageId as DATA, never as the format string", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerConnectorReadinessProbe(SLUG_WITH_SPECIFIERS, async () => {
      throw new Error("status read blew up");
    });

    const state = await resolveConnectorBadgeState(SLUG_WITH_SPECIFIERS, {
      userId: "u-1",
    });

    expect(state).toEqual({ connected: false });
    expect(warn).toHaveBeenCalledTimes(1);
    const [format, ...args] = warn.mock.calls[0] as [string, ...unknown[]];

    // the format argument is a constant: none of the slug reaches it ...
    expect(typeof format).toBe("string");
    expect(format).not.toContain("vendor");
    expect(format).not.toContain("weird");
    // ... the slug and the error reach console as positional data instead ...
    expect(args).toContain(SLUG_WITH_SPECIFIERS);
    expect(args).toContain("status read blew up");
    // ... the slug is the FIRST positional argument, so it is what the single
    // placeholder consumes ...
    expect(args[0]).toBe(SLUG_WITH_SPECIFIERS);
    // ... and the constant carries exactly one placeholder, never more than it
    // has arguments to feed, so the slug's own specifiers can never eat one,
    // while the error keeps console's native rendering as a trailing argument.
    expect((format.match(/%[sdijoOfc]/g) ?? []).length).toBe(1);
    expect(args.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps every console call in the module out of interpolated-template form", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/connectors-registry.server.ts"),
      "utf8",
    );
    const interpolatedFormatArguments = source.match(
      /console\.\w+\(\s*\x60[^\x60]*\$\{/g,
    );
    expect(interpolatedFormatArguments).toBeNull();
  });
});
