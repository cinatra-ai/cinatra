import { describe, it, expect } from "vitest";
import {
  decideActivationRoute,
  type ActivationRoute,
} from "@/lib/extension-activation-routing";

describe("decideActivationRoute", () => {
  it("routes a trusted record in-process (regardless of untrusted mode)", () => {
    expect(decideActivationRoute({ trusted: true, untrustedMode: "deny" })).toBe("in-process");
    expect(decideActivationRoute({ trusted: true, untrustedMode: "subprocess-prototype" })).toBe(
      "in-process",
    );
  });

  it("routes an untrusted record to the subprocess prototype when opted in", () => {
    expect(
      decideActivationRoute({ trusted: false, untrustedMode: "subprocess-prototype" }),
    ).toBe("subprocess-prototype");
  });

  it("denies an untrusted record when the mode is deny (fail-closed default)", () => {
    expect(decideActivationRoute({ trusted: false, untrustedMode: "deny" })).toBe("deny");
  });

  it("is total — every (trusted, mode) combination yields exactly one of the three routes", () => {
    const routes = new Set<ActivationRoute>(["in-process", "subprocess-prototype", "deny"]);
    for (const trusted of [true, false]) {
      for (const untrustedMode of ["deny", "subprocess-prototype"] as const) {
        const route = decideActivationRoute({ trusted, untrustedMode });
        expect(routes.has(route)).toBe(true);
      }
    }
  });
});
