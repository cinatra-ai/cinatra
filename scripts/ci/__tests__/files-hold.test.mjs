// The files-hold decision and the two commands around it.
//
// `decide` is one pure function from the listings to the statuses, and
// `scope` one pure function from the event and the holders to the pull
// requests the event evaluates. Both are tested here without the network: the
// seven cases the status exists for, the length of every description, which
// pull requests each kind of event evaluates. The commands are tested on a
// fake of the platform's API: how a listing cut short is recognised, what a
// push to a labelled pull request does, how many requests each kind of
// evaluation makes, and that a status the head already carries is not written
// again. A hold lasts at most 24 hours: the clock is an input, a fixed number
// handed in, never the machine's clock.

import { describe, expect, it } from "vitest";

import {
  CONTEXT,
  DESCRIPTION_LIMIT,
  HOLDS,
  LABEL,
  LABEL_TIME_UNREAD,
  NOTHING_HELD,
  SHARES_NOTHING,
  cutShortDescription,
  decide,
  endHold,
  evaluate,
  fingerprint,
  heldDescription,
  scope,
} from "../files-hold.mjs";
// The exports of the 24-hour rule are read through the namespace, so that a
// missing one fails its own cases and never the whole module.
import * as filesHold from "../files-hold.mjs";

const head = (n) => n.toString(16).padStart(40, "0");
const T1 = "2026-09-29T08:00:00Z";
const T2 = "2026-09-29T09:00:00Z";
const T3 = "2026-09-29T10:00:00Z";

/** One open pull request of a listing; `labelledAt` puts the label on it. */
function pr(number, options = {}) {
  const labels = [{ name: "documentation", at: null }];
  if ("labelledAt" in options) labels.push({ name: LABEL, at: options.labelledAt });
  return {
    number,
    head: options.head ?? head(number),
    draft: options.draft ?? false,
    state: options.state ?? "open",
    merged: options.merged ?? false,
    labels,
    files: options.files === undefined ? [] : options.files,
    filesComplete: options.filesComplete ?? options.files !== null,
    ...(options.filesProblem ? { filesProblem: options.filesProblem } : {}),
  };
}

const statusOf = (decision, number) => decision.statuses.find((s) => s.number === number);

describe("decide: the seven cases", () => {
  it("1. no labelled pull request: every open head succeeds, even one whose files were not read", () => {
    const decision = decide({
      pullRequests: [pr(1, { files: ["a.ts"] }), pr(2, { files: ["a.ts"] }), pr(3, { files: null })],
    });
    expect(decision.statuses).toEqual([
      { number: 1, head: head(1), state: "success", description: NOTHING_HELD },
      { number: 2, head: head(2), state: "success", description: NOTHING_HELD },
      { number: 3, head: head(3), state: "success", description: NOTHING_HELD },
    ]);
    expect(decision.endHolds).toEqual([]);
  });

  it("2. one labelled pull request and one that shares a file: the second is held and names the first", () => {
    const decision = decide({
      pullRequests: [pr(10, { labelledAt: T1, files: ["a.ts", "b.ts"] }), pr(11, { files: ["b.ts", "c.ts"] })],
    });
    expect(statusOf(decision, 11)).toEqual({
      number: 11,
      head: head(11),
      state: "failure",
      description: "Held by #10: b.ts",
      holder: 10,
    });
    expect(statusOf(decision, 10)).toEqual({ number: 10, head: head(10), state: "success", description: HOLDS });
  });

  it("3. a pull request that shares no file with the labelled one succeeds", () => {
    const decision = decide({
      pullRequests: [pr(10, { labelledAt: T1, files: ["a.ts"] }), pr(12, { files: ["x.ts"] })],
    });
    expect(statusOf(decision, 12)).toEqual({
      number: 12,
      head: head(12),
      state: "success",
      description: SHARES_NOTHING,
    });
  });

  it("4. two labelled pull requests that share a file: the one labelled first holds", () => {
    // Listed in the other order, and the later-labelled one has the lower
    // number: only the label times decide.
    const decision = decide({
      pullRequests: [
        pr(20, { labelledAt: T2, files: ["s.ts", "t.ts"] }),
        pr(21, { labelledAt: T1, files: ["s.ts"] }),
        pr(22, { files: ["s.ts"] }),
      ],
    });
    expect(statusOf(decision, 21)).toMatchObject({ state: "success", description: HOLDS });
    expect(statusOf(decision, 20)).toMatchObject({ state: "failure", description: "Held by #21: s.ts", holder: 21 });
    // A pull request that shares a file with both is held by the first one.
    expect(statusOf(decision, 22)).toMatchObject({ state: "failure", holder: 21 });
  });

  it("5. a labelled pull request whose head moved after its label holds nothing, and its label comes off", () => {
    const decision = decide({
      pullRequests: [pr(30, { labelledAt: T1, files: ["m.ts"] }), pr(31, { files: ["m.ts"] })],
      pushed: { number: 30, at: T2 },
    });
    expect(decision.endHolds).toEqual([{ number: 30, label: LABEL }]);
    expect(statusOf(decision, 31)).toMatchObject({ state: "success", description: NOTHING_HELD });
    expect(statusOf(decision, 30)).toMatchObject({ state: "success", description: NOTHING_HELD });
  });

  it("5b. a label set after the push keeps holding, and stays on", () => {
    const decision = decide({
      pullRequests: [pr(30, { labelledAt: T3, files: ["m.ts"] }), pr(31, { files: ["m.ts"] })],
      pushed: { number: 30, at: T2 },
    });
    expect(decision.endHolds).toEqual([]);
    expect(statusOf(decision, 31)).toMatchObject({ state: "failure", holder: 30 });
  });

  it("6. a closed or merged labelled pull request holds nothing and gets no status", () => {
    const decision = decide({
      pullRequests: [
        pr(40, { labelledAt: T1, files: ["c.ts"], state: "closed" }),
        pr(41, { labelledAt: T1, files: ["c.ts"], state: "closed", merged: true }),
        pr(42, { files: ["c.ts"] }),
      ],
    });
    expect(decision.statuses.map((s) => s.number)).toEqual([42]);
    expect(statusOf(decision, 42)).toMatchObject({ state: "success", description: NOTHING_HELD });
  });

  it("7. a listing cut short fails the status of the pull request it concerns and says why", () => {
    const decision = decide({
      pullRequests: [
        pr(50, { labelledAt: T1, files: ["a.ts"] }),
        pr(51, { files: ["z.ts"], filesComplete: false, filesProblem: "3000 of 3001 files listed" }),
      ],
    });
    expect(statusOf(decision, 51)).toEqual({
      number: 51,
      head: head(51),
      state: "failure",
      description: "Its file list could not be read in full: 3000 of 3001 files listed",
    });
  });

  it("7b. a labelled pull request whose own listing is cut short holds nothing, and its status says so", () => {
    const decision = decide({
      pullRequests: [
        pr(52, {
          labelledAt: T1,
          files: ["a.ts"],
          filesComplete: false,
          filesProblem: "a page of the file list could not be read (HTTP 502)",
        }),
        pr(53, { files: ["a.ts"] }),
      ],
    });
    expect(statusOf(decision, 52)).toMatchObject({
      state: "failure",
      description: "Holds nothing: its file list could not be read in full: a page of the file list could not be read (HTTP 502)",
    });
    expect(statusOf(decision, 53)).toMatchObject({ state: "success", description: NOTHING_HELD });
  });
});

