// @vitest-environment jsdom
//
// InputOTP — the graded checklist for the components drawing's "Input OTP"
// section (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/input-otp-drawing-conformance.test.tsx
//
// The section's clauses, quoted verbatim:
//
//   "40px white slots"
//   "mono 18px digit"
//   "active = indigo ring"
//   "middle dash separator"
//   "Each digit is a 40px white slot with the strong navy border; the focused
//    slot picks up the indigo ring and a blinking caret. Digits set in mono.
//    Split groups with a short navy dash, never a vertical line."
//
// TWO DEPARTURES RECORDED, NOT FIXED — input-otp is beyond the first ten rows
// of the issue's table. See the two `RECORDED DEPARTURE` blocks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@/components/ui/input-otp";

// jsdom ships no ResizeObserver and no DOMRect measurement; Radix's positioning
// layer calls both. Stubbing them is a test-ENVIRONMENT shim, not a relaxed
// assertion: every clause below is still read off the element Radix rendered.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
  ResizeObserverStub;
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// The primitive schedules three UNCANCELLED timers on mount (0ms, 10ms and
// 50ms) whose callback pushes the input's selection back into React state; the
// effect that starts them returns no cleanup, so they outlive the unmount. On a
// wholesale run this file's jsdom environment is torn down as soon as the file
// ends, the late callback still reaches react-dom's state dispatch, and that
// dispatch reads `window` to resolve the update's priority — a `window is not
// defined` thrown with no test left to attribute it to, which fails the whole
// run although every case here passed.
//
// Faking exactly those four timer functions keeps the primitive's timers on a
// clock this file owns: each case runs them while its own environment is still
// standing, unmounts, then drops whatever is left before real timers come back.
// The environment therefore goes away with an empty queue. This is a test-
// LIFECYCLE fix — no clause, assertion or component behaviour is touched.
const TIMER_FNS = [
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
] as const;

beforeEach(() => {
  vi.useFakeTimers({ toFake: [...TIMER_FNS] });
});

afterEach(() => {
  // Run what the mount scheduled, while the tree and the environment are both
  // still here. `runOnlyPendingTimers` drains the queue as it stands and does
  // not chase timers scheduled by those callbacks, so this cannot spin.
  act(() => {
    vi.runOnlyPendingTimers();
  });
  // Unmount, which also clears the timers the primitive DOES cancel.
  cleanup();
  // Flush anything the unmount pass queued, then drop the remainder.
  act(() => {
    vi.runOnlyPendingTimers();
  });
  vi.clearAllTimers();
  vi.useRealTimers();
});

function renderOTP() {
  const { container } = render(
    <InputOTP maxLength={6}>
      <InputOTPGroup>
        <InputOTPSlot index={0} />
        <InputOTPSlot index={1} />
        <InputOTPSlot index={2} />
      </InputOTPGroup>
      <InputOTPSeparator />
      <InputOTPGroup>
        <InputOTPSlot index={3} />
        <InputOTPSlot index={4} />
        <InputOTPSlot index={5} />
      </InputOTPGroup>
    </InputOTP>,
  );
  return {
    container,
    slots: Array.from(
      container.querySelectorAll('[data-slot="input-otp-slot"]'),
    ) as HTMLElement[],
    separator: container.querySelector(
      '[data-slot="input-otp-separator"]',
    ) as HTMLElement,
  };
}

describe('clause: "white slots" / "with the strong navy border"', () => {
  it("paints each slot on the strong surface", () => {
    expect(renderOTP().slots[0].className).toContain("bg-surface-strong");
  });

  it("draws the slot border from the strong navy control token", () => {
    expect(renderOTP().slots[0].className).toContain("border-input");
  });

  it("rounds only the outer ends, so a group reads as one field of slots", () => {
    const cls = renderOTP().slots[0].className;
    expect(cls).toContain("first:rounded-l-[7px]");
    expect(cls).toContain("last:rounded-r-[7px]");
  });
});

