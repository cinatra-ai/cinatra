/**
 * THE RENDER-OBSERVED HOST-PARITY RATCHET (cinatra#2826, epic #2784 S9m).
 *
 * WHAT WENT WRONG BEFORE. "Every lifecycle card appears on every host" was
 * asserted from DECLARATIONS: a table in an epic, and `lifecycleViewTypesForHost`
 * — a function that ignores its own `host` argument and hands back the same
 * three kinds for all four. Neither one has ever seen a rendered card. An array
 * like that can be edited to pass, and a mount that silently stopped drawing
 * would not move it by one character.
 *
 * WHAT THIS IS INSTEAD. The host set of a kind is whatever a PRODUCTION HOST
 * COMPOSITION really renders, observed two ways and never asserted a third:
 *
 *   `transcript`   — the kind's carriage is put through the SHARED conversation
 *                    column (the `/chat` arm and the embed arm of the same
 *                    component) and the owner ROOT is read off the DOM. This is
 *                    the strongest observation available: transcript in, card
 *                    out, nothing hand-composed in between.
 *   `composition`  — the host mounts its owner directly rather than through the
 *                    transcript (the run card, the review page's gate region).
 *                    The cell counts only when BOTH halves hold: the production
 *                    source really composes that owner inside that host's
 *                    provider (`scanHostCompositionOwners`), AND rendering that
 *                    owner under that host declaration really produces a card
 *                    root. A provider string with nothing inside it is not a
 *                    host, and neither is an owner that draws nothing.
 *
 * NOT AN UNCONDITIONAL 4×4. A cell the product flow never produces is not a
 * target: the shell kinds reach the conversation hosts through the renderable-
 * view registry and are composed nowhere on the run card, so those cells are
 * absent from the ratchet rather than failing in it. What the ratchet refuses is
 * REGRESSION — a kind that loses a host it once reached — and SILENCE: a cell
 * that starts being produced must be recorded rather than appearing unremarked.
 *
 * THE RULED CELLS THAT DO NOT EXIST YET are carried in `owed`, with the slice
 * that lands them. `owed` is a red done-check, not a waiver: a host listed there
 * must NOT be observed, so the day its mount lands the row must be struck or the
 * suite goes red. `chat_thread` is mandatory for every kind — it may sit in
 * `hosts` or in `owed`, never nowhere, and never move back from one to the other.
 *
 * Pure: constants, a text scanner and an evaluator. No DOM, no React, no fs and
 * no server import, so the same authority runs in the chat package's DOM suite,
 * in the root suite, and in the anchor-contract binding.
 */