describe("decide: the rules around the seven cases", () => {
  it("a labelled pull request whose label time cannot be read holds nothing, and its status says so", () => {
    const decision = decide({ pullRequests: [pr(60, { labelledAt: null, files: ["a.ts"] }), pr(61, { files: ["a.ts"] })] });
    expect(statusOf(decision, 60)).toMatchObject({ state: "failure", description: LABEL_TIME_UNREAD });
    expect(statusOf(decision, 61)).toMatchObject({ state: "success", description: NOTHING_HELD });
  });

  it("a push of unknown time ends the hold of the labelled pull request it moved", () => {
    const decision = decide({
      pullRequests: [pr(62, { labelledAt: T1, files: ["a.ts"] }), pr(63, { files: ["a.ts"] })],
      pushed: { number: 62, at: null },
    });
    expect(decision.endHolds).toEqual([{ number: 62, label: LABEL }]);
    expect(statusOf(decision, 63)).toMatchObject({ state: "success" });
  });

  it("the label is found whatever its case, and the name it carries is the one taken off", () => {
    const labelled = pr(64, { files: ["a.ts"] });
    labelled.labels.push({ name: "Holds-Files", at: T1 });
    const decision = decide({ pullRequests: [labelled, pr(65, { files: ["a.ts"] })], pushed: { number: 64, at: T2 } });
    expect(decision.endHolds).toEqual([{ number: 64, label: "Holds-Files" }]);
  });

  it("with equal label times the lower number holds", () => {
    const decision = decide({
      pullRequests: [pr(71, { labelledAt: T1, files: ["a.ts"] }), pr(70, { labelledAt: T1, files: ["a.ts"] })],
    });
    expect(statusOf(decision, 70)).toMatchObject({ state: "success", description: HOLDS });
    expect(statusOf(decision, 71)).toMatchObject({ state: "failure", holder: 70 });
  });

  it("a draft is judged as any other open pull request", () => {
    const decision = decide({
      pullRequests: [pr(72, { labelledAt: T1, draft: true, files: ["d.ts"] }), pr(73, { draft: true, files: ["d.ts"] })],
    });
    expect(statusOf(decision, 72)).toMatchObject({ state: "success", description: HOLDS });
    expect(statusOf(decision, 73)).toMatchObject({ state: "failure", holder: 72 });
  });

  it("a held labelled pull request still holds its files against pull requests without the label", () => {
    const decision = decide({
      pullRequests: [
        pr(74, { labelledAt: T1, files: ["a.ts"] }),
        pr(75, { labelledAt: T2, files: ["a.ts", "b.ts"] }),
        pr(76, { files: ["b.ts"] }),
      ],
    });
    expect(statusOf(decision, 75)).toMatchObject({ state: "failure", holder: 74 });
    expect(statusOf(decision, 76)).toMatchObject({ state: "failure", holder: 75, description: "Held by #75: b.ts" });
  });

  it("two open pull requests on one head get one status, and a failure wins", () => {
    const shared = head(99);
    const decision = decide({
      pullRequests: [
        pr(77, { labelledAt: T1, files: ["a.ts"] }),
        pr(78, { head: shared, files: ["x.ts"] }),
        pr(79, { head: shared, files: ["a.ts"] }),
      ],
    });
    const onShared = decision.statuses.filter((s) => s.head === shared);
    expect(onShared).toEqual([{ number: 79, head: shared, state: "failure", description: "Held by #77: a.ts", holder: 77 }]);
  });

  it("names at most three shared paths, in order, then how many more", () => {
    const decision = decide({
      pullRequests: [
        pr(80, { labelledAt: T1, files: ["e.ts", "d.ts", "c.ts", "b.ts", "a.ts"] }),
        pr(81, { files: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"] }),
      ],
    });
    expect(statusOf(decision, 81).description).toBe("Held by #80: a.ts, b.ts, c.ts and 2 more");
  });

  it("refuses a listing it cannot judge instead of guessing", () => {
    expect(() => decide({ pullRequests: [{ number: 1, head: "", labels: [], files: [], filesComplete: true }] })).toThrow();
    expect(() => decide({})).toThrow();
  });

  it("a pull request whose head moved during the evaluation gets no status: the run for the push writes it", () => {
    const decision = decide({
      pullRequests: [
        { ...pr(90, { labelledAt: T1, files: ["a.ts"] }), headNow: head(90) },
        { ...pr(91, { files: ["a.ts"] }), headNow: head(191) },
        { ...pr(92, { files: ["a.ts"] }), headNow: head(92) },
      ],
    });
    expect(decision.statuses.map((s) => s.number)).toEqual([90, 92]);
    expect(statusOf(decision, 92)).toMatchObject({ state: "failure", holder: 90 });
    expect(decision.skipped).toEqual([{ number: 91, reason: "its head moved during the evaluation" }]);
  });

  it("a pull request closed before the write gets no status", () => {
    const decision = decide({ pullRequests: [{ ...pr(93, { files: [] }), headNow: null }] });
    expect(decision.statuses).toEqual([]);
    expect(decision.skipped).toEqual([{ number: 93, reason: "it was closed before the write" }]);
  });
});

const HOUR = 60 * 60 * 1000;
/** A time `hours` (and `ms`) after the label time `labelledAt`, as the clock decide takes. */
const after = (labelledAt, hours, ms = 0) => Date.parse(labelledAt) + hours * HOUR + ms;
const EXPIRED_TEXT = "Its holds-files label is more than 24 hours old: the hold expired, it holds nothing now.";

describe("decide: a hold lasts at most 24 hours", () => {
  it("25 hours after its label the holder holds nothing: the pull request that shares its file succeeds and names the expired hold", () => {
    const decision = decide({
      pullRequests: [pr(10, { labelledAt: T1, files: ["a.ts", "b.ts"] }), pr(11, { files: ["b.ts", "c.ts"] })],
      now: after(T1, 25),
    });
    expect(statusOf(decision, 11)).toEqual({
      number: 11,
      head: head(11),
      state: "success",
      description: "Hold of #10 expired after 24 hours: b.ts",
    });
    expect(statusOf(decision, 10)).toEqual({ number: 10, head: head(10), state: "success", description: EXPIRED_TEXT });
    expect(filesHold.EXPIRED).toBe(EXPIRED_TEXT);
  });

  it("23 hours after its label the holder still holds (green at the base too)", () => {
    const decision = decide({
      pullRequests: [pr(10, { labelledAt: T1, files: ["a.ts", "b.ts"] }), pr(11, { files: ["b.ts", "c.ts"] })],
      now: after(T1, 23),
    });
    expect(statusOf(decision, 11)).toEqual({
      number: 11,
      head: head(11),
      state: "failure",
      description: "Held by #10: b.ts",
      holder: 10,
    });
    expect(statusOf(decision, 10)).toMatchObject({ state: "success", description: HOLDS });
  });

  it("exactly 24 hours still holds; 24 hours and one millisecond has expired", () => {
    expect(filesHold.HOLD_LASTS_HOURS).toBe(24);
    expect(filesHold.HOLD_LASTS_MS).toBe(24 * HOUR);
    const at = (now) =>
      decide({ pullRequests: [pr(10, { labelledAt: T1, files: ["a.ts"] }), pr(11, { files: ["a.ts"] })], now });
    expect(statusOf(at(after(T1, 24)), 11)).toMatchObject({ state: "failure", holder: 10 });
    expect(statusOf(at(after(T1, 24)), 10)).toMatchObject({ state: "success", description: HOLDS });
    expect(statusOf(at(after(T1, 24, 1)), 11)).toMatchObject({
      state: "success",
      description: "Hold of #10 expired after 24 hours: a.ts",
    });
    expect(statusOf(at(after(T1, 24, 1)), 10)).toMatchObject({ state: "success", description: EXPIRED_TEXT });
  });

  it("without a clock a label of any age holds: the clock is an input (green at the base too)", () => {
    const decision = decide({
      pullRequests: [pr(10, { labelledAt: "2020-01-01T00:00:00Z", files: ["a.ts"] }), pr(11, { files: ["a.ts"] })],
    });
    expect(statusOf(decision, 10)).toMatchObject({ state: "success", description: HOLDS });
    expect(statusOf(decision, 11)).toMatchObject({ state: "failure", description: "Held by #10: a.ts", holder: 10 });
  });

  it("a live holder labelled after an expired one holds against it, and holds a pull request that shares files with both", () => {
    const T_LATER = "2026-09-30T04:00:00Z"; // 20 hours after T1
    const decision = decide({
      pullRequests: [
        pr(10, { labelledAt: T1, files: ["a.ts"] }),
        pr(20, { labelledAt: T_LATER, files: ["a.ts", "b.ts"] }),
        pr(30, { files: ["a.ts", "b.ts"] }),
      ],
      now: after(T1, 25),
    });
    expect(statusOf(decision, 10)).toEqual({
      number: 10,
      head: head(10),
      state: "failure",
      description: "Held by #20: a.ts",
      holder: 20,
    });
    expect(statusOf(decision, 20)).toMatchObject({ state: "success", description: HOLDS });
    expect(statusOf(decision, 30)).toMatchObject({ state: "failure", description: "Held by #20: a.ts, b.ts", holder: 20 });
  });

  it("an expired holder is in no holder list and no fingerprint, and is listed as expired", () => {
    const T_LATER = "2026-09-30T04:00:00Z";
    const listing = {
      pullRequests: [pr(10, { labelledAt: T1, files: ["a.ts"] }), pr(20, { labelledAt: T_LATER, files: ["x.ts"] })],
      now: after(T1, 25),
    };
    const live = [{ number: 20, at: "2026-09-30T04:00:00.000Z", head: head(20) }];
    const decision = decide(listing);
    expect(decision.holders).toEqual(live);
    expect(decision.fingerprint).toBe(fingerprint(live));
    expect(decision.expired).toEqual([{ number: 10, at: "2026-09-29T08:00:00.000Z", head: head(10) }]);
    expect(filesHold.holdersOf(listing)).toEqual(live);
  });

  it("a clock that is not a finite number is refused", () => {
    const pullRequests = [pr(10, { labelledAt: T1, files: ["a.ts"] })];
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY, "2026-09-30T12:00:00Z", null]) {
      expect(() => decide({ pullRequests, now }), String(now)).toThrow(TypeError);
      expect(() => filesHold.holdersOf({ pullRequests, now }), String(now)).toThrow(TypeError);
    }
  });
});