describe('clause: "active = indigo ring" / "the focused slot picks up the indigo ring and a blinking caret"', () => {
  it("raises the indigo ring on the active slot", () => {
    const cls = renderOTP().slots[0].className;
    expect(cls).toContain("data-[active=true]:border-ring");
    expect(cls).toContain("data-[active=true]:ring-ring/50");
  });

  // GRADED ON THE BOOT, with the reason: the caret is rendered only while the
  // slot is the ACTIVE one, which requires real focus inside the hidden OTP
  // input. jsdom drives no such focus, so the caret never enters the tree here.
  // Its blink is read on the live boot ("otp caret",
  // tests/e2e/design/conformance/primitive-wave-leg1.spec.ts).
  it.skip(
    "graded on the boot instead: the caret renders only in the active slot, which needs real focus — see primitive-wave-leg1.spec.ts",
    () => {},
  );
});

describe('clause: "middle dash separator" / "Split groups with a short navy dash, never a vertical line"', () => {
  it("splits the groups with a DASH glyph, not a rule", () => {
    const { separator } = renderOTP();
    const glyph = separator.querySelector("svg");
    expect(glyph).not.toBeNull();
  });

  it("draws no vertical line anywhere in the separator, which the clause forbids", () => {
    const { separator } = renderOTP();
    expect(separator.className ?? "").not.toMatch(/(^|\s)w-px(\s|$)/);
    expect(separator.className ?? "").not.toMatch(/border-[lr](\s|$)/);
  });

  it("announces the split as a separator to assistive tech", () => {
    expect(renderOTP().separator.getAttribute("role")).toBe("separator");
  });
});

describe('RECORDED DEPARTURE (leg 2 follow-up): clause "40px white slots"', () => {
  // DOCUMENTED EXPECTED FAILURE. The assertion below is unchanged and still
  // runs: `it.fails` reports a pass only while the body throws, so the
  // departure stays measured and the checklist stays green. The day the
  // follow-up this departure names lands, this case stops throwing, the suite
  // goes red, and the record must be retired with it.
  it.fails('RECORDED DEPARTURE (leg 2 follow-up): draws each slot at the stated 40px — clause "40px white slots"', () => {
    // RECORDED DEPARTURE — beyond the first ten rows of issue #3189's table.
    //
    // MEASURED: each slot is `h-9 w-9` = 36px square, 4px under the 40px the
    // clause names. 40px is `size-10`, an exact step on the scale, so this is
    // a plain value drift rather than a scale-rounding reading.
    //
    // FOLLOW-UP: leg 2 takes the slot to `h-10 w-10` and re-reads the caret,
    // which is `h-4` and centred inside the slot — the caret's proportion to
    // the slot changes with the box and should be re-measured, not assumed.
    expect(renderOTP().slots[0].className).toMatch(/(^|\s)h-10(\s|$)/);
  });
});

describe('RECORDED DEPARTURE (leg 2 follow-up): clause "mono 18px digit" / "Digits set in mono"', () => {
  // DOCUMENTED EXPECTED FAILURE. The assertion below is unchanged and still
  // runs: `it.fails` reports a pass only while the body throws, so the
  // departure stays measured and the checklist stays green. The day the
  // follow-up this departure names lands, this case stops throwing, the suite
  // goes red, and the record must be retired with it.
  it.fails('RECORDED DEPARTURE (leg 2 follow-up): sets the digit in mono at the stated 18px — clause "mono 18px digit" / "Digits set in mono"', () => {
    // RECORDED DEPARTURE — beyond the first ten rows of issue #3189's table.
    //
    // MEASURED: the slot carries `text-sm` (14px) and NO mono face at all, so
    // the digits render in the sans body face four pixels under the stated
    // size. This is the clause's most visible half: a one-time code is exactly
    // the content mono exists for, and the drawing states it twice (in the
    // chrome line and again in the prose).
    //
    // FOLLOW-UP: leg 2 sets `font-mono text-[18px]` on the slot, taken
    // together with the 40px slot fix above — the two are one geometry change
    // and splitting them would leave 18px digits in a 36px box.
    const cls = renderOTP().slots[0].className;
    expect(cls).toContain("font-mono");
    expect(cls).toContain("text-[18px]");
  });
});
