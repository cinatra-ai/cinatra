// @vitest-environment jsdom
/**
 * cinatra#2544 — behavioural pin on `useSetupRedirectGate`, the shell's refusal
 * to redirect off a STALE root-layout snapshot.
 *
 * THE BUG THIS FENCES. `connectionReady` is a server snapshot from the last
 * full document load, and the App Router never re-renders a root layout on
 * client navigation. At the end of onboarding it is therefore a stale `false`:
 * the layout last ran while setup was genuinely incomplete. The old shell
 * trusted it unconditionally, so:
 *
 *   /chat → stale false → replace("/setup") → /setup reads FRESH "complete"
 *         → redirect("/") → /chat → stale false → …forever
 *
 * That is #2544, and it survived #2503 because #2503 only ever addressed a gate
 * that was never determinate (an errored read). This snapshot was correct when
 * taken.
 *
 * The contract has FOUR arms and every one of them has an opposite failure
 * mode, which is why these are real render tests over the real hook and not
 * assertions about source text:
 *
 *   complete    → must NOT redirect (that is the loop) but must still repair
 *                 the snapshot, exactly once (an unguarded refresh is a
 *                 request loop — the trade #2503 already refused).
 *   incomplete  → must STILL redirect. A fix that stops redirecting altogether
 *                 would strand every genuine first-run operator outside the
 *                 wizard.
 *   unavailable → must redirect ONCE and then stop. Never redirecting would
 *                 break first run behind a hiccuping probe; redirecting
 *                 repeatedly is the loop again, wearing a different hat.
 *   pending     → must withhold the shell and redirect NOTHING.
 *
 * The staleness of the confirmation ITSELF is the fifth arm, and it is the one
 * a naive implementation gets wrong: an answer cached from before the wizard
 * ran rebuilds the loop the moment the user finishes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { render, cleanup, waitFor, act } from "@testing-library/react";

import {
  useSetupRedirectGate,
  fetchSetupGateConfirmation,
  SETUP_GATE_STATUS_PATH,
  type SetupGateConfirmation,
} from "@/components/app-shell";

type Verdict = Exclude<SetupGateConfirmation, "pending">;

const replaceToSetup = vi.fn();
const refresh = vi.fn();

function Probe({
  snapshotSaysIncomplete,
  confirm,
}: {
  snapshotSaysIncomplete: boolean;
  confirm: (signal: AbortSignal) => Promise<Verdict>;
}) {
  const { confirmation, withholdShell } = useSetupRedirectGate(
    snapshotSaysIncomplete,
    { replaceToSetup, refresh },
    confirm,
  );
  return (
    <div>
      <span data-testid="confirmation">{confirmation}</span>
      <span data-testid="withhold">{String(withholdShell)}</span>
    </div>
  );
}

/** A confirm transport whose answer this test controls, with a call counter. */
function scriptedConfirm(verdict: Verdict) {
  const calls = { count: 0 };
  const confirm = (): Promise<Verdict> => {
    calls.count += 1;
    return Promise.resolve(verdict);
  };
  return { confirm, calls };
}