describe("the descriptions of an expired hold stay within the platform's limit", () => {
  const within = (text) => {
    expect(text.length, text).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
    expect(text.length, text).toBeGreaterThan(0);
  };

  it("the expired holder's own text fits", () => {
    within(EXPIRED_TEXT);
    within(filesHold.EXPIRED);
  });

  it("an expired description always names the holder and counts every path it leaves out", () => {
    const prefix = "Hold of #123456 expired after 24 hours: ";
    for (const count of [1, 2, 3, 4, 7, 250]) {
      for (const width of [1, 10, 40, 60, 139, 400]) {
        const paths = Array.from({ length: count }, (_, i) => `${String(i).padStart(4, "0")}/${"p".repeat(width)}.ts`);
        const text = filesHold.expiredDescription(123456, paths);
        within(text);
        expect(text.startsWith(prefix), text).toBe(true);
        const more = /and (\d+) more$/.exec(text);
        const named = text.slice(prefix.length).replace(/ and \d+ more$/, "").split(", ").length;
        expect(named, text).toBeLessThanOrEqual(3);
        expect(named + (more ? Number(more[1]) : 0), text).toBe(count);
      }
    }
  });

  it("names the paths as a held description does, and a path too long for the limit keeps its end", () => {
    expect(filesHold.expiredDescription(80, ["e.ts", "d.ts", "c.ts", "b.ts", "a.ts"])).toBe(
      "Hold of #80 expired after 24 hours: a.ts, b.ts, c.ts and 2 more",
    );
    const text = filesHold.expiredDescription(7, [`${"deep/".repeat(60)}the-file-that-matters.ts`]);
    within(text);
    expect(text.startsWith("Hold of #7 expired after 24 hours: …")).toBe(true);
    expect(text.endsWith("the-file-that-matters.ts")).toBe(true);
    expect(filesHold.expiredDescription(5, ["a\nb‮.ts"])).toBe("Hold of #5 expired after 24 hours: a?b?.ts");
  });

  it("every description decide writes after an expiry fits, whatever the paths", () => {
    const long = Array.from({ length: 12 }, (_, i) => `packages/${"nested/".repeat(i + 3)}file-${i}.test.ts`);
    const decision = decide({
      pullRequests: [pr(1000000, { labelledAt: T1, files: long }), pr(1000001, { files: long })],
      now: after(T1, 25),
    });
    expect(decision.statuses).toHaveLength(2);
    expect(statusOf(decision, 1000001).description.startsWith("Hold of #1000000 expired after 24 hours: ")).toBe(true);
    for (const status of decision.statuses) within(status.description);
  });
});

