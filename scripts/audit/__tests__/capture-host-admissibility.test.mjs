/**
 * WHICH HOST THE RUN PAGE'S INPUT CARD IS PHOTOGRAPHED ON (cinatra#3068, fix
 * leg 2).
 *
 * THE DEFECT. The shipped recorder, driven over the run page's input step,
 * answered: `agent_hitl_screen` on host `run_page` is
 * "declared composition-only, with no reason recorded". Neither half of that
 * sentence is true. `run_page` is not a host at all — the four hosts are
 * `chat_thread`, `site_widget`, `run_card` and `page_gate_region`, and the run
 * page's own card is `run_card`: the run detail mounts every lifecycle card it
 * draws under `LifecycleCardSurfaceProvider host="run_card"`. So a token
 * outside the vocabulary was answered with a REFUSAL THAT READS AS A RECORDED
 * FACT about a cell, and the reason it gave named nothing an operator could act
 * on.
 *
 * TWO THINGS ARE PINNED HERE. A token that names no host is refused as exactly
 * that, with the vocabulary and the run page's own host named in the reason;
 * and the host the run page draws this card on is ADMITTED, with the reason
 * recorded rather than left to be inferred from the absence of a refusal.
 *
 * Run:
 *   npx vitest run scripts/audit/__tests__/capture-host-admissibility.test.mjs
 */
import { describe, expect, it } from "vitest";

import {
  CAPTURE_HOSTS,
  CARD_KINDS,
  HOST_URL_CLASS,
  URL_CLASSES,
  captureHostAdmissibility,
} from "../../ci/lib/capture-record-contract.mjs";

const KIND = "agent_hitl_screen";

describe("a token that names no host is refused as a token, not as a cell", () => {
  it("refuses `run_page` and says it is not one of the four declared names", () => {
    const admission = captureHostAdmissibility(KIND, "run_page");
    expect(admission.capturable).toBe(false);
    expect(admission.reason).not.toBe(
      "declared composition-only, with no reason recorded",
    );
    expect(admission.reason).toMatch(/not one of the four names in `CAPTURE_HOSTS`/);
    for (const host of CAPTURE_HOSTS) {
      expect(admission.reason).toContain(host);
    }
  });

  it("names the host the run page actually draws the card on", () => {
    expect(captureHostAdmissibility(KIND, "run_page").reason).toMatch(/run_card/);
  });

  it("answers the same way for every kind, so no kind can absorb the mistake", () => {
    for (const kind of Object.keys(CARD_KINDS)) {
      expect(captureHostAdmissibility(kind, "run_page").capturable).toBe(false);
    }
  });
});

describe("the run page's own host is admitted, with the reason recorded", () => {
  it("admits `run_card` for the kind the run page's input step draws", () => {
    const admission = captureHostAdmissibility(KIND, "run_card");
    expect(admission.capturable).toBe(true);
    expect(typeof admission.reason).toBe("string");
    expect(admission.reason).toMatch(/run page/);
    expect(admission.reason).toMatch(/run_detail/);
  });

  it("photographs it on the run page's own URL class", () => {
    expect(HOST_URL_CLASS.run_card).toContain("run_detail");
    expect(
      URL_CLASSES.run_detail.test(
        "/agents/cinatra-ai/blog-draft-writer-agent/ec745b28-1b56-4ef4-b724-62e6fd1ddd23",
      ),
    ).toBe(true);
  });

  it("leaves every other kind and every composition-only reason untouched", () => {
    expect(CARD_KINDS[KIND].capturableHosts).toEqual(["chat_thread", "run_card"]);
    expect(captureHostAdmissibility(KIND, "site_widget").reason).toMatch(
      /pending_approval/,
    );
    expect(captureHostAdmissibility(KIND, "page_gate_region").reason).toMatch(
      /review/,
    );
    for (const kind of Object.keys(CARD_KINDS)) {
      // The publish card declares its own composition-only cell; it is pinned on its own below.
      if (kind === KIND || kind === "publish_decision") continue;
      for (const host of CAPTURE_HOSTS) {
        expect(captureHostAdmissibility(kind, host).capturable).toBe(true);
      }
    }
  });
});

describe("the publish card's review host is the run page, and the gate region is composition-only (cinatra#4150)", () => {
  const PUBLISH = "publish_decision";

  it("admits the run page, where a run's review is read since the review address redirects there", () => {
    const admission = captureHostAdmissibility(PUBLISH, "run_card");
    expect(admission.capturable).toBe(true);
    expect(admission.reason).toMatch(/cinatra#3693/);
    expect(admission.reason).toMatch(/run_detail/);
    for (const host of ["chat_thread", "site_widget"]) {
      expect(captureHostAdmissibility(PUBLISH, host).capturable).toBe(true);
    }
  });

  it("refuses a picture of the gate region and says why no reader reaches a card there", () => {
    const admission = captureHostAdmissibility(PUBLISH, "page_gate_region");
    expect(admission.capturable).toBe(false);
    expect(admission.reason).toMatch(/reviewAddressRedirect/);
    expect(admission.reason).toMatch(/`none`/);
    expect(CARD_KINDS[PUBLISH].capturableHosts).toEqual(["chat_thread", "site_widget", "run_card"]);
  });
});
