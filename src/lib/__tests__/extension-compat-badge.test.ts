/**
 * deriveExtensionCompatState — the 3-state ABI compatibility verdict for the
 * marketplace UI badge. The host's frozen SDK-extensions ABI is 2.2.0 (major 2)
 * in this repo, so a supported single-comparator `^2`/`>=2`/`2.x` declaration is
 * satisfied, a `^1`/`^3` declaration is not, and an undeclared range is the
 * neutral "unknown". (The SDK checker fails closed on compound/multi-comparator
 * ranges, so the badge never reads green for one — see the MALFORMED case.)
 */
import { describe, expect, it } from "vitest";

import {
  deriveExtensionCompatState,
  HOST_SDK_ABI_VERSION,
} from "../extension-compat-badge";

describe("deriveExtensionCompatState", () => {
  it("host ABI is the frozen SDK-extensions major 2", () => {
    // Guards the test assumptions below against an ABI bump.
    expect(HOST_SDK_ABI_VERSION.startsWith("2.")).toBe(true);
  });

  it("declared + satisfied → compatible (supported single-comparator ranges)", () => {
    expect(deriveExtensionCompatState("^2")).toBe("compatible");
    expect(deriveExtensionCompatState(">=2")).toBe("compatible");
    expect(deriveExtensionCompatState("2.x")).toBe("compatible");
  });

  it("declared + unsatisfied → incompatible (never green)", () => {
    expect(deriveExtensionCompatState("^1")).toBe("incompatible");
    expect(deriveExtensionCompatState("^3")).toBe("incompatible");
    // Exact pin to an older ABI the host has moved past.
    expect(deriveExtensionCompatState("2.0.0")).toBe("incompatible");
  });

  it("declared + MALFORMED → incompatible (fail closed, never green, never unknown)", () => {
    // The install gate fails closed on a malformed range; the badge must too —
    // a garbage declaration is a real (refused) claim, NOT 'no claim'.
    expect(deriveExtensionCompatState("not-a-range")).toBe("incompatible");
    expect(deriveExtensionCompatState("^^2")).toBe("incompatible");
    expect(deriveExtensionCompatState(">>2")).toBe("incompatible");
    // The SDK checker only supports a SINGLE comparator; a compound/range-set
    // declaration is unsupported and fails closed — never green — even when it
    // would notionally include the host ABI. The badge inherits that exactly.
    expect(deriveExtensionCompatState(">=2.0.0 <3.0.0")).toBe("incompatible");
    expect(deriveExtensionCompatState("^1 || ^2")).toBe("incompatible");
  });

  it("ABSENT (null/undefined/blank) → unknown (neutral, NEVER compatible)", () => {
    expect(deriveExtensionCompatState(null)).toBe("unknown");
    expect(deriveExtensionCompatState(undefined)).toBe("unknown");
    expect(deriveExtensionCompatState("")).toBe("unknown");
    expect(deriveExtensionCompatState("   ")).toBe("unknown");
    // Critically: undeclared must NOT inherit the install gate's lenient
    // compatible:true for an unpinned range.
    expect(deriveExtensionCompatState(null)).not.toBe("compatible");
  });

  it("an EXPLICIT wildcard '*' is a (lenient) declaration → compatible, distinct from undeclared", () => {
    expect(deriveExtensionCompatState("*")).toBe("compatible");
    // Whereas the absence of any declaration is "unknown".
    expect(deriveExtensionCompatState(null)).toBe("unknown");
  });
});