describe("which pull requests an event evaluates", () => {
  const open = [1, 2, 3, 4].map((n) => ({ number: n, head: head(n), labelled: n === 1 }));
  const holders = [{ number: 1, at: "2026-09-29T08:00:00.000Z", head: head(1) }];
  const fp = fingerprint(holders);
  /** The status each open head carries now; `changes` replaces some (null: none). */
  const recorded = (changes = {}) =>
    new Map(
      open.map((p) => [
        p.head,
        p.number in changes
          ? changes[p.number]
          : { state: "success", description: p.number === 1 ? HOLDS : SHARES_NOTHING, fingerprint: fp },
      ]),
    );
  const event = (action, number, { labels = [], label } = {}) => ({
    action,
    pull_request: { number, labels: labels.map((name) => ({ name })) },
    ...(label ? { label: { name: label } } : {}),
  });
  const target = (eventName, payload, current = recorded()) => scope({ eventName, payload, open, holders, current });

  it("an event of a pull request that changes no holder evaluates that pull request alone", () => {
    for (const action of ["opened", "reopened", "synchronize", "ready_for_review"]) {
      expect(target("pull_request_target", event(action, 2)), action).toMatchObject({ all: false, numbers: [2] });
    }
    for (const action of ["labeled", "unlabeled"]) {
      expect(target("pull_request_target", event(action, 2, { label: "documentation" })), action).toMatchObject({
        all: false,
        numbers: [2],
      });
    }
    // A labelled pull request made ready for review changes no holder either.
    expect(target("pull_request_target", event("ready_for_review", 1, { labels: [LABEL] }))).toMatchObject({
      all: false,
      numbers: [1],
    });
  });

  it("an event that changes the holders evaluates every open pull request", () => {
    const every = { all: true, numbers: [1, 2, 3, 4] };
    expect(target("pull_request_target", event("labeled", 2, { labels: [LABEL], label: LABEL }))).toMatchObject(every);
    expect(target("pull_request_target", event("unlabeled", 1, { label: LABEL }))).toMatchObject(every);
    expect(target("pull_request_target", event("labeled", 2, { label: "Holds-Files" }))).toMatchObject(every);
    for (const action of ["closed", "reopened", "synchronize", "opened"]) {
      expect(target("pull_request_target", event(action, 1, { labels: [LABEL] })), action).toMatchObject(every);
    }
  });

  it("a pull request without the label that closes changes nothing", () => {
    expect(target("pull_request_target", event("closed", 2))).toMatchObject({ all: false, numbers: [] });
  });

  it("a run by hand evaluates every open pull request", () => {
    expect(target("workflow_dispatch", {})).toMatchObject({ all: true, numbers: [1, 2, 3, 4] });
  });

  it("a head that carries no status is evaluated too, as after an evaluation a newer event replaced", () => {
    expect(target("pull_request_target", event("opened", 2), recorded({ 3: null }))).toMatchObject({
      all: false,
      numbers: [2, 3],
    });
  });

  it("every open pull request is evaluated when a holder's status was set against other holders", () => {
    const old = { state: "success", description: HOLDS, fingerprint: fingerprint([]) };
    expect(target("pull_request_target", event("opened", 2), recorded({ 1: old }))).toMatchObject({
      all: true,
      numbers: [1, 2, 3, 4],
    });
  });

  it("a status held by a pull request that holds nothing now is evaluated again", () => {
    const stale = { state: "failure", description: "Held by #9: a.ts", fingerprint: fp };
    expect(target("pull_request_target", event("opened", 2), recorded({ 4: stale }))).toMatchObject({
      all: false,
      numbers: [2, 4],
    });
  });

  it("a status set while no pull request held files is evaluated again once one does", () => {
    const nothingHeld = { state: "success", description: NOTHING_HELD, fingerprint: fingerprint([]) };
    expect(target("pull_request_target", event("opened", 2), recorded({ 3: nothingHeld }))).toMatchObject({
      all: false,
      numbers: [2, 3],
    });
  });

  it("a status that disagrees with the label on the pull request is evaluated again", () => {
    // It says the label is on a pull request that no longer carries it.
    const labelledForm = { state: "success", description: HOLDS, fingerprint: fp };
    expect(target("pull_request_target", event("opened", 3), recorded({ 2: labelledForm }))).toMatchObject({
      all: false,
      numbers: [2, 3],
    });
    // It was set before the label went on.
    const unlabelledForm = { state: "success", description: SHARES_NOTHING, fingerprint: fp };
    expect(target("pull_request_target", event("opened", 3), recorded({ 1: unlabelledForm }))).toMatchObject({
      all: false,
      numbers: [1, 3],
    });
  });
});

describe("which pull requests a scheduled run evaluates", () => {
  const open = [1, 2, 3, 4].map((n) => ({ number: n, head: head(n), labelled: n === 1 }));
  const holders = [{ number: 1, at: "2026-09-29T08:00:00.000Z", head: head(1) }];
  const fp = fingerprint(holders);
  const status = (description, holdersThen = holders) => ({ state: "success", description, fingerprint: fingerprint(holdersThen) });
  const statuses = (byNumber) => new Map(open.map((p) => [p.head, byNumber[p.number]]));
  const scheduled = (holdersNow, current) =>
    scope({ eventName: "schedule", payload: { schedule: "17 * * * *" }, open, holders: holdersNow, current });

  it("evaluates nothing of its own when every status fits", () => {
    const fitting = statuses({ 1: status(HOLDS), 2: status(SHARES_NOTHING), 3: status(SHARES_NOTHING), 4: status(SHARES_NOTHING) });
    expect(fitting.get(head(1)).fingerprint).toBe(fp);
    expect(scheduled(holders, fitting)).toEqual({
      all: false,
      numbers: [],
      why: "a scheduled run renews what the time changed",
      stale: [],
    });
    // After the last hold expired: the holder's own text, the expired hold named, nothing held.
    const afterExpiry = statuses({
      1: status(EXPIRED_TEXT, []),
      2: status("Hold of #1 expired after 24 hours: a.ts", []),
      3: status(NOTHING_HELD, []),
      4: status(NOTHING_HELD, []),
    });
    expect(scheduled([], afterExpiry)).toMatchObject({ all: false, numbers: [], stale: [] });
  });

  it("takes in a status that says it holds on a pull request that holds nothing now", () => {
    const current = statuses({
      1: status(HOLDS),
      2: status("Hold of #1 expired after 24 hours: a.ts", []),
      3: status(NOTHING_HELD, []),
      4: status(NOTHING_HELD, []),
    });
    expect(scheduled([], current)).toEqual({
      all: false,
      numbers: [1],
      why: "a scheduled run renews what the time changed",
      stale: ["#1 says it holds, and it holds nothing now"],
    });
  });

  it("takes in a status that names no hold while no pull request holds", () => {
    const current = statuses({
      1: status(EXPIRED_TEXT, []),
      2: status(SHARES_NOTHING),
      3: status(NOTHING_HELD, []),
      4: status("Hold of #1 expired after 24 hours: a.ts", []),
    });
    expect(scheduled([], current)).toEqual({
      all: false,
      numbers: [2],
      why: "a scheduled run renews what the time changed",
      stale: ["#2 was set while a pull request held files, and none does now"],
    });
  });

  it("takes in every status that names an expired holder when it was the last, and every one when others still hold", () => {
    const held = { state: "failure", description: "Held by #1: a.ts", fingerprint: fp };
    const lastExpired = statuses({ 1: status(HOLDS), 2: held, 3: status(SHARES_NOTHING), 4: status(NOTHING_HELD, []) });
    expect(scheduled([], lastExpired)).toMatchObject({ all: false, numbers: [1, 2, 3] });
    // #1 expired while #4 still holds: the holders changed, so every open pull request is evaluated.
    const stillHeld = [{ number: 4, at: "2026-09-30T04:00:00.000Z", head: head(4) }];
    const bothHeld = [...holders, ...stillHeld];
    const withLabelOn4 = open.map((p) => ({ ...p, labelled: p.number === 1 || p.number === 4 }));
    const setWhileBothHeld = statuses({
      1: status(HOLDS, bothHeld),
      2: { ...held, fingerprint: fingerprint(bothHeld) },
      3: status(SHARES_NOTHING, bothHeld),
      4: status(HOLDS, bothHeld),
    });
    expect(
      scope({ eventName: "schedule", payload: {}, open: withLabelOn4, holders: stillHeld, current: setWhileBothHeld }),
    ).toMatchObject({ all: true, numbers: [1, 2, 3, 4] });
  });

  it("reads a scheduled event as a run by hand is read, and refuses any other event by naming the three it runs on", () => {
    expect(filesHold.readEvent("schedule", { schedule: "17 * * * *" })).toEqual({
      name: "schedule",
      action: null,
      number: null,
      pushedAt: null,
      carriesLabel: false,
    });
    expect(() => filesHold.readEvent("push", {})).toThrow(/pull_request_target, schedule and workflow_dispatch only/);
  });
});