beforeEach(() => {
  replaceToSetup.mockReset();
  refresh.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a STALE snapshot (the #2544 loop)", () => {
  it("does not redirect when the server says the gate is complete", async () => {
    const { confirm } = scriptedConfirm("complete");
    const { getByTestId } = render(<Probe snapshotSaysIncomplete confirm={confirm} />);

    await waitFor(() => expect(getByTestId("confirmation").textContent).toBe("complete"));
    // The whole bug in one assertion.
    expect(replaceToSetup).not.toHaveBeenCalled();
  });

  it("repairs the lying snapshot with exactly one refresh", async () => {
    const { confirm } = scriptedConfirm("complete");
    const { getByTestId, rerender } = render(<Probe snapshotSaysIncomplete confirm={confirm} />);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    // Re-render with a NEW callback identity — the realistic shape of a second
    // effect run (a refresh produces a fresh RSC payload). A rerender with
    // identical deps is skipped by React and would pass with the guard deleted.
    for (let i = 0; i < 3; i++) {
      rerender(<Probe snapshotSaysIncomplete confirm={() => confirm()} />);
    }
    await waitFor(() => expect(getByTestId("confirmation").textContent).toBe("complete"));
    // A second refresh here is a request loop traded for a redirect loop.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(replaceToSetup).not.toHaveBeenCalled();
  });

  it("renders the app rather than the interstitial once the gate reads complete", async () => {
    const { confirm } = scriptedConfirm("complete");
    const { getByTestId } = render(<Probe snapshotSaysIncomplete confirm={confirm} />);
    // Withheld while the verdict is in flight...
    expect(getByTestId("withhold").textContent).toBe("true");
    // ...and released the moment it lands, without waiting on the refresh —
    // otherwise "Redirecting to setup…" sits on screen for someone who is not
    // going anywhere.
    await waitFor(() => expect(getByTestId("withhold").textContent).toBe("false"));
  });
});

describe("a TRUTHFUL snapshot (first run must still reach the wizard)", () => {
  it("redirects when the server confirms steps genuinely remain", async () => {
    const { confirm } = scriptedConfirm("incomplete");
    render(<Probe snapshotSaysIncomplete confirm={confirm} />);
    await waitFor(() => expect(replaceToSetup).toHaveBeenCalledTimes(1));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("keeps the shell withheld while it redirects", async () => {
    const { confirm } = scriptedConfirm("incomplete");
    const { getByTestId } = render(<Probe snapshotSaysIncomplete confirm={confirm} />);
    await waitFor(() => expect(replaceToSetup).toHaveBeenCalled());
    expect(getByTestId("withhold").textContent).toBe("true");
  });
});

describe("an UNCONFIRMABLE gate", () => {
  it("redirects once so a first run behind a hiccup still reaches the wizard", async () => {
    const { confirm } = scriptedConfirm("unavailable");
    render(<Probe snapshotSaysIncomplete confirm={confirm} />);
    await waitFor(() => expect(replaceToSetup).toHaveBeenCalledTimes(1));
  });

  it("never redirects a SECOND time — a loop needs at least two bounces", async () => {
    const { confirm } = scriptedConfirm("unavailable");
    const { rerender, getByTestId } = render(
      <Probe snapshotSaysIncomplete confirm={confirm} />,
    );
    await waitFor(() => expect(replaceToSetup).toHaveBeenCalledTimes(1));

    // Simulate the bounce back: /setup (predicate false, answer dropped) → an
    // app route again (predicate true, re-asked, still unconfirmable). This is
    // precisely the cycle the old code repeated forever.
    for (let i = 0; i < 3; i++) {
      rerender(<Probe snapshotSaysIncomplete={false} confirm={confirm} />);
      await waitFor(() => expect(getByTestId("confirmation").textContent).toBe("pending"));
      rerender(<Probe snapshotSaysIncomplete confirm={confirm} />);
      await waitFor(() => expect(getByTestId("confirmation").textContent).toBe("unavailable"));
    }
    expect(replaceToSetup).toHaveBeenCalledTimes(1);
  });

  it("falls open (renders the app) once its single redirect is spent", async () => {
    const { confirm } = scriptedConfirm("unavailable");
    const { getByTestId } = render(<Probe snapshotSaysIncomplete confirm={confirm} />);
    await waitFor(() => expect(getByTestId("confirmation").textContent).toBe("unavailable"));
    expect(getByTestId("withhold").textContent).toBe("false");
  });
});

describe("the confirmation must not itself go stale", () => {
  it("re-asks after a trip through the wizard, so a finished setup never bounces", async () => {
    // The exact #2544 sequence, and the arm a cached answer would fail:
    //   app route (incomplete → /setup) → operator completes setup →
    //   soft nav back to an app route with the SAME stale snapshot.
    let verdict: Verdict = "incomplete";
    const confirm = (): Promise<Verdict> => Promise.resolve(verdict);
    const { rerender, getByTestId } = render(
      <Probe snapshotSaysIncomplete confirm={confirm} />,
    );
    await waitFor(() => expect(replaceToSetup).toHaveBeenCalledTimes(1));

    // On /setup the predicate is false — the answer is dropped.
    rerender(<Probe snapshotSaysIncomplete={false} confirm={confirm} />);
    await waitFor(() => expect(getByTestId("confirmation").textContent).toBe("pending"));

    // The operator finishes; the SERVER gate flips. The layout snapshot does
    // NOT — that is the defect — so the predicate is true again.
    verdict = "complete";
    rerender(<Probe snapshotSaysIncomplete confirm={confirm} />);
    await waitFor(() => expect(getByTestId("confirmation").textContent).toBe("complete"));

    // Still exactly the one redirect from before setup was done. A cached
    // "incomplete" here is the loop, rebuilt.
    expect(replaceToSetup).toHaveBeenCalledTimes(1);
    // The repair rides a passive EFFECT of the very commit that painted
    // "complete", and React runs those AFTER the DOM mutation the waitFor
    // above watches for. Reading the mock the instant the text settles is
    // therefore a bet on flush ordering that a loaded runner loses; the
    // refresh is awaited on its own terms instead, exactly as the sibling arm
    // further up already does.
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    // ...and it is still one once the queue is fully drained. This is a
    // settling check on THIS arm only — the once-only guard itself is fenced
    // by the sibling arm above, which re-renders the hook.
    await act(async () => {});
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("no probe at all when the shell has nothing to decide", () => {
  it("asks nothing and does nothing on a ready snapshot or a setup route", async () => {
    const { confirm, calls } = scriptedConfirm("incomplete");
    const { getByTestId } = render(<Probe snapshotSaysIncomplete={false} confirm={confirm} />);
    await act(async () => {});
    // The cost argument for this design: an ordinary navigation on a healthy,
    // set-up instance makes ZERO extra requests.
    expect(calls.count).toBe(0);
    expect(replaceToSetup).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(getByTestId("withhold").textContent).toBe("false");
  });

  it("asks exactly once per episode, not once per render", async () => {
    const { confirm, calls } = scriptedConfirm("complete");
    const { rerender, getByTestId } = render(
      <Probe snapshotSaysIncomplete confirm={confirm} />,
    );
    await waitFor(() => expect(getByTestId("confirmation").textContent).toBe("complete"));
    for (let i = 0; i < 3; i++) {
      rerender(<Probe snapshotSaysIncomplete confirm={() => confirm()} />);
    }
    await act(async () => {});
    expect(calls.count).toBe(1);
  });

  it("STILL resolves under StrictMode's simulated remount", async () => {
    // The #2503 trap, restated for this hook: a ref claimed when the request is
    // STARTED is spent by the first pass, whose fetch is then aborted — so the
    // second pass would bail and the verdict would never arrive, leaving the
    // user on the interstitial forever.
    const { confirm } = scriptedConfirm("complete");
    const { getByTestId } = render(
      <StrictMode>
        <Probe snapshotSaysIncomplete confirm={confirm} />
      </StrictMode>,
    );
    await waitFor(() => expect(getByTestId("confirmation").textContent).toBe("complete"));
    expect(replaceToSetup).not.toHaveBeenCalled();
  });
});

describe("fetchSetupGateConfirmation — the default transport", () => {
  function mockFetch(
    impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | Response,
  ) {
    const spy = vi.fn(impl);
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  function jsonResponse(body: unknown, ok = true): Response {
    return {
      ok,
      json: async () => body,
    } as unknown as Response;
  }

  it("reads the tri-state field, not the boolean", async () => {
    mockFetch(() => jsonResponse({ authenticated: true, setupComplete: true, setupGate: "complete" }));
    await expect(fetchSetupGateConfirmation(new AbortController().signal)).resolves.toBe(
      "complete",
    );
  });

  it("reports a determinate incomplete as incomplete", async () => {
    mockFetch(() =>
      jsonResponse({ authenticated: true, setupComplete: false, setupGate: "incomplete" }),
    );
    await expect(fetchSetupGateConfirmation(new AbortController().signal)).resolves.toBe(
      "incomplete",
    );
  });

  it("NEVER reads the server's own indeterminate as incomplete", async () => {
    // The #2503 conflation, restated at the client boundary: "could not find
    // out" is not "not set up", and turning it into one is the loop.
    mockFetch(() =>
      jsonResponse({ authenticated: true, setupComplete: false, setupGate: "indeterminate" }),
    );
    await expect(fetchSetupGateConfirmation(new AbortController().signal)).resolves.toBe(
      "unavailable",
    );
  });

  it("treats a missing setupGate (an older server) as unavailable, not incomplete", async () => {
    mockFetch(() => jsonResponse({ authenticated: true, setupComplete: false }));
    await expect(fetchSetupGateConfirmation(new AbortController().signal)).resolves.toBe(
      "unavailable",
    );
  });

  it("treats a non-2xx as unavailable", async () => {
    mockFetch(() => jsonResponse({}, false));
    await expect(fetchSetupGateConfirmation(new AbortController().signal)).resolves.toBe(
      "unavailable",
    );
  });

  it("treats a transport failure as unavailable rather than throwing into the effect", async () => {
    mockFetch(() => Promise.reject(new Error("network down")));
    await expect(fetchSetupGateConfirmation(new AbortController().signal)).resolves.toBe(
      "unavailable",
    );
  });

  it("hits the documented path with no-store and same-origin credentials", async () => {
    const spy = mockFetch(() => jsonResponse({ setupGate: "complete" }));
    await fetchSetupGateConfirmation(new AbortController().signal);
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(SETUP_GATE_STATUS_PATH);
    expect(init).toBeDefined();
    if (!init) throw new Error("unreachable");
    // A cached verdict is a stale verdict — the exact class of bug being fixed.
    expect(init.cache).toBe("no-store");
    // The gate is only disclosed to a session, so the cookie must ride along.
    expect(init.credentials).toBe("same-origin");
  });
});