import {
  LIFECYCLE_CARD_KINDS,
  type LifecycleCardHost,
  type LifecycleCardKind,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";

import { carriageRowFor } from "./held-turn-card-contract";

// ---------------------------------------------------------------------------
// How a cell may be observed
// ---------------------------------------------------------------------------

/** The two observation methods. There is no third, and no "by inspection". */
export const HOST_OBSERVATION_METHODS = Object.freeze(["transcript", "composition"] as const);

export type HostObservationMethod = (typeof HOST_OBSERVATION_METHODS)[number];

/** The host every kind owes a cell for — recorded or explicitly owed. */
export const MANDATORY_HOST: LifecycleCardHost = "chat_thread";

/**
 * The hosts whose cards arrive through the shared conversation column, so their
 * cells are observable end-to-end from a transcript. The other two hosts mount
 * their owner directly and are observed by composition.
 */
export const TRANSCRIPT_HOSTS: readonly LifecycleCardHost[] = Object.freeze([
  "chat_thread",
  "site_widget",
]);

/**
 * The PRODUCTION sources that declare each host, scanned rather than trusted.
 *
 * For a composition host this is where the provider block lives; for a
 * transcript host it is the shared column's own declaration, listed so a reader
 * can see all four in one place and so a host that loses its declaration
 * entirely is visible here rather than only as a missing render.
 */
export const HOST_COMPOSITION_SOURCES: Readonly<
  Record<LifecycleCardHost, readonly string[]>
> = Object.freeze({
  chat_thread: Object.freeze(["packages/chat/src/chat-messages-view.tsx"]),
  site_widget: Object.freeze(["src/app/embed/assistant/embed-assistant-client.tsx"]),
  run_card: Object.freeze([
    "packages/agents/src/agentic-run-panel.tsx",
    "packages/agents/src/instance-screens.tsx",
    "packages/agents/src/orchestrator-stepper-panel.tsx",
    // The run page's SCHEDULE STEP declares its own provider inside the rail
    // row the screen places (cinatra#2788, S9d): plan (A) §7.2 step 5 moved the
    // schedule out of the screen body and into the step rail, so the screen file
    // alone no longer sees every owner this host mounts.
    "packages/agents/src/schedule-rail-step.tsx",
  ]),
  page_gate_region: Object.freeze([
    "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page.tsx",
    // The review page's VERIFICATION region declares its own provider inside
    // the component the page composes (cinatra#2789, S9e), so the page file
    // alone no longer sees every owner this host mounts. A host source list
    // that stops at the route file would read the audit card's gate-region
    // cell as absent and call the loss a regression.
    "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/verification-view.tsx",
    // The review page's SCHEDULE STEP, for the same reason: the schedule left
    // the gate region for the rail (cinatra#2788), and the rail row is where its
    // `page_gate_region` declaration now lives.
    "packages/agents/src/schedule-rail-step.tsx",
  ]),
});

/** The component that declares a host in production. */
export const HOST_PROVIDER_TAG = "LifecycleCardSurfaceProvider";

// ---------------------------------------------------------------------------
// The scanner — which owner does a production file compose under which host?
// ---------------------------------------------------------------------------

/**
 * The owner component tags composed inside `<LifecycleCardSurfaceProvider
 * host="<host>">` blocks of one production source.
 *
 * Deliberately lexical and deliberately narrow. It reads a LITERAL host
 * declaration, because that is the shape the direct-mount hosts use; the two
 * conversation hosts pass their declaration as a prop and are observed from the
 * transcript instead, where a literal would prove nothing anyway.
 *
 * WHAT IT REFUSES TO COUNT: a provider that composes nothing. Adding a provider
 * string is the cheapest possible way to fake a host, and it buys nothing here —
 * the caller still has to render the owner and see a root.
 */
export function scanHostCompositionOwners(source: string, host: LifecycleCardHost): string[] {
  const found = new Set<string>();
  const open = new RegExp(`<${HOST_PROVIDER_TAG}\\b[^>]*host=(?:"|')${host}(?:"|')[^>]*>`, "g");
  const close = `</${HOST_PROVIDER_TAG}>`;
  for (let match = open.exec(source); match !== null; match = open.exec(source)) {
    const bodyStart = match.index + match[0].length;
    const bodyEnd = source.indexOf(close, bodyStart);
    if (bodyEnd === -1) continue;
    const body = source.slice(bodyStart, bodyEnd);
    for (const tag of body.matchAll(/<([A-Z][A-Za-z0-9_]*)\b/g)) {
      found.add(tag[1]!);
    }
  }
  return [...found].sort();
}

/**
 * The component tags that may OWN a kind's root today.
 *
 * Two sources, both production: the ruled owner named by the carriage contract,
 * and whatever the renderable-view registry really dispatches the kind to (the
 * two undrawn kinds still land on the shared shell). Reading the registry rather
 * than restating it means a kind whose registry row is swapped changes what the
 * scan looks for, instead of leaving the scan hunting a component nothing mounts.
 */
export function ownerTagsFor(kind: LifecycleCardKind, registryOwners: Record<string, string>): string[] {
  const tags = new Set<string>([carriageRowFor(kind).owner]);
  const registered = registryOwners[kind];
  if (registered) tags.add(registered);
  return [...tags].sort();
}

/**
 * The registry's `viewType: Component` rows, read off the registry source.
 *
 * The registry is the one dispatch table between a DATA_PART and a card, so its
 * text is the authority on which component owns a kind's root on the two
 * conversation hosts.
 */
export function scanRegistryOwners(source: string): Record<string, string> {
  const owners: Record<string, string> = {};
  for (const kind of LIFECYCLE_CARD_KINDS) {
    const row = new RegExp(`\\n\\s*${kind}:\\s*([A-Z][A-Za-z0-9_]*)\\s*,`).exec(source);
    if (row) owners[kind] = row[1]!;
  }
  return owners;
}

// ---------------------------------------------------------------------------
// The ratchet
// ---------------------------------------------------------------------------

export type HostParityOwedCell = {
  host: LifecycleCardHost;
  /** The slice that lands the mount. An owed cell always names its owner. */
  tracking: string;
};

export type HostParityRatchetRow = {
  /** host → the method that observed it. Both halves are ratcheted. */
  hosts: Readonly<Partial<Record<LifecycleCardHost, HostObservationMethod>>>;
  /** Ruled cells that are NOT production-reachable yet. Must stay unobserved. */
  owed: readonly HostParityOwedCell[];
};

/**
 * THE RATCHET, per kind. Every entry here was read off a rendered card.
 *
 * `artifact_review_gate` is the one kind on all four hosts today: the shared
 * column draws it on both conversation hosts from a transcript, and the run card
 * and the review page's gate region each compose `ReviewGateCard` under their
 * own provider.
 *
 * `trigger_schedule_proposal` joined it with S9d (cinatra#2788): the registry
 * dispatches the DRAWN `ScheduleProposalCard` on both conversation hosts, the
 * run screen composes it above the scheduling form for a run a proposal
 * produced, and the review page composes it in its gate region. The two
 * composition cells are RECORDED here rather than left off — a host set that
 * grows silently is a host set nobody read, which `host-unratcheted` refuses.
 *
 * `recommendation_hold` is the mirror image: it is composed on the run card,
 * and it now draws on the chat thread too — S9b (#2786) landed that mount, so
 * the chat_thread cell moved from `owed` to `hosts` and is RECORDED as a
 * `transcript` observation, read off the shared column rendering a held
 * dispatch turn. The widget cell stays owed by S9f (#2790), which is why this
 * slice consumes the widget row as an observation rather than asserting a card
 * that no branch has landed.
 */
export const LIFECYCLE_HOST_PARITY_RATCHET: Readonly<
  Record<LifecycleCardKind, HostParityRatchetRow>
> = Object.freeze({
  artifact_review_gate: {
    hosts: Object.freeze({
      chat_thread: "transcript",
      site_widget: "transcript",
      run_card: "composition",
      page_gate_region: "composition",
    }),
    owed: Object.freeze([]),
  },
  verification_summary: {
    // S9e (cinatra#2789) draws the audit card once and mounts it on all four
    // hosts: the shared column carries it on both conversation hosts from a
    // transcript, the run screen composes it per verification record the run
    // carries, and the review page composes it in its gate region. Recording
    // only the two conversation cells would leave the two composition cells
    // growing silently, which `host-unratcheted` refuses by design.
    hosts: Object.freeze({
      chat_thread: "transcript",
      site_widget: "transcript",
      run_card: "composition",
      page_gate_region: "composition",
    }),
    owed: Object.freeze([]),
  },
  trigger_schedule_proposal: {
    hosts: Object.freeze({
      chat_thread: "transcript",
      site_widget: "transcript",
      run_card: "composition",
      page_gate_region: "composition",
    }),
    owed: Object.freeze([]),
  },
  recommendation_hold: {
    hosts: Object.freeze({ chat_thread: "transcript", run_card: "composition" }),
    owed: Object.freeze([
      { host: "site_widget" as LifecycleCardHost, tracking: "cinatra#2790 (S9f)" },
    ]),
  },
});

/** What a caller observed: kind → host → the method that saw it. */
export type ObservedHostParity = Readonly<
  Partial<Record<LifecycleCardKind, Readonly<Partial<Record<LifecycleCardHost, HostObservationMethod>>>>>
>;

export type HostParityViolation = {
  code:
    | "no-ratchet-row"
    | "host-lost"
    | "method-changed"
    | "host-unratcheted"
    | "owed-cell-observed"
    | "owed-and-recorded"
    | "mandatory-host-missing";
  kind: LifecycleCardKind;
  host?: LifecycleCardHost;
  detail: string;
};

/**
 * Judge an observation against the ratchet. Both directions are refused.
 *
 * DOWN is the regression this exists for: a kind that no longer draws on a host
 * it was recorded on. UP is refused too — a newly reachable cell must be
 * RECORDED, because a host set that grows silently is a host set nobody read.
 */
export function evaluateHostParity({
  observed,
  ratchet = LIFECYCLE_HOST_PARITY_RATCHET,
}: {
  observed: ObservedHostParity;
  ratchet?: Readonly<Record<string, HostParityRatchetRow>>;
}): HostParityViolation[] {
  const violations: HostParityViolation[] = [];
  for (const kind of LIFECYCLE_CARD_KINDS) {
    const row = ratchet[kind];
    if (!row) {
      violations.push({
        code: "no-ratchet-row",
        kind,
        detail: `no ratchet row for "${kind}" — every declared kind carries one`,
      });
      continue;
    }
    const seen = observed[kind] ?? {};
    const owedHosts = row.owed.map((o) => o.host);

    if (!(MANDATORY_HOST in row.hosts) && !owedHosts.includes(MANDATORY_HOST)) {
      violations.push({
        code: "mandatory-host-missing",
        kind,
        host: MANDATORY_HOST,
        detail: `"${kind}" records no ${MANDATORY_HOST} cell and owes none — the conversation host is mandatory`,
      });
    }

    for (const host of owedHosts) {
      if (host in row.hosts) {
        violations.push({
          code: "owed-and-recorded",
          kind,
          host,
          detail: `"${kind}" both records and owes ${host} — a cell is one or the other`,
        });
      }
      if (seen[host] !== undefined) {
        violations.push({
          code: "owed-cell-observed",
          kind,
          host,
          detail:
            `"${kind}" draws on ${host} now — strike the owed row and record the cell ` +
            `(it was owed by ${row.owed.find((o) => o.host === host)?.tracking ?? "an unnamed slice"})`,
        });
      }
    }

    for (const [host, method] of Object.entries(row.hosts) as [
      LifecycleCardHost,
      HostObservationMethod,
    ][]) {
      const observedMethod = seen[host];
      if (observedMethod === undefined) {
        violations.push({
          code: "host-lost",
          kind,
          host,
          detail: `"${kind}" no longer renders on ${host} — the ratchet never shrinks`,
        });
        continue;
      }
      if (observedMethod !== method) {
        violations.push({
          code: "method-changed",
          kind,
          host,
          detail:
            `"${kind}" on ${host} was ratcheted as ${method} and is now observed as ` +
            `${observedMethod} — a weaker observation is a regression too`,
        });
      }
    }

    for (const host of Object.keys(seen) as LifecycleCardHost[]) {
      if (!(host in row.hosts) && !owedHosts.includes(host)) {
        violations.push({
          code: "host-unratcheted",
          kind,
          host,
          detail: `"${kind}" now renders on ${host} — record the cell in the ratchet`,
        });
      }
    }
  }
  return violations;
}

/**
 * The ratchet as the anchor contract records it: a stable, sorted, JSON-safe
 * shape. The anchor digest is taken over this, so a cell added, removed or
 * re-observed by a weaker method moves the digest and forces a re-ratification.
 */
export function hostParityExpectations(
  ratchet: Readonly<Record<string, HostParityRatchetRow>> = LIFECYCLE_HOST_PARITY_RATCHET,
): Record<string, { hosts: Record<string, string>; owed: string[] }> {
  const out: Record<string, { hosts: Record<string, string>; owed: string[] }> = {};
  for (const kind of [...LIFECYCLE_CARD_KINDS].sort()) {
    const row = ratchet[kind];
    if (!row) continue;
    const hosts: Record<string, string> = {};
    for (const host of Object.keys(row.hosts).sort()) {
      hosts[host] = row.hosts[host as LifecycleCardHost]!;
    }
    out[kind] = { hosts, owed: row.owed.map((o) => o.host).sort() };
  }
  return out;
}

// ---------------------------------------------------------------------------
// The ANCHOR CONTRACT's executable half (cinatra#2826, epic #2784 S9m)
// ---------------------------------------------------------------------------

/**
 * The carriage contract's DOM expectations, in the shape the anchor contract
 * records: per kind, the owner component and the anchors a mount owes.
 *
 * Read off the executable contract rather than restated, so the machine-readable
 * anchor file cannot drift from the selectors the suites actually assert — the
 * binding test compares the two and fails on either side moving alone.
 */
export function carriageExpectations(): Record<
  string,
  { owner: string; ownerAnchors: string[]; ruledRootAnchors: string[] }
> {
  const out: Record<string, { owner: string; ownerAnchors: string[]; ruledRootAnchors: string[] }> = {};
  for (const kind of [...LIFECYCLE_CARD_KINDS].sort()) {
    const row = carriageRowFor(kind);
    out[kind] = {
      owner: row.owner,
      ownerAnchors: [...row.ownerAnchors],
      ruledRootAnchors: [...row.ruledRootAnchors],
    };
  }
  return out;
}

/**
 * THE EXECUTABLE DOM EXPECTATIONS the anchor digest is taken over.
 *
 * One value, two readers: the suites execute it, and the acceptance gate hashes
 * the copy recorded beside the design pin. A selector renamed on one side and
 * not the other stops the gate, which is the whole point of a drift alarm.
 */
export function lifecycleAnchorExpectations(): {
  carriage: ReturnType<typeof carriageExpectations>;
  hostParity: ReturnType<typeof hostParityExpectations>;
} {
  return { carriage: carriageExpectations(), hostParity: hostParityExpectations() };
}