describe("the fingerprint of the holders", () => {
  it("changes with a holder, its label time or its head, and not with their order", () => {
    const a = { number: 1, at: "2026-09-29T08:00:00.000Z", head: head(1) };
    const b = { number: 2, at: "2026-09-29T09:00:00.000Z", head: head(2) };
    expect(fingerprint([a, b])).toBe(fingerprint([b, a]));
    expect(fingerprint([a, b])).toMatch(/^[0-9a-f]{12}$/);
    for (const other of [
      [a],
      [a, b, { ...b, number: 3 }],
      [a, { ...b, at: "2026-09-29T10:00:00.000Z" }],
      [a, { ...b, head: head(22) }],
      [],
    ]) {
      expect(fingerprint(other)).not.toBe(fingerprint([a, b]));
    }
  });
});

describe("the descriptions stay within the platform's limit", () => {
  const within = (text) => {
    expect(text.length, text).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
    expect(text.length, text).toBeGreaterThan(0);
  };

  it("every fixed description fits", () => {
    for (const text of [NOTHING_HELD, SHARES_NOTHING, HOLDS, LABEL_TIME_UNREAD]) within(text);
  });

  it("a held description always names the holder and counts every path it leaves out", () => {
    for (const count of [1, 2, 3, 4, 7, 250]) {
      for (const width of [1, 10, 40, 60, 139, 400]) {
        const paths = Array.from({ length: count }, (_, i) => `${String(i).padStart(4, "0")}/${"p".repeat(width)}.ts`);
        const text = heldDescription(123456, paths);
        within(text);
        expect(text.startsWith("Held by #123456: "), text).toBe(true);
        const more = /and (\d+) more$/.exec(text);
        const named = text.slice("Held by #123456: ".length).replace(/ and \d+ more$/, "").split(", ").length;
        expect(named, text).toBeLessThanOrEqual(3);
        expect(named + (more ? Number(more[1]) : 0), text).toBe(count);
      }
    }
  });

  it("a path too long for the limit keeps its end", () => {
    const text = heldDescription(7, [`${"deep/".repeat(60)}the-file-that-matters.ts`]);
    within(text);
    expect(text.startsWith("Held by #7: …")).toBe(true);
    expect(text.endsWith("the-file-that-matters.ts")).toBe(true);
  });

  it("a cut-short description fits with any reason, labelled or not", () => {
    for (const labelled of [false, true]) {
      within(cutShortDescription("x".repeat(500), { labelled }));
      within(cutShortDescription("3000 of 3001 files listed", { labelled }));
    }
  });

  it("control and direction characters in a path never reach a description", () => {
    const text = heldDescription(5, ["a\nb\u202e.ts"]);
    expect(text).toBe("Held by #5: a?b?.ts");
  });

  it("every description decide writes fits, whatever the paths", () => {
    const long = Array.from({ length: 12 }, (_, i) => `packages/${"nested/".repeat(i + 3)}file-${i}.test.ts`);
    const decision = decide({
      pullRequests: [
        pr(1000000, { labelledAt: T1, files: long }),
        pr(1000001, { files: long }),
        pr(1000002, { files: null, filesComplete: false, filesProblem: "y".repeat(300) }),
        pr(1000003, { labelledAt: T2, files: null, filesComplete: false, filesProblem: "z".repeat(300) }),
      ],
    });
    expect(decision.statuses).toHaveLength(4);
    for (const status of decision.statuses) within(status.description);
  });
});

// ---------------------------------------------------------------------------
// The commands, on a fake of the platform's API.
// ---------------------------------------------------------------------------

const REPOSITORY = "example/project";
const RUN_URL = "https://example.test/runs/7";

/**
 * A fake of the REST and GraphQL routes the commands use. `pulls` are the open
 * pull requests; `files` each one's rows (the record's `changed_files` is their
 * count unless `changedFiles` says otherwise); `events` its issue events;
 * `current` the files-hold status each head carries. `moveOnList` moves heads
 * when the open pull requests are listed for the given time (the listing
 * before the write), as a push during the evaluation would.
 */
function fakeApi({ pulls, files = {}, events = {}, current = {}, changedFiles = {}, fail = {}, graphql = true, moveOnList = null }) {
  const calls = [];
  const labels = new Map(pulls.map((p) => [p.number, p.labels.map((l) => l.name)]));
  const heads = new Map(pulls.map((p) => [p.number, head(p.number)]));
  const open = new Set(pulls.map((p) => p.number));
  let listings = 0;
  const json = (status, body) => ({ status, body });
  const base = `/repos/${REPOSITORY}`;
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (fail[`${method} ${path}`]) return json(fail[`${method} ${path}`], { message: "unavailable" });
    let m;
    if (method === "GET" && (m = new RegExp(`^${base}/pulls\\?state=open&per_page=100&page=(\\d+)$`).exec(path))) {
      const page = Number(m[1]);
      if (page === 1) listings++;
      if (moveOnList && page === 1 && listings === moveOnList.listing) {
        for (const [n, sha] of Object.entries(moveOnList.heads)) heads.set(Number(n), sha);
      }
      const rows = [...open].sort((a, b) => a - b).slice((page - 1) * 100, page * 100).map((n) => ({
        number: n, state: "open", draft: false, head: { sha: heads.get(n) },
        labels: (labels.get(n) ?? []).map((name) => ({ name })),
      }));
      return json(200, rows);
    }
    if (method === "GET" && (m = new RegExp(`^${base}/pulls/(\\d+)$`).exec(path))) {
      const n = Number(m[1]);
      if (!heads.has(n)) return json(404, { message: "Not Found" });
      return json(200, {
        number: n, state: open.has(n) ? "open" : "closed", merged: false, draft: false, head: { sha: heads.get(n) },
        labels: (labels.get(n) ?? []).map((name) => ({ name })),
        changed_files: changedFiles[n] ?? (files[n] ?? []).length,
      });
    }
    if (method === "GET" && (m = new RegExp(`^${base}/pulls/(\\d+)/files\\?per_page=100&page=(\\d+)$`).exec(path))) {
      const page = Number(m[2]);
      return json(200, (files[Number(m[1])] ?? []).slice((page - 1) * 100, page * 100));
    }
    if (method === "GET" && (m = new RegExp(`^${base}/issues/(\\d+)/events\\?per_page=100&page=(\\d+)$`).exec(path))) {
      const page = Number(m[2]);
      return json(200, (events[Number(m[1])] ?? []).slice((page - 1) * 100, page * 100));
    }
    if (method === "POST" && path === "/graphql") {
      if (!graphql) return json(200, { errors: [{ message: "Resource not accessible by integration" }] });
      const repository = {};
      for (const [key, sha] of Object.entries(body.variables)) {
        if (!/^h\d+$/.test(key)) continue;
        const known = current[sha];
        repository[key] = {
          status: known
            ? { context: { state: known.state.toUpperCase(), description: known.description, targetUrl: known.target_url ?? null } }
            : null,
        };
      }
      return json(200, { data: { repository } });
    }
    if (method === "GET" && (m = new RegExp(`^${base}/commits/([0-9a-f]{40})/status\\?per_page=100$`).exec(path))) {
      const known = current[m[1]];
      const statuses = known ? [{ context: CONTEXT, ...known }] : [];
      return json(200, { statuses, total_count: statuses.length });
    }
    if (method === "POST" && (m = new RegExp(`^${base}/statuses/([0-9a-f]{40})$`).exec(path))) {
      current[m[1]] = { state: body.state, description: body.description, target_url: body.target_url };
      return json(201, {});
    }
    if (method === "DELETE" && (m = new RegExp(`^${base}/issues/(\\d+)/labels/([^/]+)$`).exec(path))) {
      const n = Number(m[1]);
      const name = decodeURIComponent(m[2]);
      if (!(labels.get(n) ?? []).includes(name)) return json(404, { message: "Label does not exist" });
      labels.set(n, labels.get(n).filter((l) => l !== name));
      return json(200, []);
    }
    if (method === "POST" && new RegExp(`^${base}/issues/\\d+/comments$`).test(path)) return json(201, {});
    return json(599, { message: `unexpected ${method} ${path}` });
  };
  const writes = () => calls.filter((c) => c.method !== "GET" && c.path !== "/graphql");
  const count = () => ({
    rest: calls.filter((c) => c.method === "GET").length,
    graphql: calls.filter((c) => c.path === "/graphql").length,
    writes: writes().length,
  });
  return { request, calls, current, labels, heads, open, writes, count };
}

