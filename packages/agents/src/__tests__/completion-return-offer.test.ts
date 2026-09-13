/**
 * WHAT A FINISHED RUN HANDS BACK TO THE STEP THAT SENT IT (cinatra#3358).
 *
 * THE ACCEPTANCE ITEM, verbatim:
 *
 *   "when a child run completes with a listId, the parked run's account-scope
 *    step offers that list — pinned with a fake completion carrying a listId;
 *    the package's own half is list-curator-agent#55."
 *
 * THE HOST'S HALF IS THE ONE PINNED HERE. Whether a list is ever PRODUCED is the
 * List Curator package's own business (it is not, at the version pinned today —
 * list-curator-agent#55), and nothing in this repository patches that. What the
 * host owes is the road: a completion that names a list is read, and the id it
 * names rides the return address onto the parked run, where the parked step
 * offers it. Both ends are read here off a FAKE completion, so the rule is
 * proved without the package.
 *
 * GENERIC, and asserted so: the rule keys on the STEP FAMILY the completion
 * contract names — never on a package — and a family it does not know reads
 * nothing.
 *
 *   pnpm vitest run packages/agents/src/__tests__/completion-return-offer.test.ts
 */
import { describe, expect, it } from "vitest";

import {
  producedIdForOfferingStep,
  producedIdFromRunCompletion,
} from "../hitl-gate-submit";
import {
  COMPLETION_PRODUCED_PARAM,
  readCompletionProduced,
  readCompletionProducedParam,
  withCompletionProduced,
  withCompletionReturn,
} from "@/lib/agent-url";

describe("a completion that names a list is read for the step that offered the road", () => {
  it("reads the listId off a fake completion addressed at a list-picking step", () => {
    expect(
      producedIdForOfferingStep("list-picker", { listId: "lst_made_by_the_child" }),
    ).toBe("lst_made_by_the_child");
  });

  it("reads it off the run's own completion record, including the values the end declared", () => {
    // The shape a completed run persists: per-step results, with the declared
    // output values surfaced on `output_data`.
    expect(
      producedIdFromRunCompletion("list-picker", [
        { step: 0, output_data: { some_other_value: 7 } },
        { step: 1, output_data: { listId: "lst_from_the_end_node" } },
      ]),
    ).toBe("lst_from_the_end_node");
  });

  it("reads nothing from a completion that produced no list — the honest empty state", () => {
    // THE PACKAGE'S HALF, and the reason this must not invent anything: a run
    // that completes WITHOUT raising its own gate produces no list, and the
    // parked step must open on "No lists yet" rather than on a fabricated offer.
    expect(
      producedIdFromRunCompletion("list-picker", [
        { step: 0, output_data: { summary: "approval required" } },
      ]),
    ).toBe("");
    expect(producedIdFromRunCompletion("list-picker", null)).toBe("");
  });

  it("names no package: a step family it does not know reads nothing", () => {
    expect(producedIdForOfferingStep("some-other-step", { listId: "lst_1" })).toBe("");
    expect(producedIdForOfferingStep("", { listId: "lst_1" })).toBe("");
  });
});

describe("the id rides the return address onto the parked run", () => {
  it("carries what was produced beside the address, keeping the query it already had", () => {
    const href = withCompletionProduced("/agents/v/p/run-parked?tab=run", "lst_9");
    expect(href).toContain(`${COMPLETION_PRODUCED_PARAM}=lst_9`);
    expect(href).toContain("tab=run");
  });

  it("carries nothing when nothing was produced — the address is unchanged", () => {
    expect(withCompletionProduced("/agents/v/p/run-parked", "")).toBe(
      "/agents/v/p/run-parked",
    );
    expect(withCompletionProduced("/agents/v/p/run-parked", null)).toBe(
      "/agents/v/p/run-parked",
    );
  });

  it("is read back off the parked run's own address", () => {
    const href = withCompletionProduced("/agents/v/p/run-parked", "lst_9");
    const search = href.slice(href.indexOf("?"));
    expect(readCompletionProduced(search)).toBe("lst_9");
    expect(readCompletionProduced("?tab=run")).toBe("");
    expect(readCompletionProduced("")).toBe("");
  });
});

describe("the return address survives being written (convergence round, cinatra#3448)", () => {
  it("keeps a fragment out of the query and the key inside it", () => {
    // A fragment cut as if it were a query put the key INSIDE the fragment,
    // where no search-string reader can ever see it.
    const href = withCompletionProduced("/agents/v/p/run#review", "lst_2");
    const url = new URL(href, "https://example.test");
    expect(url.hash).toBe("#review");
    expect(url.searchParams.get(COMPLETION_PRODUCED_PARAM)).toBe("lst_2");
    expect(readCompletionProduced(url.search)).toBe("lst_2");
  });

  it("keeps the query a fragmented address already holds, unchanged", () => {
    const href = withCompletionProduced("/agents/v/p/run?tab=review#step-1", "lst_2");
    const url = new URL(href, "https://example.test");
    expect(url.searchParams.get("tab")).toBe("review");
    expect(url.hash).toBe("#step-1");
    expect(url.searchParams.get(COMPLETION_PRODUCED_PARAM)).toBe("lst_2");
  });

  it("keeps a value that itself contains a question mark", () => {
    const href = withCompletionProduced("/agents/v/p/run?next=a%3Fb", "lst_2");
    const url = new URL(href, "https://example.test");
    expect(url.searchParams.get("next")).toBe("a?b");
    expect(url.searchParams.get(COMPLETION_PRODUCED_PARAM)).toBe("lst_2");
  });

  it("is idempotent — writing it twice leaves one key with the later id", () => {
    const once = withCompletionProduced("/agents/v/p/run", "lst_2");
    const twice = withCompletionProduced(once, "lst_3");
    const url = new URL(twice, "https://example.test");
    expect(url.searchParams.getAll(COMPLETION_PRODUCED_PARAM)).toEqual(["lst_3"]);
  });
});

describe("a canonical-home redirect carries ALL THREE keys (convergence round, cinatra#3448)", () => {
  // An anchored parked run is addressed at its bare route and redirected to its
  // vantage's address. The redirect used to carry the contract's two keys and
  // drop the third, so the offer was lost for exactly the anchored runs.
  const searchParams = {
    onComplete: "list-picker",
    onCompleteRunId: "run-parked",
    [COMPLETION_PRODUCED_PARAM]: "lst_2",
  };

  it("reads the produced id off a screen's own search params", () => {
    expect(readCompletionProducedParam(searchParams)).toBe("lst_2");
    expect(readCompletionProducedParam(null)).toBe("");
    expect(readCompletionProducedParam({})).toBe("");
    expect(
      readCompletionProducedParam({ [COMPLETION_PRODUCED_PARAM]: ["lst_9", "lst_8"] }),
    ).toBe("lst_9");
  });

  it("lands the offer on the canonical address, not only the bare one", () => {
    const home = "/w/acme/agents/v/p/run-parked";
    const redirected = withCompletionProduced(
      withCompletionReturn(home, {
        onComplete: "list-picker",
        returnRunId: "run-parked",
      }),
      readCompletionProducedParam(searchParams),
    );
    const url = new URL(redirected, "https://example.test");
    expect(url.pathname).toBe(home);
    expect(url.searchParams.get("onComplete")).toBe("list-picker");
    expect(url.searchParams.get("onCompleteRunId")).toBe("run-parked");
    expect(url.searchParams.get(COMPLETION_PRODUCED_PARAM)).toBe("lst_2");
  });
});