const openPull = (number, labelled = false) => ({ number, labels: labelled ? [{ name: LABEL }] : [] });
const fileRows = (...names) => names.map((filename) => ({ filename }));
const labelledEvent = (at, name = LABEL) => ({ event: "labeled", created_at: at, label: { name } });
const payload = (action, number, { labels = [], label } = {}) => ({
  action,
  pull_request: { number, head: { sha: head(number) }, updated_at: T2, labels: labels.map((name) => ({ name })) },
  ...(label ? { label: { name: label } } : {}),
});
const quiet = () => {};
const common = (api) => ({
  request: api.request,
  repository: REPOSITORY,
  log: quiet,
  pause: async () => {},
  now: () => Date.parse("2026-09-29T12:00:00Z"),
});
const evaluateWith = (api, action, number, extra = {}) =>
  evaluate({ ...common(api), eventName: "pull_request_target", payload: payload(action, number, extra), ...extra });
const byHand = (api, extra = {}) => evaluate({ ...common(api), eventName: "workflow_dispatch", payload: {}, ...extra });

/** Fifty open pull requests, #1 and #2 labelled; #3 changes a file of #1. */
function fifty() {
  const pulls = Array.from({ length: 50 }, (_, i) => openPull(i + 1, i < 2));
  const files = Object.fromEntries(pulls.map((p) => [p.number, fileRows(`f${p.number}.ts`)]));
  files[3] = fileRows("f1.ts");
  return fakeApi({ pulls, files, events: { 1: [labelledEvent(T1)], 2: [labelledEvent(T2)] } });
}

describe("the evaluation", () => {
  it("reads no file list while no open pull request carries the label", async () => {
    const api = fakeApi({ pulls: [openPull(1), openPull(2)], files: { 1: fileRows("a.ts"), 2: fileRows("a.ts") } });
    const result = await evaluateWith(api, "opened", 2);
    expect(api.calls.filter((c) => c.path.includes("/files") || /\/pulls\/\d+$/.test(c.path))).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(api.current[head(1)]).toMatchObject({ state: "success", description: NOTHING_HELD });
    expect(api.current[head(2)]).toMatchObject({ state: "success", description: NOTHING_HELD });
  });

  it("writes the context, the state, the description and a link to the run that names the holders", async () => {
    const api = fakeApi({ pulls: [openPull(1)] });
    await evaluateWith(api, "opened", 1, { runUrl: RUN_URL });
    expect(api.writes()).toEqual([
      {
        method: "POST",
        path: `/repos/${REPOSITORY}/statuses/${head(1)}`,
        body: { state: "success", context: CONTEXT, description: NOTHING_HELD, target_url: `${RUN_URL}#holders-${fingerprint([])}` },
      },
    ]);
  });

  it("evaluates the pull request of an event alone, against the holders, and writes its status only", async () => {
    const api = fifty();
    await byHand(api, { runUrl: RUN_URL });
    // By hand: every open pull request, 2 per pull request and 1 more per holder.
    expect(api.count()).toEqual({ rest: 104, graphql: 1, writes: 50 });
    expect(api.current[head(3)]).toMatchObject({ state: "failure", description: "Held by #1: f1.ts" });

    api.calls.length = 0;
    api.heads.set(3, head(1003)); // a push to #3, which carries no label
    const result = await evaluateWith(api, "synchronize", 3, { runUrl: RUN_URL });
    expect(result.target).toMatchObject({ all: false, numbers: [3] });
    expect(api.count()).toEqual({ rest: 10, graphql: 1, writes: 1 });
    expect(api.writes().map((c) => c.path)).toEqual([`/repos/${REPOSITORY}/statuses/${head(1003)}`]);
    expect(api.current[head(1003)]).toMatchObject({ state: "failure", description: "Held by #1: f1.ts" });
  });

  it("an event that changes the holders evaluates every open pull request", async () => {
    const api = fifty();
    await byHand(api, { runUrl: RUN_URL });
    api.calls.length = 0;
    api.labels.set(3, [LABEL]); // #3 labelled after #1: #1 still holds f1.ts against it
    const result = await evaluateWith(api, "labeled", 3, { labels: [LABEL], label: LABEL, runUrl: RUN_URL });
    expect(result.target.all).toBe(true);
    const holders = [
      { number: 1, at: "2026-09-29T08:00:00.000Z", head: head(1) },
      { number: 2, at: "2026-09-29T09:00:00.000Z", head: head(2) },
    ];
    // No labeled event for #3 was listed: its label time is unknown, so it holds nothing.
    expect(api.current[head(3)]).toMatchObject({ state: "failure", description: LABEL_TIME_UNREAD });
    // The holders' statuses carry the fingerprint of the holders they were set against.
    expect(api.current[head(1)].target_url).toBe(`${RUN_URL}#holders-${fingerprint(holders)}`);
  });

  it("finds a head that an evaluation a newer event replaced left without a status", async () => {
    const api = fifty();
    await byHand(api, { runUrl: RUN_URL });
    api.open.add(51);
    api.heads.set(51, head(51)); // opened, and its own evaluation never ran
    const result = await evaluateWith(api, "ready_for_review", 4, { runUrl: RUN_URL });
    expect(result.target).toMatchObject({ all: false, numbers: [4, 51] });
    expect(api.current[head(51)]).toMatchObject({ state: "success", description: SHARES_NOTHING });
  });

  it("evaluates every open pull request when a change of the holders was never evaluated", async () => {
    const api = fifty();
    await byHand(api, { runUrl: RUN_URL });
    api.labels.set(1, []); // #1's label taken off, and that evaluation never ran
    const result = await evaluateWith(api, "opened", 7, { runUrl: RUN_URL });
    expect(result.target.all).toBe(true);
    expect(api.current[head(3)]).toMatchObject({ state: "success", description: SHARES_NOTHING });
  });

  it("renews a status held by a pull request that holds nothing now", async () => {
    const api = fakeApi({
      pulls: [openPull(1, true), openPull(2), openPull(3)],
      files: { 1: fileRows("a.ts"), 2: fileRows("a.ts"), 3: fileRows("c.ts") },
      events: { 1: [labelledEvent(T1)] },
    });
    await byHand(api, { runUrl: RUN_URL });
    expect(api.current[head(2)]).toMatchObject({ state: "failure", description: "Held by #1: a.ts" });
    api.labels.set(1, []); // the last label taken off, and that evaluation never ran
    const result = await evaluateWith(api, "opened", 3, { runUrl: RUN_URL });
    // #2 is held by a pull request that holds nothing now; #1's status still says it carries the label.
    expect(result.target.numbers).toEqual([1, 2, 3]);
    expect(api.current[head(1)]).toMatchObject({ state: "success", description: NOTHING_HELD });
    expect(api.current[head(2)]).toMatchObject({ state: "success", description: NOTHING_HELD });
  });

  it("finds the statuses that a replaced evaluation of a reopened holder left behind", async () => {
    const api = fakeApi({
      pulls: [openPull(1, true), openPull(2), openPull(3)],
      files: { 1: fileRows("a.ts"), 2: fileRows("a.ts"), 3: fileRows("c.ts") },
      events: { 1: [labelledEvent(T1)] },
    });
    await byHand(api, { runUrl: RUN_URL });
    api.open.delete(1); // the only holder closed: every status follows
    await evaluateWith(api, "closed", 1, { labels: [LABEL], runUrl: RUN_URL });
    expect(api.current[head(2)]).toMatchObject({ state: "success", description: NOTHING_HELD });
    api.open.add(1); // reopened, and that evaluation never ran
    const result = await evaluateWith(api, "ready_for_review", 3, { runUrl: RUN_URL });
    expect(result.target.numbers).toEqual([2, 3]);
    expect(api.current[head(2)]).toMatchObject({ state: "failure", description: "Held by #1: a.ts" });
  });

  it("does not write the status of a pull request pushed during the evaluation", async () => {
    const api = fakeApi({ pulls: [openPull(1), openPull(2)], moveOnList: { listing: 2, heads: { 2: head(1002) } } });
    const result = await evaluateWith(api, "opened", 2);
    expect(result.decision.skipped).toEqual([{ number: 2, reason: "its head moved during the evaluation" }]);
    // #1 carried no status yet and is written; #2 is left to the run for its push.
    expect(api.writes().map((c) => c.path)).toEqual([`/repos/${REPOSITORY}/statuses/${head(1)}`]);
  });

  it("counts a renamed file under both its names", async () => {
    const api = fakeApi({
      pulls: [openPull(1, true), openPull(2)],
      files: { 1: fileRows("old/name.ts"), 2: [{ filename: "new/name.ts", previous_filename: "old/name.ts" }] },
      events: { 1: [labelledEvent(T1)] },
    });
    await evaluateWith(api, "opened", 2);
    expect(api.current[head(2)]).toMatchObject({ state: "failure", description: "Held by #1: old/name.ts" });
  });

  it("recognises a listing cut short by the pull request's own changed-files count", async () => {
    const rows = Array.from({ length: 3000 }, (_, i) => ({ filename: `f${i}.ts` }));
    const api = fakeApi({
      pulls: [openPull(1, true), openPull(2)],
      files: { 1: fileRows("a.ts"), 2: rows },
      changedFiles: { 2: 3001 },
      events: { 1: [labelledEvent(T1)] },
    });
    await evaluateWith(api, "opened", 2);
    expect(api.current[head(2)]).toMatchObject({
      state: "failure",
      description: "Its file list could not be read in full: 3000 of 3001 files listed",
    });
    // The platform lists at most 3000 files: thirty pages of a hundred, no more.
    expect(api.calls.filter((c) => c.path.startsWith(`/repos/${REPOSITORY}/pulls/2/files`))).toHaveLength(30);
  });

  it("fails the status of a pull request whose file list could not be read, and says why", async () => {
    const api = fakeApi({
      pulls: [openPull(1, true), openPull(2)],
      files: { 1: fileRows("a.ts"), 2: fileRows("b.ts") },
      events: { 1: [labelledEvent(T1)] },
      fail: { [`GET /repos/${REPOSITORY}/pulls/2/files?per_page=100&page=1`]: 502 },
    });
    await evaluateWith(api, "opened", 2);
    expect(api.current[head(2)]).toMatchObject({
      state: "failure",
      description: "Its file list could not be read in full: a page of the file list could not be read (HTTP 502)",
    });
  });

  it("a labelled pull request whose label time cannot be read holds nothing", async () => {
    const api = fakeApi({
      pulls: [openPull(1, true), openPull(2)],
      files: { 1: fileRows("a.ts"), 2: fileRows("a.ts") },
      events: { 1: [] },
    });
    await evaluateWith(api, "labeled", 1, { labels: [LABEL], label: LABEL });
    expect(api.current[head(1)]).toMatchObject({ state: "failure", description: LABEL_TIME_UNREAD });
    expect(api.current[head(2)]).toMatchObject({ state: "success", description: NOTHING_HELD });
  });

  it("does not write a status the head already carries", async () => {
    const api = fakeApi({ pulls: [openPull(1), openPull(2)] });
    await byHand(api, { runUrl: RUN_URL });
    api.calls.length = 0;
    await byHand(api, { runUrl: RUN_URL });
    expect(api.writes()).toEqual([]);
  });

  it("reads each head's status one by one when the batched read is refused", async () => {
    const api = fakeApi({ pulls: [openPull(1), openPull(2)], graphql: false });
    await byHand(api, { runUrl: RUN_URL });
    api.calls.length = 0;
    api.heads.set(2, head(1002));
    await evaluateWith(api, "synchronize", 2, { runUrl: RUN_URL });
    expect(api.calls.filter((c) => c.path.endsWith("/status?per_page=100"))).toHaveLength(2);
    expect(api.writes().map((c) => c.path)).toEqual([`/repos/${REPOSITORY}/statuses/${head(1002)}`]);
  });

  it("a closed pull request holds nothing even while the listing still shows it open", async () => {
    const api = fakeApi({
      pulls: [openPull(1, true), openPull(2)],
      files: { 1: fileRows("a.ts"), 2: fileRows("a.ts") },
      events: { 1: [labelledEvent(T1)] },
    });
    await evaluateWith(api, "closed", 1, { labels: [LABEL] });
    expect(api.current[head(2)]).toMatchObject({ state: "success", description: NOTHING_HELD });
    expect(api.current[head(1)]).toBeUndefined();
  });

  it("after a push to a labelled pull request its hold has ended, even while the label is still on", async () => {
    const api = fakeApi({
      pulls: [openPull(1, true), openPull(2)],
      files: { 1: fileRows("a.ts"), 2: fileRows("a.ts") },
      events: { 1: [labelledEvent(T1)] },
    });
    const result = await evaluateWith(api, "synchronize", 1, { labels: [LABEL] });
    expect(result.target.all).toBe(true);
    expect(api.current[head(2)]).toMatchObject({ state: "success", description: NOTHING_HELD });
    // The evaluation takes no label off: the job before it does.
    expect(api.writes().filter((c) => c.method === "DELETE" || c.path.endsWith("/comments"))).toEqual([]);
  });

  it("refuses to run on any other event, and writes nothing", async () => {
    const api = fakeApi({ pulls: [openPull(1)] });
    await expect(evaluateWith(api, "opened", 1, { eventName: "pull_request" })).rejects.toThrow(/pull_request_target/);
    expect(api.calls).toEqual([]);
  });

  it("stops without a status when the open pull requests cannot be listed", async () => {
    const api = fakeApi({
      pulls: [openPull(1)],
      fail: { [`GET /repos/${REPOSITORY}/pulls?state=open&per_page=100&page=1`]: 500 },
    });
    await expect(evaluateWith(api, "opened", 1)).rejects.toThrow(/open pull requests/);
    expect(api.writes()).toEqual([]);
  });

  it("writes nothing in a dry run", async () => {
    const api = fifty();
    const result = await byHand(api, { dryRun: true });
    expect(result.target.all).toBe(true);
    expect(api.writes()).toEqual([]);
  });
});

describe("the scheduled evaluation", () => {
  const scheduledRun = (api, extra = {}) =>
    evaluate({ ...common(api), eventName: "schedule", payload: { schedule: "17 * * * *" }, ...extra });

  it("rewrites the status that a hold now expired held, and the holder's own, and writes nothing else", async () => {
    const api = fakeApi({
      pulls: [openPull(1, true), openPull(2)],
      files: { 1: fileRows("a.ts"), 2: fileRows("a.ts", "b.ts") },
      events: { 1: [labelledEvent(T1)] },
      current: {
        [head(1)]: { state: "success", description: HOLDS },
        [head(2)]: { state: "failure", description: "Held by #1: a.ts" },
      },
    });
    const lines = [];
    const result = await scheduledRun(api, { runUrl: RUN_URL, log: (line) => lines.push(line), now: () => after(T1, 25) });
    expect(result.failures).toEqual([]);
    expect(result.decision.holders).toEqual([]);
    expect(api.writes()).toEqual([
      {
        method: "POST",
        path: `/repos/${REPOSITORY}/statuses/${head(1)}`,
        body: { state: "success", context: CONTEXT, description: EXPIRED_TEXT, target_url: `${RUN_URL}#holders-${fingerprint([])}` },
      },
      {
        method: "POST",
        path: `/repos/${REPOSITORY}/statuses/${head(2)}`,
        body: {
          state: "success",
          context: CONTEXT,
          description: "Hold of #1 expired after 24 hours: a.ts",
          target_url: `${RUN_URL}#holders-${fingerprint([])}`,
        },
      },
    ]);
    // The label stays on: the evaluation takes nothing off and writes no comment.
    expect(api.labels.get(1)).toEqual([LABEL]);
    expect(lines).toContain("files-hold: #1's hold expired: labelled 2026-09-29T08:00:00.000Z, more than 24 hours ago.");
  });

  it("a second scheduled run after an expiry writes nothing", async () => {
    const api = fakeApi({
      pulls: [openPull(1, true), openPull(2), openPull(3)],
      files: { 1: fileRows("a.ts"), 2: fileRows("a.ts"), 3: fileRows("c.ts") },
      events: { 1: [labelledEvent(T1)] },
    });
    await byHand(api, { runUrl: RUN_URL });
    expect(api.current[head(2)]).toMatchObject({ state: "failure", description: "Held by #1: a.ts" });
    await scheduledRun(api, { runUrl: RUN_URL, now: () => after(T1, 25) });
    expect(api.current[head(2)]).toMatchObject({ state: "success", description: "Hold of #1 expired after 24 hours: a.ts" });
    api.calls.length = 0;
    const result = await scheduledRun(api, { runUrl: RUN_URL, now: () => after(T1, 26) });
    expect(result.target).toMatchObject({ all: false, numbers: [] });
    expect(api.writes()).toEqual([]);
  });

  it("with no labelled pull request and fitting statuses, makes 1 REST and 1 GraphQL request and writes nothing", async () => {
    const api = fakeApi({ pulls: Array.from({ length: 50 }, (_, i) => openPull(i + 1)) });
    await byHand(api, { runUrl: RUN_URL });
    api.calls.length = 0;
    const result = await scheduledRun(api, { runUrl: RUN_URL });
    expect(result.target).toMatchObject({ all: false, numbers: [] });
    expect(api.count()).toEqual({ rest: 1, graphql: 1, writes: 0 });
  });

  it("with two labelled pull requests and fitting statuses, reads only the holders and writes nothing", async () => {
    const api = fifty();
    await byHand(api, { runUrl: RUN_URL });
    api.calls.length = 0;
    const result = await scheduledRun(api, { runUrl: RUN_URL });
    expect(result.target).toMatchObject({ all: false, numbers: [] });
    expect(api.count()).toEqual({ rest: 7, graphql: 1, writes: 0 });
  });

  it("the job that takes the label off makes no request on a scheduled run", async () => {
    const api = fakeApi({ pulls: [openPull(1, true)], events: { 1: [labelledEvent(T1)] } });
    const result = await endHold({ ...common(api), eventName: "schedule", payload: { schedule: "17 * * * *" } });
    expect(result).toEqual({ failures: [], endHolds: [] });
    expect(api.calls).toEqual([]);
  });
});

describe("the job that takes the label off", () => {
  const labelledPush = (api, extra = {}) =>
    endHold({ ...common(api), eventName: "pull_request_target", payload: payload("synchronize", 1, { labels: [LABEL] }), ...extra });
  const pushed = (events) =>
    fakeApi({ pulls: [openPull(1, true), openPull(2)], files: { 1: fileRows("a.ts"), 2: fileRows("a.ts") }, events: { 1: events } });

  it("a push to a labelled pull request takes the label off and writes one comment", async () => {
    const api = pushed([labelledEvent(T1)]);
    const result = await labelledPush(api);
    expect(result.failures).toEqual([]);
    expect(api.labels.get(1)).toEqual([]);
    const comments = api.writes().filter((c) => c.path.endsWith("/comments"));
    expect(comments).toHaveLength(1);
    expect(comments[0].path).toBe(`/repos/${REPOSITORY}/issues/1/comments`);
    expect(comments[0].body.body).toContain(LABEL);
    expect(comments[0].body.body).toContain(head(1).slice(0, 7));
    expect(api.count()).toEqual({ rest: 2, graphql: 0, writes: 2 });
  });

  it("writes no comment when the label is already off", async () => {
    const api = fakeApi({
      pulls: [openPull(1, true)],
      events: { 1: [labelledEvent(T1)] },
      fail: { [`DELETE /repos/${REPOSITORY}/issues/1/labels/${LABEL}`]: 404 },
    });
    const result = await labelledPush(api);
    expect(result.failures).toEqual([]);
    expect(api.writes().filter((c) => c.path.endsWith("/comments"))).toEqual([]);
  });

  it("leaves a label set after the push", async () => {
    const api = pushed([labelledEvent(T3)]);
    const result = await labelledPush(api);
    expect(result.endHolds).toEqual([]);
    expect(api.writes()).toEqual([]);
    expect(api.labels.get(1)).toEqual([LABEL]);
  });

  it("makes no request for a push to a pull request without the label, or for any other event", async () => {
    const api = pushed([labelledEvent(T1)]);
    await endHold({ ...common(api), eventName: "pull_request_target", payload: payload("synchronize", 2) });
    await endHold({ ...common(api), eventName: "pull_request_target", payload: payload("labeled", 1, { labels: [LABEL], label: LABEL }) });
    await endHold({ ...common(api), eventName: "workflow_dispatch", payload: {} });
    expect(api.calls).toEqual([]);
  });

  it("takes nothing off in a dry run", async () => {
    const api = pushed([labelledEvent(T1)]);
    const result = await labelledPush(api, { dryRun: true });
    expect(result.endHolds).toEqual([{ number: 1, label: LABEL }]);
    expect(api.writes()).toEqual([]);
  });
});
