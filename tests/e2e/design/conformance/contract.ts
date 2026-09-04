/**
 * Surface drivers for the design-conformance functional-acceptance suite
 * (cinatra#985).
 *
 * One driver per COVERED manifest surface. A driver binds a manifest surface
 * id to the real component mounted on the conformance harness route
 * (/design-fixtures/conformance) via the stable attribute contract
 * (testid-contract.json) and knows how to assert:
 *
 *   - present:  the surface renders at all,
 *   - fields:   each manifest field renders BOUND to its source-of-truth
 *               value (e.g. name = manifest.displayName, never packageName),
 *   - actions:  each manifest action produces its SPECIFIED outcome through
 *               the real state machinery,
 *   - states:   each required state variant exists (kind:* / loading / error
 *               / empty).
 *
 * A manifest surface with NO driver and NO allowlist entry is a RED — the
 * coverage ratchet (allowlist.json, shrink-only) is the only escape hatch.
 */
import { expect, request as playwrightRequest, test, type Locator, type Page } from "@playwright/test";

import {
  CONFORMANCE_BUTTON_VARIANTS,
  CONFORMANCE_CARD_FIXTURES,
  CONFORMANCE_INSTALL_CONFIG_CALLOUT,
  CONFORMANCE_INSTALL_PANEL_DEFAULT_LABEL,
  CONFORMANCE_INSTALL_PANEL_FIXTURE,
  CONFORMANCE_STATUS_PILL_STATUSES,
  type ConformanceCardFixture,
} from "../../../../src/app/design-fixtures/conformance/fixture-data";
import {
  conformanceRunId,
  SEEDED_CONNECTOR_ALL_COUNT,
  SEEDED_CONNECTOR_CARDS,
  SEEDED_CONNECTOR_CONNECTED_COUNT,
  SEEDED_CONNECTOR_DISCONNECTED_COUNT,
  SEEDED_CONNECTOR_ERROR_SLUG,
  SEEDED_GRID_CARD_COUNT,
  SEEDED_INSTALLED_ACTIVE_COUNT,
  SEEDED_INSTALLED_ALL_COUNT,
  SEEDED_INSTALLED_ARCHIVED_COUNT,
  SEEDED_INSTALLED_LOCKED_COUNT,
  SEEDED_MODAL_FIXTURE,
} from "../../../../src/app/design-fixtures/conformance/seed-data";
import {
  BREADCRUMB_ENTITY_DISPLAY_NAME,
  BREADCRUMB_ENTITY_ID,
  BREADCRUMB_ENTITY_PLACEHOLDER,
} from "../../../../src/app/design-fixtures/conformance/breadcrumb-conformance-seed";
import {
  LIFECYCLE_SUGGESTION_CHIP_FIXTURES,
  type LifecycleSuggestionChipFixture,
  type LifecycleSuggestionChipMount,
} from "../../../../src/app/design-fixtures/conformance/lifecycle-card-fixture-data";
import {
  LIFECYCLE_REVIEW_TARGET_HEADER_FIXTURES,
  LIFECYCLE_REVIEW_TARGET_HEADER_NOW,
  type LifecycleReviewTargetHeaderFixture,
} from "../../../../src/app/design-fixtures/conformance/lifecycle-review-target-header-fixture-data";
// The PRODUCT's own readings, read here so the driver's expectation is derived
// the way the shipped composer derives it and never restated by the test.
import {
  reviewRevisionMarker,
  reviewTargetRowFacts,
  reviewTypeLabel,
} from "../../../../src/lib/artifacts/review-surface-model";
import {
  ARTIFACT_KIND_DISPLAY_ROWS,
  type ArtifactKindDisplay,
  type ArtifactKindDisplaySurfaceId,
} from "./artifact-review-displays";
import {
  LIFECYCLE_CHAT_COMPOSER_MOUNT,
  type LifecycleComposerRowMount,
} from "../../../../src/app/design-fixtures/conformance/lifecycle-composer-fixture-data";
import {
  LIFECYCLE_SCHEDULE_CARD_FIXTURES,
  type LifecycleScheduleCardFixture,
} from "../../../../src/app/design-fixtures/conformance/lifecycle-schedule-card-fixture-data";
import {
  RUN_STEP_RAIL_ROWS,
  SHIPPED_RAIL_ACTION,
  type RunStepKind,
  type RunStepRailRow,
  type RunStepState,
} from "./run-step-rail-family";
import {
  RUN_STEP_RAIL_CONFORMANCE_GATE_POSITIONS,
  RUN_STEP_RAIL_CONFORMANCE_LABELS,
  RUN_STEP_RAIL_CONFORMANCE_PASSED_POSITIONS,
  RUN_STEP_RAIL_CONFORMANCE_PAUSED_POSITION,
  RUN_STEP_RAIL_CONFORMANCE_ROW_KINDS,
  RUN_STEP_RAIL_CONFORMANCE_ROW_STATUSES,
  RUN_STEP_RAIL_CONFORMANCE_SETTLED_DISPOSITION,
  RUN_STEP_RAIL_CONFORMANCE_SETTLED_POSITION,
  RUN_STEP_RAIL_CONFORMANCE_UPCOMING_POSITIONS,
} from "../../../../src/app/design-fixtures/conformance/run-step-rail-conformance-data";
import {
  REVIEW_DECISION_FLOOR,
  REVIEW_DECISION_FLOOR_ROWS,
  type ReviewDecisionFloorRow,
  type ReviewDecisionFloorSurfaceId,
} from "./review-decision-floor";
import {
  LIFECYCLE_DRAWN_CONTROL_MOUNT,
  LIFECYCLE_RESOLVE_FIXTURES,
  LIFECYCLE_RESOLVE_PATH,
  lifecycleResolveAnswer,
  type LifecycleResolveFixture,
} from "../../../../src/app/design-fixtures/conformance/lifecycle-resolve-fixture-data";
import {
  LIFECYCLE_PRESENCE_HOSTS,
  LIFECYCLE_READER_STATES,
  LIFECYCLE_REVIEW_BLOCKED_REASON,
  LIFECYCLE_REVIEW_TARGET_FIXTURE,
  LIFECYCLE_REVIEW_TARGET_TYPE_LABEL,
} from "../../../../src/app/design-fixtures/conformance/lifecycle-one-off-fixture-data";
import {
  CONNECTOR_CONFIG_TAB,
  CONNECTOR_CONFIG_TAB_ERROR_LABEL,
  CONNECTOR_CONFIG_TAB_LOADING_LABEL,
  CONNECTOR_CONNECTION_CONNECTED_COUNT,
  CONNECTOR_CONNECTION_DISCONNECTED_COUNT,
  CONNECTOR_CONNECTION_ROWS,
  CONNECTOR_CONNECTION_ROW_COUNT,
  CONNECTOR_CONNECTIONS_EMPTY_LABEL,
  CONNECTOR_CONNECTIONS_LOADING_LABEL,
  CONNECTOR_MULTI_SETUP_CONFIG,
  CONNECTOR_SETUP_CONFIG,
  CONNECTOR_SETUP_ERROR_LABEL,
  CONNECTOR_SETUP_INSTALL_ID,
  CONNECTOR_SETUP_LOADING_LABEL,
} from "../../../../src/app/design-fixtures/conformance/connector-setup-seed";

export const HARNESS_PATH = "/design-fixtures/conformance";

/**
 * Seeded data-contract harness (cinatra#986): the run id namespaces every
 * DB-seeded fixture row, so retries and parallel shards (sharing the id
 * within one run, differing across runs) cannot cross-contaminate the
 * exact-count assertions. CI pins CINATRA_CONFORMANCE_RUN_ID to the workflow
 * run id + attempt; locally it falls back to "local".
 */
export const RUN_ID = conformanceRunId();
export const SEEDED_HARNESS_PATH = `/design-fixtures/conformance/seeded?run=${RUN_ID}`;
export const SEED_ENDPOINT = "/design-fixtures/conformance/seed";

const SEED_BASE_URL =
  process.env.E2E_DESIGN_BASE_URL ??
  `http://localhost:${Number(process.env.E2E_DESIGN_PORT ?? 3101)}`;

let seedOnce: Promise<void> | undefined;

/**
 * The capability the seed endpoint requires
 * (src/lib/test-support/conformance-seed-fence.ts). The endpoint drives REAL
 * extension-lifecycle writes and is exempt from the sign-in redirect, so the
 * token — not the build shape — is what authorizes this harness. CI mints one
 * per run and hands it to the server and to this process alike; a local run
 * must arm the SAME value in both places before `pnpm test:e2e:design`.
 *
 * Read at call time, never at module load, so a Playwright worker that inherits
 * the value later still sees it.
 */
const SEED_CAPABILITY_ENV = "CINATRA_CONFORMANCE_SEED_TOKEN";

/**
 * Idempotent, converging seed provisioning: POSTs the seed endpoint, which
 * makes the run namespace equal EXACTLY the committed kit (extra/stale rows
 * removed). Memoized per worker; a retry re-runs it and converges again.
 */
export function ensureSeeded(): Promise<void> {
  seedOnce ??= (async () => {
    const capability = process.env[SEED_CAPABILITY_ENV] ?? "";
    if (capability.length === 0) {
      // Named explicitly rather than left to surface as a bare 404: an unarmed
      // capability and a missing route are deliberately indistinguishable to
      // the CALLER, so the harness has to say which one it is looking at.
      throw new Error(
        `seed provisioning cannot run: ${SEED_CAPABILITY_ENV} is unset in this process, so ${SEED_ENDPOINT} answers 404 by design. Arm the SAME value (at least 32 characters) on the server under test and here.`,
      );
    }
    const ctx = await playwrightRequest.newContext({ baseURL: SEED_BASE_URL });
    try {
      const res = await ctx.post(SEED_ENDPOINT, {
        data: { runId: RUN_ID },
        headers: { authorization: `Bearer ${capability}` },
      });
      if (!res.ok()) {
        throw new Error(
          `seed provisioning failed: POST ${SEED_ENDPOINT} → HTTP ${res.status()} ${await res.text()}`,
        );
      }
    } finally {
      await ctx.dispose();
    }
  })();
  return seedOnce;
}

type StateAssert = (page: Page, root: Locator) => Promise<void>;

export type SurfaceDriver = {
  /** Route the surface is mounted on for acceptance. */
  path: string;
  root: (page: Page) => Locator;
  present: (page: Page, root: Locator) => Promise<void>;
  /**
   * `source` names the manifest source-of-truth rule this driver asserts
   * (e.g. "manifest.displayName"). The suite REDs on a driver/manifest source
   * mismatch — a re-pinned manifest re-binding a field cannot false-green
   * against a stale driver (mirrors the action-outcome check).
   */
  fields: Record<string, { source: string; assert: (page: Page, root: Locator) => Promise<void> }>;
  /**
   * Keyed by action NAME. A manifest may annotate the SAME action name twice
   * with DIFFERENT outcomes when it is genuinely polymorphic by species — the
   * notifications spec's whole-card "activate" is `-> navigated` on a
   * notification/approval WITH an href and `-> toggled` on an href-less
   * notification (app-notifications.json, cinatra#2380). An array of driver
   * entries covers that case (the suite matches by `.outcome`); the common
   * single-outcome case stays a bare object for every other driver.
   */
  actions: Record<
    string,
    | { outcome: string; run: (page: Page, root: Locator) => Promise<void> }
    | Array<{ outcome: string; run: (page: Page, root: Locator) => Promise<void> }>
  >;
  states: Record<string, StateAssert>;
  /** Requires the seeded fixture kit (ensureSeeded runs before its tests). */
  seeded?: boolean;
};

/**
 * Click a button inside the CTA slot with hydration retry: a click landing
 * before React hydration is silently swallowed on the production standalone
 * build (same pattern as marketplace-detail-modal.spec.ts), so retry until
 * the expected reaction is observed.
 */
async function clickCtaUntil(
  root: Locator,
  buttonName: string,
  reacted: () => Promise<void>,
): Promise<void> {
  const button = root
    .locator('[data-testid="extension-card-cta"]')
    .getByRole("button", { name: buttonName });
  await expect(async () => {
    await button.click();
    await reacted();
  }).toPass({ timeout: 30_000 });
}

function cardKindState(fixture: ConformanceCardFixture, kind: string): StateAssert {
  return async (_page, root) => {
    const card = root.locator('[data-testid="extension-listing-card"]');
    // Kind binding: the card carries the catalog kind slug, and the §IV
    // publisher line renders the kind label from the same catalog entry.
    await expect(card).toHaveAttribute("data-kind", kind);
    await expect(card.locator('[data-slot="extension-card-publisher"]')).toContainText(
      fixture.kindLabel,
    );
  };
}

function cardDriver(fixture: ConformanceCardFixture): SurfaceDriver {
  const rootSel = `[data-surface-id="${fixture.surfaceId}"]`;

  const driver: SurfaceDriver = {
    path: HARNESS_PATH,
    root: (page) => page.locator(rootSel),
    present: async (_page, root) => {
      await expect(root.locator('[data-testid="extension-listing-card"]')).toBeVisible();
    },
    fields: {
      // name = manifest.displayName — bound to the display name, NEVER the
      // package name (the exact drift the annotated spec forbids).
      name: {
        source: "manifest.displayName",
        assert: async (_page, root) => {
          const name = root.locator('[data-slot="extension-card-name"]');
          await expect(name).toHaveText(fixture.displayName);
          await expect(name).not.toContainText(fixture.packageName);
        },
      },
    },
    actions: {},
    states: {},
  };

  for (const kind of ["agent", "skill", "workflow", "connector", "artifact"] as const) {
    if (fixture.kindSlug === kind) {
      driver.states[`kind:${kind}`] = cardKindState(fixture, kind);
    }
  }

  switch (fixture.surfaceId) {
    case "extension-listing-card-available":
      driver.actions.install = {
        // Outcome "panel-open" (spec §I / §I.1, exemplar corrected in
        // design#114): Install now does NOT submit and does NOT open a popup —
        // it swaps the card's body in place to the install face. This fixture
        // is a CONNECTOR, an install-access-target kind, which is what makes
        // that the real product behaviour here. The panel's own four actions
        // (including the install that actually completes) are the sibling
        // `extension-install-panel` surface's contract, not this one's.
        outcome: "panel-open",
        run: async (page, root) => {
          const cta = root.locator('[data-testid="extension-card-cta"]');
          await expect(cta).toHaveAttribute("data-cta-state", "install");
          const face = await openInstallPanel(root);
          // The header band is carried over and the body is the panel.
          await expect(face.locator('[data-slot="extension-card-name"]')).toBeVisible();
          await expect(face.locator('[data-testid="extension-install-panel-body"]')).toBeVisible();
          // Exactly ONE face is mounted: the idle CTA is gone, not hidden.
          await expect(root.locator('[data-testid="extension-card-cta"]')).toHaveCount(0);
          // No dialog anywhere on the card path.
          await expect(page.locator('[role="dialog"]')).toHaveCount(0);
        },
      };
      break;
    case "extension-listing-card-update":
      driver.actions.update = {
        outcome: "installed-latest",
        run: async (_page, root) => {
          const cta = root.locator('[data-testid="extension-card-cta"]');
          await expect(cta).toHaveAttribute("data-cta-state", "update");
          await clickCtaUntil(root, "Update now", async () => {
            await expect(cta).toHaveAttribute("data-cta-state", "installed", { timeout: 5_000 });
          });
          // Outcome "installed-latest": the resolver input reached the CATALOG
          // version (not merely any installed version).
          await expect(root).toHaveAttribute("data-installed-version", fixture.packageVersion);
        },
      };
      break;
    case "extension-listing-card-restore":
      driver.actions.restore = {
        outcome: "installed",
        run: async (_page, root) => {
          const cta = root.locator('[data-testid="extension-card-cta"]');
          await expect(cta).toHaveAttribute("data-cta-state", "restore");
          await clickCtaUntil(root, "Restore", async () => {
            await expect(cta).toHaveAttribute("data-cta-state", "installed", { timeout: 5_000 });
          });
        },
      };
      break;
    case "extension-listing-card-installing":
      // Required state "loading": the "Installing…" presentation — the REAL
      // pending-aware submit (useFormStatus) mid-flight on a slow harness
      // action (fixture.ctaDelayMs is long enough not to race).
      //
      // This fixture is an ARTIFACT, i.e. an install-access-target kind, so
      // since cinatra#2373 its install runs through the in-card panel: the
      // card's Install now swaps the body in place (it no longer submits), and
      // the busy state belongs to the PANEL's submit. Driving the card's CTA
      // as a submit here would assert a flow the product no longer has.
      driver.states.loading = async (_page, root) => {
        const face = await openInstallPanel(root);
        const submit = face.locator('[data-testid="extension-install-panel-submit"]');
        await expect(async () => {
          await submit.click();
          await expect(
            face.locator('[data-testid="extension-install-panel-submit"][data-pending]'),
          ).toBeVisible({ timeout: 2_000 });
        }).toPass({ timeout: 30_000 });
        await expect(submit).toBeDisabled();
        await expect(submit).toContainText("Installing…");
        // The card's box does not change while the install is in flight —
        // errors and busy states never redraw or grow the panel (spec §I.1).
        await expect(face).toBeVisible();
      };
      break;
    case "extension-listing-card-incompatible":
      // Required state "error": the greyed six-state Incompatible CTA plus
      // the plain footer-meta Incompatible verdict, both derived by the REAL
      // deriveExtensionCompatState from the declared ABI range.
      driver.states.error = async (_page, root) => {
        const cta = root.locator('[data-testid="extension-card-cta"]');
        await expect(cta).toHaveAttribute("data-cta-state", "incompatible");
        await expect(cta.getByRole("button", { name: "Install now" })).toBeDisabled();
        const compat = root.locator('[data-slot="extension-card-compat"]');
        await expect(compat).toHaveAttribute("data-compat-state", "incompatible");
        await expect(compat).toContainText("Incompatible");
      };
      break;
  }

  return driver;
}

// ---------------------------------------------------------------------------
// The SUGGESTION-CHIP family (cinatra#3156, epic #3155 W0)
// ---------------------------------------------------------------------------
//
// One surfaced suggestion has ONE control and TWO drawn states, and the two
// manifest surfaces are the two ends of that one shape. So they are driven by
// one family factory over one fixture list, the same shape `cardDriver` +
// CONFORMANCE_CARD_FIXTURES already give the six extension listing cards. W0
// lands the factory and proves it on one surface; the waves after it add fixture
// rows and nothing else.
//
// EVERY ASPECT DRIVEN HERE IS SHIPPED ON THE DEFAULT BRANCH. The chip's control
// names (`dismiss-suggestion -> dismissed` on an accepted chip,
// `accept-suggestion -> accepted` on a dismissed one) are literals of
// packages/agents/src/review-gate-card.tsx, and testid-contract.json requires
// each of them in that file — so a driver that named a control the product does
// not ship would be RED in scripts/design/check-conformance-testids.mjs before
// any browser opened.
//
// The manifest's actions elsewhere in this drawing that no shipped control
// carries are NOT driven here, and are not approximated through a different
// control either. They are on this wave's surface-readiness list.
//
// THE ARTIFACT-KIND REVIEW CARDS ARE NOT ROWS OF THIS FAMILY YET (cinatra#3157,
// epic #3155 W1). The in-conversation card for an individual artifact kind —
// the email body, the mixed kind, the picture, the slide deck, the dashboard,
// the portlet, the CMS page and the Drupal pointer — declares one floor action
// and the three generic card states apiece, and a field binding each except the
// slide deck, which declares none. None of them is addressable from a
// props-only mount on the default branch today:
// the card draws no DOM before an authorised server resolve, each per-kind
// reading of the target is drawn by a SERVER component inside the card's own
// credentialed island frame, and no first-party control carries the
// continue-review or open-in-cms action the manifest declares. Adding a fixture
// row for one of them is therefore not a fixture-data edit yet — it waits on
// that display and that floor landing. See README.md, "Committed but not yet
// pinned".
//
// Each of those aspects is recorded, with its reason and the pull request that
// lands it where there is one, in surface-readiness.json — and re-proved
// against the tree on every root run by
// scripts/design/__tests__/surface-readiness.test.mjs, so an entry that has
// become false is a RED here rather than a stale note.

/** The chip row of one mounted fixture row. */
function chipRow(root: Locator): Locator {
  return root.locator('[data-conformance-id="suggestion-chips"]');
}

/**
 * One chip, addressed by the MANIFEST'S OWN action name.
 *
 * The shipped attribute is written `"<action> -> <outcome>"`, so this locator
 * cannot resolve at all unless the product ships a control for exactly the
 * action-and-outcome pair the manifest declares. That is deliberate: it is what
 * stops a driver from pressing one control and reporting another one's outcome.
 */
function chipOffering(root: Locator, action: string, outcome: string): Locator {
  return chipRow(root).locator(`[data-action="${action} -> ${outcome}"]`);
}

/**
 * Press until the reaction is observed. Same hydration retry as
 * `clickCtaUntil`: a click that lands before React hydration is silently
 * swallowed on the production standalone build.
 */
async function pressChipUntil(chip: Locator, reacted: () => Promise<void>): Promise<void> {
  await expect(async () => {
    await chip.getByRole("button").click();
    await reacted();
  }).toPass({ timeout: 30_000 });
}

/**
 * The manifest surface each harness mount stands for.
 *
 * It lives HERE, on the test side, rather than on the fixture row, because the
 * suggestion chip's spec anchors may appear as a literal in exactly ONE
 * production module — the card that draws them — and the repository proves that
 * by scanning src and packages. Keyed by the mount union, so a new mount without
 * a manifest surface is a typecheck failure rather than an undefined driver key.
 */
const SUGGESTION_CHIP_MANIFEST_SURFACE: Readonly<
  Record<LifecycleSuggestionChipMount, string>
> = {
  "chip-row-live": "suggestion-accepted",
  "chip-row-dismissed": "suggestion-dismissed",
};

export function suggestionChipDriver(fixture: LifecycleSuggestionChipFixture): SurfaceDriver {
  const rootSel = `[data-surface-id="${fixture.mount}"]`;
  // THE READING THIS ROW ARRIVES IN, and nothing else, is what the family
  // factory is parameterized by (cinatra#3164, epic #3155 W8). A suggestion
  // arrives accepted; a row seeded with the reader's mark already made is that
  // same suggestion one press later. Everything below — which control the chip
  // then offers and what it is named — is read back off the shipped component.
  const arrives = fixture.startsDismissed === true ? "dismissed" : "accepted";
  const moves = arrives === "accepted" ? "dismissed" : "accepted";
  const pressed =
    arrives === "accepted"
      ? { action: "dismiss-suggestion", outcome: "dismissed" }
      : { action: "accept-suggestion", outcome: "accepted" };
  const offeredBack =
    arrives === "accepted"
      ? { action: "accept-suggestion", outcome: "accepted" }
      : { action: "dismiss-suggestion", outcome: "dismissed" };

  return {
    path: HARNESS_PATH,
    root: (page) => page.locator(rootSel),
    present: async (_page, root) => {
      const row = chipRow(root);
      await expect(row).toBeVisible();
      // LIVE, not the recorded or the read-only partition: this reader may mark.
      await expect(row).toHaveAttribute("data-suggestion-chips-mode", "live");
      // The chip is drawn in the reading its marks put it in — two states and no
      // third, so the other one is not on screen at all.
      const drawn = row.locator(`[data-conformance-id="suggestion-${arrives}"]`);
      await expect(drawn).toBeVisible();
      await expect(drawn).toHaveAttribute("data-suggestion-state", arrives);
      await expect(drawn).toContainText(fixture.suggestion.label);
      await expect(row.locator(`[data-conformance-id="suggestion-${moves}"]`)).toHaveCount(0);
    },
    fields: {},
    actions: {
      // The chip's ONE control in this reading. The press is the REAL chip
      // button and every drawn consequence — the state it moves to, the control
      // it then offers, the name of that control — is computed by the shipped
      // component from the reader's local marks.
      [pressed.action]: {
        outcome: pressed.outcome,
        run: async (_page, root) => {
          const row = chipRow(root);
          const movedChip = row.locator(`[data-conformance-id="suggestion-${moves}"]`);
          await pressChipUntil(chipOffering(root, pressed.action, pressed.outcome), async () => {
            await expect(movedChip).toBeVisible({ timeout: 5_000 });
          });
          await expect(movedChip).toHaveAttribute("data-suggestion-state", moves);
          // ONE control per suggestion, and the toggle is its own inverse: the
          // reading it arrived in is gone and the same chip offers the way back.
          await expect(row.locator(`[data-conformance-id="suggestion-${arrives}"]`)).toHaveCount(0);
          await expect(chipOffering(root, offeredBack.action, offeredBack.outcome)).toHaveCount(1);
          // A mark is a MARK, not a submit — the row stays live and the
          // suggestion stays on screen (§VIII: the chips carry no submit).
          await expect(row).toHaveAttribute("data-suggestion-chips-mode", "live");
          await expect(movedChip).toContainText(fixture.suggestion.label);
        },
      },
    },
    states: {},
  };
}


// ---------------------------------------------------------------------------
// The ARTIFACT-KIND card family (cinatra#3157, epic #3155 W1)
// ---------------------------------------------------------------------------
//
// Every artifact kind the drawing draws in a conversation opens the same way.
//
// The rule is worded on the review screen's drawing, §IV (the review target —
// immutable header & representation): "Every target opens with a header that
// names what is under review and fixes it in place: the artifact's display title
// over a mono meta line carrying its type, the pinned representation revision
// (shown as a mono revision id with a pinned marker), and the read-only row facts
// the host authorized — owner level / visibility, MIME, and updated time. The
// header is inert: it exposes no edit control and no revision picker, because the
// target is versioned and frozen."
//
// THIS MANIFEST'S OWN DRAWING draws that same header over every kind, and says in
// so many words that it is the one thing the kinds share. §XIII.1 draws the
// states once over the email body and rules: "Nothing in either drawing is
// particular to email except the panel in the middle: put any other review
// target's display, §XIII.2 to §XIII.7, in its place and the turn, the floor, the
// marker and the words around them are unchanged." Each kind section after it
// "draws its rendering alone".
//
// So the kinds differ BELOW that line and are identical on it, and they are one
// family over one fixture list — the same shape `cardDriver` and
// `suggestionChipDriver` already give their families. A later wave adds rows.
//
// WHAT THIS FAMILY ASSERTS, AND WHAT IT DELIBERATELY DOES NOT.
//
//   • It asserts §IV per kind against the SHIPPED CHAIN: the title, the type tag
//     (attribute AND visible text, both derived by the product's own
//     `reviewTypeLabel` from the row's type id), the type id on the meta line,
//     the pinned revision (addressed by the exact id, read as the elided marker
//     the shipped `reviewRevisionMarker` rule produces) with its pinned marker,
//     each authorized row fact as the product's own `reviewTargetRowFacts`
//     composes it from the stored row, and the inertness — no control, no link,
//     no revision picker anywhere inside it.
//
//     THE FIXTURE SEEDS THE ARTIFACT, NOT THE READING. A row carries only what a
//     stored artifact row carries; both readings the header draws over it are
//     composed by the two product functions the server-side composer calls. That
//     is what keeps this a driver and not an echo test: a fixture that named a
//     finished fact could assert a line the shipped composer cannot produce, and
//     the assertion would pass on the component printing its own props back.
//
//   • It does NOT assert the plural ORDERING of several pinned targets. Every
//     surface of this wave pins one target: the mixed-kind gate draws the same
//     artifact at the same revision under two content forms, and target
//     normalization (src/lib/artifacts/artifact-review-target.ts) treats that as
//     one target, so seeding two would seed a gate the product does not compose.
//     Reported with it: `ReviewTargetHeaders` keys its list on
//     `${revisionId}:${objectType}` alone (packages/agents/src/review-gate-card.tsx),
//     which omits the artifact id that is part of a target's identity, so two
//     distinct artifacts sharing a type and a revision string would collide.
//     That is a product change, not a drivers-wave change; it is on the wave's
//     readiness list with the ordering reading that would exercise it.
//
//   • TWO DRAWN READINGS IT REPORTS RATHER THAN ASSERTS, because the shipped
//     composer has no reading for them: the scope pair's CASING (the drawing
//     prints "Team · Private"; `reviewTargetRowFacts` returns the row's stored
//     values verbatim, in lower case), and the CMS page's PLATFORM and page
//     ADDRESS (its drawn identity line carries both; the composer composes owner
//     level, visibility, MIME and updated time for every kind alike). Asserting
//     either against a hand-written fixture fact would report conformance the
//     product does not have.
//
//   • It declares NO field driver. Every one of these surfaces binds its field
//     to a `representation.*` source — the email body, the content form, the
//     capture URL, the pinned configuration, the portlet entry — and the
//     representation is server-rendered inside the island document, which ships
//     no per-kind rendering on the default branch. An unshipped binding is on
//     this wave's readiness list, not approximated through the header.
//
//   • It declares NO action driver. Six of these surfaces declare
//     `continue-review -> resolved` as their only action and no shipped control
//     carries it (open pull request #3100 is the one that lands it, and it lands
//     the name `regenerate-review -> changes-requested`, which has to be
//     reconciled with the manifest before either can be driven at all). The CMS
//     page declares `open-in-cms -> cms-opened` instead, which the drawing puts
//     UNDER the representation rather than in the header, and which no shipped
//     control carries anywhere.
//
//   • It declares NO state driver. `loading` and `error` are the island's two
//     non-loaded readings, drawn by `ReviewTargetIsland`, which is not exported
//     and frames a real document; driving them would need a harness mount this
//     wave does not build and a src this wave will not invent.
//
// THE ONE SURFACE OF THIS WAVE THE FAMILY DOES NOT TAKE.
// `drupal-pointer-never-a-review-target` is drawn as a page and never as a
// review: "It is not pinnable and it is never a review target: no gate opens on
// it and no floor is ever drawn beneath it." Its drawn identity line carries
// `not pinnable` exactly where every other kind's carries `revision … · pinned`,
// and the shipped header has no such reading — it draws the pinned marker
// unconditionally. Putting the pointer through this family would therefore assert
// a pinned header the drawing says the pointer never has, so it stays unmapped
// this wave rather than mapped falsely, and no allowlist entry is added for it
// either (the ratchet is shrink-only, and a whole-surface exemption is exactly
// what this epic refuses).
//
// Under the committed-but-unpinned rule (cinatra#3156) an aspect no wave has
// landed simply has no test, and the pin is exactly what this epic withholds
// until every one of them does.

/** The one header the shipped card draws per pinned target. */
function targetHeaders(root: Locator): Locator {
  return root.locator('[data-conformance-id="review-target-header"]');
}

export function reviewTargetHeaderDriver(
  fixture: LifecycleReviewTargetHeaderFixture,
): SurfaceDriver {
  const rootSel = `[data-surface-id="${fixture.surfaceId}"]`;

  return {
    path: HARNESS_PATH,
    root: (page) => page.locator(rootSel),
    present: async (_page, root) => {
      const headers = targetHeaders(root);
      // ONE HEADER PER PINNED TARGET, in gate order. Every row of this wave
      // pins one target; the plural ordering reading is on the readiness list
      // (see the fixture type's own note) rather than seeded with a target the
      // drawing does not draw.
      await expect(headers).toHaveCount(fixture.headers.length);
      const now = new Date(LIFECYCLE_REVIEW_TARGET_HEADER_NOW);

      for (const [index, seed] of fixture.headers.entries()) {
        const header = headers.nth(index);
        // "the artifact's display title …"
        await expect(header).toContainText(seed.title);
        // "… over a mono meta line carrying its type …". The TAG carries the
        // label, the line carries the id. The expected label is derived by the
        // PRODUCT's own `reviewTypeLabel` from the row's type id — the call the
        // server-side composer makes — so a harness that ever worded a label of
        // its own is red here, and the tag is asserted on BOTH readings: the
        // attribute value and the text a reader actually sees.
        const tag = header.locator("[data-review-target-type]");
        await expect(tag).toHaveCount(1);
        await expect(tag).toHaveAttribute(
          "data-review-target-type",
          reviewTypeLabel(seed.objectType),
        );
        await expect(tag).toHaveText(reviewTypeLabel(seed.objectType));
        await expect(header).toContainText(seed.objectType);
        // "… the pinned representation revision (shown as a mono revision id
        // with a pinned marker) …". Addressed by the EXACT revision the gate
        // pinned, so a card drawing a different revision cannot resolve at all,
        // while the VISIBLE reading is the elided one the product draws — the
        // shipped truncation rule (`reviewRevisionMarker`), not the full id,
        // which for an id past the bound is not what the header prints at all.
        const revision = header.locator(
          `[data-review-target-revision="${seed.revisionId}"]`,
        );
        await expect(revision).toHaveCount(1);
        await expect(revision).toHaveText(
          `revision ${reviewRevisionMarker(seed.revisionId).short}`,
        );
        await expect(header).toContainText("· pinned");
        // "… and the read-only row facts the host authorized". The expected
        // line is composed from the row by the PRODUCT's own
        // `reviewTargetRowFacts` against the harness's fixed instant, so this
        // asserts the shipped chain composer → component and not a fact the
        // fixture handed the component to print back.
        for (const fact of reviewTargetRowFacts(seed.row, now)) {
          await expect(header).toContainText(fact);
        }
        // "The header is inert: it exposes no edit control and no revision
        // picker, because the target is versioned and frozen."
        await expect(header.locator("button, a, input, select, textarea")).toHaveCount(0);
      }
    },
    fields: {},
    actions: {},
    states: {},
  };
}

// ---------------------------------------------------------------------------
// The SCHEDULE-CARD family (cinatra#3161, epic #3155 W5)
// ---------------------------------------------------------------------------
//
// "One card, five readings, and never a second card": what changes across the
// schedule card's life is the floor beneath the rows and whether the rows still
// take a change. The drawing annotates each reading TWICE — once for the card,
// once for the floor beneath it — so nine manifest surfaces stand for five
// readings, and one family factory over one fixture list drives all nine, the
// same shape `cardDriver` and `suggestionChipDriver` already give.
//
// EVERY CONTROL PRESSED HERE IS THE SHIPPED ONE. `confirm-schedule-proposal`,
// `save-schedule-changes` and `cancel-trigger-schedule` are literals of
// packages/agents/src/schedule-proposal-card.tsx and testid-contract.json
// requires each of them in that file, so a driver naming a control the product
// does not ship is RED in scripts/design/check-conformance-testids.mjs before a
// browser opens. This is the same binding the PINNED `scheduling-step-configured`
// surface already uses for the same two operations: the driver keys on the
// manifest's action name (`save-schedule` / `cancel-schedule`), the shipped
// attribute value is pinned in the contract, and the two are reconciled by the
// suite rather than by a rename — the shipped values are addressed by a ratified
// capture record and by the one-card gate's anchor set, and a record of what was
// counted on a screen is not a thing a driver wave may rewrite.
//
// WHAT A STATE VARIANT MEANS ON THIS CARD. The drawing gives these surfaces no
// fields and no kinds; the two variants it annotates are the two things the card
// draws AROUND a decision, and both are the component's own: `loading` is the
// in-flight floor between a press and an answer ("Confirming…" / "Saving…", the
// control dead), and `error` is the refusal line the card draws when the answer
// refuses. One annotated variant has no counterpart in the product and is NOT
// approximated through another one — see the wave's readiness list.

/** The drawn card of one mounted fixture row. */
function scheduleCard(root: Locator): Locator {
  return root.locator('[data-conformance-id="schedule-proposal-card"]');
}

/** The floor beneath the rows — absent by design on a spent one-off. */
function scheduleFloor(root: Locator): Locator {
  return scheduleCard(root).locator('[data-conformance-id="schedule-proposal-floor"]');
}

/**
 * What the SHIPPED card asked the decision endpoint for, in order.
 *
 * A card's own part of an outcome is the request it composes: a proposal is
 * single-use, so an unedited Confirm spends the ref it was drawn from while an
 * edited one re-proposes first, and an expired token can never take a bare
 * confirm at all. The harness records what the component asked for under
 * `data-harness-id` — deliberately not a `data-conformance-id`, because it is
 * the checker's instrument and not an anchor of the drawing.
 */
function decisionRoads(root: Locator): Locator {
  return root.locator('[data-harness-id="schedule-decision-log"] [data-harness-road]');
}

/**
 * Press until the reaction is observed. Same hydration retry as
 * `clickCtaUntil`: a click that lands before React hydration is silently
 * swallowed on the production standalone build.
 */
async function pressScheduleUntil(control: Locator, reacted: () => Promise<void>): Promise<void> {
  await expect(async () => {
    await control.click();
    await reacted();
  }).toPass({ timeout: 30_000 });
}

/** Change a row, so the settled floor has something to save. The rows are
 *  editable as they stand — there is no step to press before they take a
 *  change. */
async function changeARow(root: Locator): Promise<void> {
  const immediate = scheduleCard(root).locator('[data-schedule-option="immediate"]');
  // THE SAME HYDRATION RETRY THE PRESSES TAKE, and for a worse failure. A click
  // that lands before React hydration is silently swallowed, and a swallowed
  // row click is INVISIBLE: the rows keep drawing, the draft never moves, and
  // the floor stays correctly quiet — so the next assertion reads as the
  // product refusing to enable Save when nothing ever reached it. The
  // post-condition is the PRODUCT's own mark of the chosen row, never a wait,
  // and pressing an already-chosen row is idempotent.
  await expect(async () => {
    await immediate.getByRole("button").click();
    await expect(immediate).toHaveAttribute("data-chosen", "true", { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

/** What the reader's rows ARE after `changeARow` — the whole payload, so a
 *  regression that carries some other non-null schedule cannot pass for
 *  carrying the reader's. */
const EDITED_ROWS = JSON.stringify({ kind: "immediate" });

const CONFIRM_CONTROL = '[data-action="confirm-schedule-proposal"]';
const SAVE_CONTROL = '[data-action="save-schedule-changes"]';

export function scheduleCardDriver(fixture: LifecycleScheduleCardFixture): SurfaceDriver {
  const rootSel = `[data-surface-id="${fixture.surfaceId}"]`;
  const reading = fixture.reading;

  const driver: SurfaceDriver = {
    path: HARNESS_PATH,
    root: (page) => page.locator(rootSel),
    present: async (_page, root) => {
      const card = scheduleCard(root);
      await expect(card).toBeVisible();
      // ONE card, drawn on the host that declared itself, in the phase the
      // resolved body selects — never a second card and never a summary box.
      await expect(card).toHaveAttribute("data-lifecycle-card", "trigger_schedule_proposal");
      await expect(card).toHaveAttribute("data-lifecycle-card-host", "chat_thread");
      await expect(card).toHaveAttribute("data-lifecycle-card-phase", fixture.body.phase);
      // "the rows are the reading": every reading draws the standard scheduling
      // step and its estimated-duration line, and nothing stands above them.
      await expect(card.locator('[data-conformance-id="schedule-option-rows"]')).toBeVisible();
      await expect(card.getByText("When should this run?")).toBeVisible();

      // "The line is the only thing the expired reading adds."
      const expiredLine = card.locator('[data-conformance-id="schedule-proposal-expired"]');
      await expect(expiredLine).toHaveCount(reading === "expired" ? 1 : 0);

      if (reading === "fired") {
        // "the card carries no floor at all: no hairline, no button, nothing to
        // press" — the rows go read-only and simply stand.
        await expect(scheduleFloor(root)).toHaveCount(0);
        await expect(card.locator(SAVE_CONTROL)).toHaveCount(0);
        await expect(card.locator(CONFIRM_CONTROL)).toHaveCount(0);
        for (const control of await card.getByRole("button").all()) {
          await expect(control).toBeDisabled();
        }
        // "read-only" is the WHOLE row, not only the things that look like
        // buttons: the chosen one-off row owns date and time fields, and a
        // spent card that still took a change there would be offering an edit
        // it can never save.
        for (const field of await card.locator('input, [role="combobox"]').all()) {
          await expect(field).toBeDisabled();
        }
        return;
      }

      await expect(scheduleFloor(root)).toBeVisible();
      if (reading === "first-shown" || reading === "expired") {
        // "the floor is Confirm. It is the only control: there is no Adjust".
        await expect(scheduleFloor(root).locator(CONFIRM_CONTROL)).toBeVisible();
        await expect(scheduleFloor(root).locator(SAVE_CONTROL)).toHaveCount(0);
      } else {
        // "the floor becomes Save changes — quiet until a row is actually
        // changed, because there is nothing to save until then."
        await expect(scheduleFloor(root).locator(SAVE_CONTROL)).toBeVisible();
        await expect(scheduleFloor(root).locator(SAVE_CONTROL)).toBeDisabled();
        await expect(scheduleFloor(root).locator(CONFIRM_CONTROL)).toHaveCount(0);
      }
      // "It is the only control." The floor carries exactly ONE thing to press
      // on every drawn reading — this is also what pins the deferral named
      // below: Cancel schedule is absent in the conversation rather than
      // disabled, on the fired-recurring floor as much as anywhere else.
      await expect(scheduleFloor(root).getByRole("button")).toHaveCount(1);
      await expect(
        scheduleFloor(root).locator('[data-action="cancel-trigger-schedule"]'),
      ).toHaveCount(0);
    },
    fields: {},
    actions: {},
    states: {},
  };

  switch (fixture.surfaceId) {
    case "schedule-card-first-shown":
      // The in-flight floor: the word and the dead control are both computed by
      // the component while its answer is outstanding.
      driver.states.loading = async (_page, root) => {
        const confirm = scheduleFloor(root).locator(CONFIRM_CONTROL);
        await pressScheduleUntil(confirm, async () => {
          await expect(confirm).toContainText("Confirming…", { timeout: 2_000 });
        });
        await expect(confirm).toBeDisabled();
      };
      // The refusal, said on the card rather than swallowed. It never reveals
      // whether a token was expired, foreign or forged.
      driver.states.error = async (_page, root) => {
        const confirm = scheduleFloor(root).locator(CONFIRM_CONTROL);
        const refusal = scheduleFloor(root).locator(
          '[data-conformance-id="schedule-proposal-refusal"]',
        );
        await pressScheduleUntil(confirm, async () => {
          await expect(refusal).toBeVisible({ timeout: 5_000 });
        });
        await expect(refusal).toHaveAttribute("role", "status");
        // The card stays exactly where it is: a refused decision is not an
        // absent card, and the rows still take a change.
        await expect(scheduleCard(root)).toBeVisible();
        await expect(confirm).toBeEnabled();
      };
      break;

    case "schedule-card-confirm-floor":
      driver.actions["confirm-schedule"] = {
        outcome: "scheduled",
        run: async (_page, root) => {
          const confirm = scheduleFloor(root).locator(CONFIRM_CONTROL);
          await pressScheduleUntil(confirm, async () => {
            await expect(decisionRoads(root)).toHaveCount(1, { timeout: 5_000 });
          });
          // "On this card nothing exists until the reader confirms": the press
          // asks for exactly one confirm, on the ref the card was drawn from,
          // and an UNEDITED proposal carries no rows with it.
          await expect(decisionRoads(root)).toHaveAttribute("data-harness-road", "confirm");
          await expect(decisionRoads(root)).toHaveAttribute("data-harness-carried-rows", "none");
          // The floor was in flight and the answer landed on the card, not on a
          // refusal: the schedule is armed and the card says nothing else.
          await expect(
            scheduleFloor(root).locator('[data-conformance-id="schedule-proposal-refusal"]'),
          ).toHaveCount(0);
          await expect(confirm).toContainText("Confirm");
        },
      };
      break;

    case "schedule-card-configured":
    case "schedule-card-fired-recurring":
      driver.states.loading = async (_page, root) => {
        await changeARow(root);
        const save = scheduleFloor(root).locator(SAVE_CONTROL);
        await expect(save).toBeEnabled();
        await pressScheduleUntil(save, async () => {
          await expect(save).toContainText("Saving…", { timeout: 2_000 });
        });
        await expect(save).toBeDisabled();
      };
      break;

    case "schedule-card-save-floor":
    case "schedule-card-fired-recurring-floor":
      // NO `cancel-schedule` DRIVER, AND NOT BECAUSE ONE WAS SKIPPED. The
      // fired-recurring floor is annotated with a SECOND act, and the shipped
      // card draws that control only where the plan puts it: Cancel schedule is
      // the page step's and the run card's, never the conversation's, so on the
      // in-thread host the card draws no such control at all — absent by rule
      // rather than disabled. A driver wave cannot settle that: either the
      // drawing gives the in-conversation floor an act the product deliberately
      // withholds there, or the product withholds an act the drawing grants. It
      // is named on the wave's readiness list for the drawing to answer, and it
      // is NOT approximated through the run-card host — these nine surfaces are
      // the conversation's readings, and asserting one of them on another host
      // would prove something the drawing never said.
      driver.actions["save-schedule"] = {
        outcome: "rearmed",
        run: async (_page, root) => {
          const save = scheduleFloor(root).locator(SAVE_CONTROL);
          // Quiet until a row is actually changed.
          await expect(save).toBeDisabled();
          await changeARow(root);
          await expect(save).toBeEnabled();
          await pressScheduleUntil(save, async () => {
            await expect(decisionRoads(root)).toHaveCount(1, { timeout: 5_000 });
          });
          // The card carries the READER'S rows on a save — nothing is guessed
          // server-side about what the reader was looking at.
          await expect(decisionRoads(root)).toHaveAttribute("data-harness-road", "save");
          await expect(decisionRoads(root)).toHaveAttribute(
            "data-harness-carried-rows",
            "the-reader-s-rows",
          );
          // AND THEY ARE THE ROWS THE READER ACTUALLY LEFT. "Carried something"
          // is not the claim: a card that posted the schedule it opened on,
          // rather than the changed one, would still carry a non-null payload.
          await expect(decisionRoads(root)).toHaveAttribute("data-harness-rows", EDITED_ROWS);
          // "Changing a row and pressing it re-arms the schedule" — and the card
          // says so in its own words, then goes quiet again because what was
          // saved is what is armed.
          await expect(
            scheduleFloor(root).locator('[data-conformance-id="schedule-saved"]'),
          ).toContainText("Saved — the trigger is re-armed on these rows.");
          await expect(save).toBeDisabled();
        },
      };
      break;

    case "schedule-card-expired":
      driver.states.error = async (_page, root) => {
        const confirm = scheduleFloor(root).locator(CONFIRM_CONTROL);
        const refusal = scheduleFloor(root).locator(
          '[data-conformance-id="schedule-proposal-refusal"]',
        );
        await pressScheduleUntil(confirm, async () => {
          await expect(refusal).toBeVisible({ timeout: 5_000 });
        });
        await expect(refusal).toHaveAttribute("role", "status");
        // "An expired card stays visible, and stays editable": a refusal does
        // not grey it out and does not take the line away.
        await expect(
          scheduleCard(root).locator('[data-conformance-id="schedule-proposal-expired"]'),
        ).toBeVisible();
        await expect(confirm).toBeEnabled();
      };
      break;

    case "schedule-card-expired-floor":
      driver.actions["confirm-schedule"] = {
        outcome: "scheduled",
        run: async (_page, root) => {
          const confirm = scheduleFloor(root).locator(CONFIRM_CONTROL);
          // "change it if you like, then confirm it again" — the expired card's
          // rows still take a change, and the change is what the re-propose has
          // to carry. Confirming an untouched expired card would prove only
          // that SOMETHING travelled.
          await changeARow(root);
          await pressScheduleUntil(confirm, async () => {
            await expect(decisionRoads(root)).toHaveCount(1, { timeout: 5_000 });
          });
          // "Confirm is offered again so the reader can set the schedule from
          // the same card." The expired token is unspendable, so the one press
          // takes the RE-PROPOSE road carrying the reader's rows — a bare
          // confirm on this card could never land.
          await expect(decisionRoads(root)).toHaveAttribute("data-harness-road", "repropose");
          await expect(decisionRoads(root)).toHaveAttribute(
            "data-harness-carried-rows",
            "the-reader-s-rows",
          );
          await expect(decisionRoads(root)).toHaveAttribute("data-harness-rows", EDITED_ROWS);
          await expect(
            scheduleFloor(root).locator('[data-conformance-id="schedule-proposal-refusal"]'),
          ).toHaveCount(0);
          await expect(confirm).toContainText("Confirm");
        },
      };
      break;

    case "schedule-card-fired":
      // No state driver. The one variant this surface annotates is `error`, and
      // a spent one-off has no error presentation to assert: it draws no floor
      // at all, so it has nowhere to draw a refusal line, and it asks nothing
      // that could be refused. It is named on the wave's readiness list rather
      // than approximated through another surface's line.
      break;
  }

  return driver;
}

const STATUS_PILLS_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: (page) => page.locator('[data-surface-id="status-pills"]'),
  present: async (_page, root) => {
    for (const status of CONFORMANCE_STATUS_PILL_STATUSES) {
      await expect(
        root.locator(`[data-slot="status-pill"][data-status="${status}"]`),
      ).toBeVisible();
    }
  },
  fields: {},
  actions: {},
  states: {},
};

const BUTTON_VARIANTS_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: (page) => page.locator('[data-surface-id="button-variants"]'),
  present: async (_page, root) => {
    for (const variant of CONFORMANCE_BUTTON_VARIANTS) {
      await expect(
        root.locator(`[data-slot="button"][data-variant="${variant}"]`),
      ).toBeVisible();
    }
  },
  fields: {},
  actions: {},
  states: {},
};

// ---------------------------------------------------------------------------
// Seeded data-contract drivers (cinatra#986) — surfaces on
// /design-fixtures/conformance/seeded, driven by the seed kit
// (src/app/design-fixtures/conformance/seed-data.ts). Cardinality-bearing
// surfaces assert EXACT counts against the kit (counts of confusable
// collections are pairwise distinct, so counting the wrong collection is a
// RED); name bindings use anti-lookalike seeds (displayName shares no token
// with the package name / slug).
// ---------------------------------------------------------------------------

/** Retry a hydration-sensitive click until `reacted` observes the outcome. */
async function clickUntil(
  target: Locator,
  reacted: () => Promise<void>,
): Promise<void> {
  await expect(async () => {
    await target.click();
    await reacted();
  }).toPass({ timeout: 30_000 });
}

const EXTENSION_LISTING_GRID_DRIVER: SurfaceDriver = {
  path: SEEDED_HARNESS_PATH,
  root: (page) =>
    page.locator('[data-surface-id="extension-listing-grid"][data-variant="populated"]'),
  present: async (_page, root) => {
    await expect(root.locator('[data-testid="marketplace-grid"]')).toBeVisible();
    // EXACT cardinality: the grid renders one item per seeded catalog card —
    // no more (a stray/duplicated source is red), no fewer.
    await expect(
      root.locator('[data-testid="marketplace-grid-item"]:visible'),
    ).toHaveCount(SEEDED_GRID_CARD_COUNT);
  },
  fields: {},
  actions: {},
  states: {
    // Zero catalog entries → the REAL Empty presentation (never a bare grid).
    empty: async (page) => {
      const emptyRoot = page.locator(
        '[data-surface-id="extension-listing-grid"][data-variant="empty"]',
      );
      const empty = emptyRoot.locator('[data-testid="marketplace-grid-empty"]');
      await expect(empty).toBeVisible();
      await expect(empty).toContainText("No extensions available");
      await expect(
        emptyRoot.locator('[data-testid="marketplace-grid-item"]'),
      ).toHaveCount(0);
    },
    // The REAL Suspense fallback (MarketplaceGridLoadingFallback — the same
    // component ExtensionsMarketplaceScreen renders) observed mid-stream over
    // a deliberately slow card source, then resolving to the full grid.
    loading: async (page) => {
      // waitUntil "commit", NOT "domcontentloaded": on a STREAMED dynamic
      // page DOMContentLoaded fires only when the stream closes — i.e. after
      // the delayed source resolved and the fallback was already replaced.
      await page.goto(`${SEEDED_HARNESS_PATH}&variant=loading`, {
        waitUntil: "commit",
      });
      const loadingRoot = page.locator(
        '[data-surface-id="extension-listing-grid"][data-variant="loading"]',
      );
      await expect(
        loadingRoot.locator('[data-testid="marketplace-grid-loading"]'),
      ).toBeVisible();
      await expect(
        loadingRoot.locator('[data-testid="marketplace-grid-item"]:visible'),
      ).toHaveCount(SEEDED_GRID_CARD_COUNT, { timeout: 30_000 });
    },
  },
};

const INSTALLED_LIST_SELECTOR = '[data-slot="installed-extension-card"]';

const INSTALLED_EXTENSIONS_LIST_DRIVER: SurfaceDriver = {
  path: SEEDED_HARNESS_PATH,
  seeded: true,
  root: (page) =>
    page.locator('[data-surface-id="installed-extensions-list"][data-variant="populated"]'),
  present: async (_page, root) => {
    // EXACT cardinality from the LIVE canonical store: the default (active)
    // tab renders one §VI card per seeded active row — archived rows must NOT
    // leak in (distinct counts: 4 active vs 2 archived).
    await expect(root.locator(INSTALLED_LIST_SELECTOR)).toHaveCount(
      SEEDED_INSTALLED_ACTIVE_COUNT,
    );
    await expect(root.locator(`${INSTALLED_LIST_SELECTOR}[data-archived]`)).toHaveCount(0);
  },
  fields: {},
  actions: {},
  states: {
    // An empty namespace (never provisioned) read through the SAME live store
    // path → the REAL §VI ActiveEmptyState.
    empty: async (page) => {
      const emptyRoot = page.locator(
        '[data-surface-id="installed-extensions-list"][data-variant="empty"]',
      );
      const empty = emptyRoot.locator('[data-testid="installed-extensions-empty"]');
      await expect(empty).toBeVisible();
      await expect(empty).toContainText("No active extensions");
      await expect(emptyRoot.locator(INSTALLED_LIST_SELECTOR)).toHaveCount(0);
    },
  },
};

const INSTALLED_EXTENSIONS_FILTER_DRIVER: SurfaceDriver = {
  path: SEEDED_HARNESS_PATH,
  seeded: true,
  root: (page) => page.locator('[data-surface-id="installed-extensions-filter"]'),
  present: async (_page, root) => {
    await expect(
      root.getByRole("combobox", { name: "Filter installed extensions by state" }),
    ).toBeVisible();
  },
  fields: {},
  actions: {
    // The REAL URL-driven server-side status filter: selecting "Archived"
    // pushes ?tab=archived, the server re-renders, and the list shows EXACTLY
    // the seeded archived rows in their §VI archived (greyed) treatment.
    "filter-status": {
      outcome: "filtered",
      run: async (page, root) => {
        const trigger = root.getByRole("combobox", {
          name: "Filter installed extensions by state",
        });
        await clickUntil(trigger, async () => {
          await expect(page.getByRole("option", { name: "Archived" })).toBeVisible({
            timeout: 5_000,
          });
        });
        await page.getByRole("option", { name: "Archived" }).click();
        await expect(page).toHaveURL(/tab=archived/);
        const list = page.locator(
          '[data-surface-id="installed-extensions-list"][data-variant="populated"]',
        );
        await expect(list).toHaveAttribute("data-tab", "archived");
        await expect(list.locator(INSTALLED_LIST_SELECTOR)).toHaveCount(
          SEEDED_INSTALLED_ARCHIVED_COUNT,
        );
        await expect(list.locator(`${INSTALLED_LIST_SELECTOR}[data-archived]`)).toHaveCount(
          SEEDED_INSTALLED_ARCHIVED_COUNT,
        );
      },
    },
  },
  states: {},
};

// installed-extensions-status-views (design#97 spec regen, cinatra#2361): the
// §III.3 normative clauses added around the SAME real filter + list pairing
// covered above — the four-view (All/Active/Locked/Archived) status-filter
// contract cinatra#1571 already implements. The pinned manifest declares no
// fields/actions/states for this surface (it annotates prose clauses, not a
// data-bound widget), so "surface renders" is the ONLY generated assertion;
// written here to actually exercise the real §III.3 contract — default
// landing view, the four-option order, the dedicated Locked view, and the
// All union — rather than a bare presence check.
const INSTALLED_EXTENSIONS_STATUS_VIEWS_DRIVER: SurfaceDriver = {
  path: SEEDED_HARNESS_PATH,
  seeded: true,
  root: (page) => page.locator('[data-surface-id="installed-extensions-status-views"]'),
  present: async (page, root) => {
    const trigger = root.getByRole("combobox", {
      name: "Filter installed extensions by state",
    });
    await expect(trigger).toBeVisible();
    const list = root.locator(
      '[data-surface-id="installed-extensions-list"][data-variant="populated"]',
    );

    // §3.2 — no ?tab= query on load: the default landing view is Active.
    await expect(page).not.toHaveURL(/tab=/);
    await expect(list).toHaveAttribute("data-tab", "active");
    await expect(list.locator(INSTALLED_LIST_SELECTOR)).toHaveCount(
      SEEDED_INSTALLED_ACTIVE_COUNT,
    );

    // §3.1 — exactly four views, in this order: All, Active, Locked, Archived.
    await clickUntil(trigger, async () => {
      await expect(page.getByRole("option", { name: "All" })).toBeVisible({ timeout: 5_000 });
    });
    expect(await page.getByRole("option").allInnerTexts()).toEqual([
      "All",
      "Active",
      "Locked",
      "Archived",
    ]);

    // §3.3 / §3.5 — Locked is its own dedicated view: only the locked row(s),
    // excluded from the default Active view proven above.
    await page.getByRole("option", { name: "Locked" }).click();
    await expect(page).toHaveURL(/tab=locked/);
    await expect(list).toHaveAttribute("data-tab", "locked");
    await expect(list.locator(INSTALLED_LIST_SELECTOR)).toHaveCount(
      SEEDED_INSTALLED_LOCKED_COUNT,
    );

    // §3.3 / §3.4 — All is the union of Active + Locked + Archived; every row
    // appears exactly once (the seeded partition invariant, mirrored in
    // src/app/design-fixtures/conformance/__tests__/seed-partition.test.ts).
    await clickUntil(trigger, async () => {
      await expect(page.getByRole("option", { name: "All" })).toBeVisible({ timeout: 5_000 });
    });
    await page.getByRole("option", { name: "All" }).click();
    await expect(page).toHaveURL(/tab=all/);
    await expect(list).toHaveAttribute("data-tab", "all");
    await expect(list.locator(INSTALLED_LIST_SELECTOR)).toHaveCount(SEEDED_INSTALLED_ALL_COUNT);
    expect(
      SEEDED_INSTALLED_ACTIVE_COUNT + SEEDED_INSTALLED_LOCKED_COUNT + SEEDED_INSTALLED_ARCHIVED_COUNT,
    ).toBe(SEEDED_INSTALLED_ALL_COUNT);
  },
  fields: {},
  actions: {},
  states: {},
};

// ---------------------------------------------------------------------------
// §I connectors-grid family (cinatra#986; RE-SPECIFIED by cinatra#2355 for
// design@3d33cc800 specs/app-connectors.html version 0.7.0).
//
// The seeded harness mounts the REAL ConnectorsClient five times, keyed by
// `data-variant` on the `[data-surface-id="connector-grid"]` wrapper
// (src/app/design-fixtures/conformance/seeded/connector-grid-fixture.tsx):
// `populated` and the four empty-state-matrix cells. Every root below is
// variant-scoped — an unscoped `[data-surface-id="connector-grid"]` would now
// resolve to five elements.
// ---------------------------------------------------------------------------

const CONNECTOR_CARD_SELECTOR = '[data-testid="connector-card"]';
/**
 * The grid's LIST CONTAINER. The All+0 panel REPLACES it (a ternary in
 * ConnectorsClient), so "the panel replaced the grid" is assertable only
 * against the container itself — a zero-card count would also pass against a
 * panel rendered above a still-present empty list.
 */
const CONNECTOR_LIST_SELECTOR = '[data-testid="connectors-grid-list"]';
const CONNECTOR_NAME_SEED = SEEDED_CONNECTOR_CARDS.find(
  (c) => c.connected && !c.probeThrows,
)!;

/** A variant mount of the REAL ConnectorsClient on the seeded harness. */
const connectorGrid = (variant: string) =>
  `[data-surface-id="connector-grid"][data-variant="${variant}"]`;

/** The toolbar toggle group, scoped to ONE mount. */
const connectorFilterGroup = (root: Locator) =>
  root.locator('[aria-label="Filter by connection state"]');

/**
 * Does `url` name the marketplace's CONNECTOR TAB as the place this navigation
 * is going?
 *
 * Two accepted shapes, because the harness is deliberately sessionless:
 *   - the URL IS the destination (`/configuration/marketplace?tab=connector`),
 *     which is what a reader with marketplace access gets; or
 *   - it is the app-wide auth gate's redirect, which preserves the destination
 *     VERBATIM in `?next=`. `/configuration/marketplace` is
 *     `requireAdminSession`-gated and `CINATRA_E2E_SETUP_BYPASS` authorizes the
 *     FIXTURE routes only, so this is the shape the harness actually produces.
 *
 * Both name the same destination, and a CTA pointing anywhere else satisfies
 * neither — so this stays falsifiable while not asserting a session the harness
 * does not have.
 */
function namesMarketplaceConnectorTab(url: URL): boolean {
  if (url.pathname === "/configuration/marketplace") {
    return url.searchParams.get("tab") === "connector";
  }
  return url.searchParams.get("next") === "/configuration/marketplace?tab=connector";
}

/**
 * The install CTA's navigation, asserted the way the manifest states the
 * outcome (`install-more -> marketplace-connector-tab`): the control is a real
 * link to `/configuration/marketplace?tab=connector`, AND clicking it actually
 * leaves the harness for that destination.
 *
 * NOT a `waitForRequest` on a navigation request: this is a Next `<Link>`, so
 * the App Router navigates CLIENT-SIDE and no document navigation request is
 * ever issued (an earlier version of this helper waited for one and timed out).
 * The observable fact is the resulting URL.
 */
async function assertInstallMoreNavigates(page: Page, cta: Locator): Promise<void> {
  await expect(cta).toHaveRole("link");
  await expect(cta).toHaveAttribute("href", "/configuration/marketplace?tab=connector");
  await cta.click();
  await page.waitForURL((url) => namesMarketplaceConnectorTab(url), { timeout: 15_000 });
}

const CONNECTOR_GRID_DRIVER: SurfaceDriver = {
  path: SEEDED_HARNESS_PATH,
  root: (page) => page.locator(connectorGrid("populated")),
  present: async (_page, root) => {
    // EXACT cardinality (RE-SPECIFIED by cinatra#2355): the DEFAULT filter is
    // now "All" (#2357 supersedes #1092's Connected default), so the landing
    // view shows EVERY seeded card — 8, the union of the 3 connected and the
    // 5 disconnected. Those three counts are pairwise-distinct and asserted as
    // a clean partition in
    // src/app/design-fixtures/conformance/__tests__/seed-partition.test.ts, so
    // a grid that silently kept the old default (3) or dropped the fail-soft
    // card (7) is red here.
    await expect(root.locator(CONNECTOR_CARD_SELECTOR)).toHaveCount(
      SEEDED_CONNECTOR_ALL_COUNT,
    );
    // …and the All view is genuinely BOTH buckets, not 8 of one kind.
    await expect(root.locator(`${CONNECTOR_CARD_SELECTOR}[data-connected]`)).toHaveCount(
      SEEDED_CONNECTOR_CONNECTED_COUNT,
    );
    await expect(
      root.locator(`${CONNECTOR_CARD_SELECTOR}:not([data-connected])`),
    ).toHaveCount(SEEDED_CONNECTOR_DISCONNECTED_COUNT);
    // The All segment is the one selected on arrival (spec §I: "All first and
    // selected on arrival"). `data-state` is the attribute Radix sets and the
    // attribute the product's own selected-segment classes key off, so it is
    // the same fact the styling depends on.
    await expect(
      connectorFilterGroup(root).getByRole("radio", { name: "All", exact: true }),
    ).toHaveAttribute("data-state", "on");
  },
  fields: {
    // name = connector.displayName — the manifest displayName, NEVER the slug
    // (anti-lookalike: the seed shares no token between the two).
    name: {
      source: "connector.displayName",
      assert: async (_page, root) => {
        const card = root.locator(
          `${CONNECTOR_CARD_SELECTOR}[data-connector-slug="${CONNECTOR_NAME_SEED.slug}"]`,
        );
        const name = card.locator('[data-slot="connector-card-name"]');
        await expect(name).toHaveText(CONNECTOR_NAME_SEED.displayName);
        await expect(name).not.toContainText(CONNECTOR_NAME_SEED.slug);
      },
    },
  },
  actions: {},
  states: {
    // EMPTY (cinatra#2355 — the `state:empty` allowlist exemption is REMOVED
    // in the same change; the ratchet only shrinks). Until 0.7.0 /connectors
    // had no designed empty presentation at all, which is exactly what the
    // exemption recorded. It does now, and the spec makes it a MATRIX, so the
    // state variant is asserted across all three segments on their own mounts:
    //
    //   All + 0          → the "No connectors to show" panel replaces the grid
    //                      and carries the SINGLE install CTA (the standalone
    //                      bottom button is suppressed — one screen never
    //                      shows the same CTA twice).
    //   All + 0, no access → the SAME panel, its copy ending on "ask an
    //                      administrator" and rendering NO button at all —
    //                      and no "+ Connector" in the toolbar either.
    //   Connected + 0    → the #1092 panel stands (scope-neutral title), and
    //                      because its action is a different one the bottom
    //                      CTA is NOT suppressed.
    //   Disconnected + 0 → no panel at all: a bare list, the CTA remaining.
    empty: async (page) => {
      // --- All + 0, marketplace within reach -------------------------------
      const allEmpty = page.locator(connectorGrid("empty-all"));
      const panel = allEmpty.locator('[data-conformance-id="connector-empty-panel"]');
      await expect(panel).toBeVisible();
      await expect(panel).toHaveAttribute("data-state", "empty");
      await expect(panel).toContainText("No connectors to show");
      // Scope-neutral copy: it never asserts that nothing is INSTALLED — it
      // names all three causes, because cards are actor- AND scope-filtered.
      await expect(panel).toContainText("outside the scope you have selected");
      await expect(panel).toContainText("outside what you are allowed to see");
      // The panel REPLACED the grid — the list container is gone, not merely
      // empty (a panel rendered above an empty <ul> would satisfy a card count
      // of zero but is not what the spec says: "the grid is replaced by a soft
      // panel").
      await expect(allEmpty.locator(CONNECTOR_LIST_SELECTOR)).toHaveCount(0);
      await expect(allEmpty.locator(CONNECTOR_CARD_SELECTOR)).toHaveCount(0);
      // Exactly ONE install CTA on this mount: the panel's own button. The
      // standalone bottom CTA (which carries the conformance id) is suppressed.
      // Counted by TEXT, not by role, so a regression that re-rendered the
      // suppressed CTA as a <button> is still caught.
      await expect(allEmpty.getByText("Install more connectors")).toHaveCount(1);
      await expect(
        allEmpty.locator('[data-conformance-id="connector-install-cta"]'),
      ).toHaveCount(0);

      // --- All + 0, NO marketplace access ----------------------------------
      const noAccess = page.locator(connectorGrid("empty-all-no-access"));
      const noAccessPanel = noAccess.locator(
        '[data-conformance-id="connector-empty-panel"]',
      );
      await expect(noAccessPanel).toBeVisible();
      await expect(noAccessPanel).toContainText("No connectors to show");
      await expect(noAccessPanel).toContainText("ask an administrator for access");
      // No button in the panel, and none in the toolbar either — the pair
      // gating of spec §I ("A control that leads nowhere is never shown.").
      //
      // Asserted ROLE-AGNOSTICALLY: the claim is that no control leading to
      // the marketplace is rendered, so a regression that re-added either
      // affordance as a <button> (or any other element) must be red too. The
      // strongest form is the DESTINATION — nothing on this mount points at
      // the marketplace at all — backed by the two labels.
      await expect(
        noAccess.locator('[href="/configuration/marketplace?tab=connector"]'),
      ).toHaveCount(0);
      await expect(noAccess.getByText("Install more connectors")).toHaveCount(0);
      await expect(noAccess.getByText("Connector", { exact: true })).toHaveCount(0);

      // --- Connected + 0 ---------------------------------------------------
      const connectedEmpty = page.locator(connectorGrid("empty-connected"));
      const connectedToggle = connectorFilterGroup(connectedEmpty).getByRole("radio", {
        name: "Connected",
        exact: true,
      });
      const connectedPanel = connectedEmpty.locator(
        '[data-testid="connectors-connected-empty-panel"]',
      );
      await clickUntil(connectedToggle, async () => {
        await expect(connectedPanel).toBeVisible({ timeout: 5_000 });
      });
      // The 0.7.0 copy: scope-neutral, so NOT the pre-#2353 "No connected
      // services yet".
      await expect(connectedPanel).toContainText("No connected services in this view");
      await expect(connectedPanel).not.toContainText("No connected services yet");
      await expect(
        connectedPanel.getByRole("button", { name: "Connect a service" }),
      ).toBeVisible();
      // NOT suppressed here — the panel's action is a different one.
      await expect(
        connectedEmpty.locator('[data-conformance-id="connector-install-cta"]'),
      ).toBeVisible();

      // --- Disconnected + 0 ------------------------------------------------
      const disconnectedEmpty = page.locator(connectorGrid("empty-disconnected"));
      const disconnectedToggle = connectorFilterGroup(disconnectedEmpty).getByRole(
        "radio",
        { name: "Disconnected", exact: true },
      );
      await clickUntil(disconnectedToggle, async () => {
        await expect(
          disconnectedEmpty.locator(CONNECTOR_CARD_SELECTOR),
        ).toHaveCount(0, { timeout: 5_000 });
      });
      // No panel of either kind — the grid area is simply bare…
      await expect(
        disconnectedEmpty.locator('[data-conformance-id="connector-empty-panel"]'),
      ).toHaveCount(0);
      await expect(
        disconnectedEmpty.locator('[data-testid="connectors-connected-empty-panel"]'),
      ).toHaveCount(0);
      // …the LIST is still there (bare, not replaced — this is what separates
      // "no panel" from "the All+0 treatment")…
      await expect(disconnectedEmpty.locator(CONNECTOR_LIST_SELECTOR)).toHaveCount(1);
      // …and the CTA remains.
      await expect(
        disconnectedEmpty.locator('[data-conformance-id="connector-install-cta"]'),
      ).toBeVisible();
    },
    // The surface's documented error treatment (cinatra#110): the seeded
    // card whose readiness probe THREW was contained by the REAL
    // resolveReadinessFailSoft into the disconnected presentation.
    error: async (_page, root) => {
      const disconnectedToggle = root.getByRole("radio", { name: "Disconnected", exact: true });
      const errorCard = root.locator(
        `${CONNECTOR_CARD_SELECTOR}[data-connector-slug="${SEEDED_CONNECTOR_ERROR_SLUG}"]`,
      );
      await clickUntil(disconnectedToggle, async () => {
        await expect(errorCard).toBeVisible({ timeout: 5_000 });
      });
      await expect(errorCard).not.toHaveAttribute("data-connected", "");
      const badge = errorCard.locator('[data-testid="connector-badge"]');
      await expect(badge).toBeVisible();
      await expect(badge).toHaveAttribute("aria-label", "Not connected");
    },
  },
};

const CONNECTOR_CONNECTION_FILTER_DRIVER: SurfaceDriver = {
  path: SEEDED_HARNESS_PATH,
  root: (page) => page.locator(connectorGrid("populated")),
  present: async (_page, root) => {
    // Attribute selector, not getByRole("group"): the Radix ToggleGroup root
    // carries the aria-label but no group role in the rendered tree.
    const toggleGroup = connectorFilterGroup(root);
    await expect(toggleGroup).toBeVisible();
    // The inventory is THREE segments since cinatra#2355/#2357 (spec §I:
    // "All · Connected · Disconnected, in that order, with All selected on
    // arrival").
    //
    // exact: true throughout — accessible-name matching is case-insensitive
    // SUBSTRING by default, so "Connected" would also match "Disconnected",
    // and "All" would match the scope combobox's "Workspace: All". The
    // toggle-group scope handles the second hazard, `exact` the first; both
    // are kept deliberately.
    const segments = ["All", "Connected", "Disconnected"] as const;
    for (const name of segments) {
      await expect(toggleGroup.getByRole("radio", { name, exact: true })).toBeVisible();
    }
    // …and NOTHING else: a fourth segment would be an unspecified affordance.
    await expect(toggleGroup.getByRole("radio")).toHaveCount(segments.length);
    // ORDER is part of the spec ("in that order"), and it is the reading of
    // the group as one sentence — everything, the connected part of it, the
    // disconnected part of it.
    await expect(toggleGroup.getByRole("radio")).toHaveText([
      /^All$/,
      /^Connected$/,
      /^Disconnected$/,
    ]);
  },
  fields: {},
  actions: {
    // The REAL connection-state ToggleGroup: each selection narrows the grid
    // to EXACTLY the matching seeded set. RE-SPECIFIED by cinatra#2355 as the
    // full THREE-state ROUND-TRIP — 8 (All, the landing view) ⇄ 3 (Connected)
    // ⇄ 5 (Disconnected) ⇄ 8 again. The three counts are pairwise-distinct
    // (seed-partition.test.ts), so a non-filtering binding, a wrong-way
    // binding, or an "all" arm that silently fell through to a status arm all
    // land on a mismatching count. Returning to All at the end proves the
    // pass-all predicate restores the union rather than remembering a subset.
    "filter-connection": {
      outcome: "filtered",
      run: async (_page, root) => {
        const cards = root.locator(CONNECTOR_CARD_SELECTOR);
        const segment = (name: string) =>
          connectorFilterGroup(root).getByRole("radio", { name, exact: true });

        // The landing view is All — the round-trip's start and end point.
        await expect(cards).toHaveCount(SEEDED_CONNECTOR_ALL_COUNT);

        await clickUntil(segment("Connected"), async () => {
          await expect(cards).toHaveCount(SEEDED_CONNECTOR_CONNECTED_COUNT, {
            timeout: 5_000,
          });
        });
        await expect(
          root.locator(`${CONNECTOR_CARD_SELECTOR}[data-connected]`),
        ).toHaveCount(SEEDED_CONNECTOR_CONNECTED_COUNT);

        await clickUntil(segment("Disconnected"), async () => {
          await expect(cards).toHaveCount(SEEDED_CONNECTOR_DISCONNECTED_COUNT, {
            timeout: 5_000,
          });
        });
        await expect(
          root.locator(`${CONNECTOR_CARD_SELECTOR}[data-connected]`),
        ).toHaveCount(0);

        await clickUntil(segment("All"), async () => {
          await expect(cards).toHaveCount(SEEDED_CONNECTOR_ALL_COUNT, {
            timeout: 5_000,
          });
        });
        // Back to the union, both buckets present.
        await expect(
          root.locator(`${CONNECTOR_CARD_SELECTOR}[data-connected]`),
        ).toHaveCount(SEEDED_CONNECTOR_CONNECTED_COUNT);
        await expect(
          root.locator(`${CONNECTOR_CARD_SELECTOR}:not([data-connected])`),
        ).toHaveCount(SEEDED_CONNECTOR_DISCONNECTED_COUNT);
      },
    },
  },
  states: {},
};

// ---------------------------------------------------------------------------
// connector-install-cta (NEW in the 0.7.0 manifest; cinatra#2355 adopts it).
// The page's closing "Install more connectors" button — the outline variant at
// the small size, centred below the grid, no leading glyph. Its ONE annotated
// aspect is the action.
// ---------------------------------------------------------------------------

const CONNECTOR_INSTALL_CTA_DRIVER: SurfaceDriver = {
  path: SEEDED_HARNESS_PATH,
  root: (page) =>
    page.locator(`${connectorGrid("populated")} [data-conformance-id="connector-install-cta"]`),
  present: async (_page, root) => {
    await expect(root).toBeVisible();
    await expect(root).toHaveText("Install more connectors");
    // The spec's variant/size ("the outline variant at the small size"),
    // asserted through the design-system Button's own data hooks rather than
    // by class-string matching.
    await expect(root).toHaveAttribute("data-variant", "outline");
    await expect(root).toHaveAttribute("data-size", "sm");
    // No leading glyph — "the plug family belongs to status".
    await expect(root.locator("svg")).toHaveCount(0);
  },
  fields: {},
  actions: {
    "install-more": {
      outcome: "marketplace-connector-tab",
      run: async (page, root) => {
        await assertInstallMoreNavigates(page, root);
      },
    },
  },
  states: {},
};

// ---------------------------------------------------------------------------
// connector-empty-panel (NEW in the 0.7.0 manifest; cinatra#2355 adopts it).
// The All+0 panel that REPLACES the grid, carrying the single install CTA.
// Rooted on the empty-all mount — the panel does not exist on the populated
// one, by construction.
// ---------------------------------------------------------------------------

const CONNECTOR_EMPTY_PANEL_DRIVER: SurfaceDriver = {
  path: SEEDED_HARNESS_PATH,
  root: (page) =>
    page.locator(`${connectorGrid("empty-all")} [data-conformance-id="connector-empty-panel"]`),
  present: async (_page, root) => {
    await expect(root).toBeVisible();
    await expect(root).toHaveAttribute("data-state", "empty");
    await expect(root).toContainText("No connectors to show");
  },
  fields: {},
  actions: {
    // The panel's own button — the SINGLE CTA in this state. The standalone
    // bottom CTA is suppressed beneath it (asserted in connector-grid's
    // `empty` state driver), so this is not a duplicate of
    // connector-install-cta's action but the other half of the same rule.
    "install-more": {
      outcome: "marketplace-connector-tab",
      run: async (page, root) => {
        await assertInstallMoreNavigates(
          page,
          root.getByRole("link", { name: "Install more connectors" }),
        );
      },
    },
  },
  states: {
    // The panel IS the empty state — it exists only when the All view has zero
    // cards. Its own presence is therefore the assertion, plus the fact that
    // it REPLACED the grid rather than sitting beside it.
    empty: async (page, root) => {
      await expect(root).toBeVisible();
      await expect(root).toHaveAttribute("data-state", "empty");
      // REPLACED, not emptied: the list container is absent (see
      // CONNECTOR_LIST_SELECTOR — a card count of zero would also pass against
      // a panel rendered above a still-present empty grid).
      const mount = page.locator(connectorGrid("empty-all"));
      await expect(mount.locator(CONNECTOR_LIST_SELECTOR)).toHaveCount(0);
      await expect(mount.locator(CONNECTOR_CARD_SELECTOR)).toHaveCount(0);
    },
  },
};

async function openDetailModal(page: Page, root: Locator): Promise<Locator> {
  const dialog = page.getByRole("dialog");
  if (!(await dialog.isVisible().catch(() => false))) {
    await clickUntil(root.getByRole("button", { name: "More details" }), async () => {
      await expect(dialog).toBeVisible({ timeout: 5_000 });
    });
  }
  return dialog;
}

const EXTENSION_DETAIL_MODAL_DRIVER: SurfaceDriver = {
  path: SEEDED_HARNESS_PATH,
  root: (page) => page.locator('[data-surface-id="extension-detail-modal"]'),
  present: async (page, root) => {
    await openDetailModal(page, root);
  },
  fields: {
    // name = manifest.displayName — the §V modal title renders the human
    // display name, never the package slug (anti-lookalike seed).
    name: {
      source: "manifest.displayName",
      assert: async (page, root) => {
        const dialog = await openDetailModal(page, root);
        const name = dialog.locator('[data-slot="marketplace-modal-name"]');
        await expect(name).toHaveText(SEEDED_MODAL_FIXTURE.displayName);
        await expect(name).not.toContainText(SEEDED_MODAL_FIXTURE.packageName);
      },
    },
  },
  // cinatra#2406 (owner ruling): the modal renders no footer, so there is no
  // more install action to drive from here — the modal is details-only.
  actions: {},
  states: {
    "kind:agent": async (page, root) => {
      const dialog = await openDetailModal(page, root);
      await expect(dialog.locator('[data-slot="marketplace-modal-kind"]')).toHaveText(
        SEEDED_MODAL_FIXTURE.kindLabel,
      );
    },
  },
};

// ---------------------------------------------------------------------------
// Post-install "needs configuration" callout (cinatra#1057; surface
// install-config-needs-callout, design#71 specs/app-extensions.html §VI).
// Mounted on the base conformance harness by
// src/app/design-fixtures/conformance/install-config-needs-fixture.tsx, which
// renders the REAL InstalledExtensionCard + NeedsReviewStrip: an agent with an
// unconfigured required CONNECTOR dependency wears the greyed needs-review
// treatment and a bottom strip listing each connector by its displayName,
// deep-linked to that connector's own setup page. Two harness variants:
// `populated` (one unconfigured connector → the strip) and `empty` (all
// configured → no strip, active card).
// ---------------------------------------------------------------------------

const INSTALL_CONFIG_CALLOUT_SLOT = '[data-slot="install-config-needs-callout"]';

const INSTALL_CONFIG_NEEDS_CALLOUT_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: (page) =>
    page.locator(
      '[data-surface-id="install-config-needs-callout"][data-variant="populated"]',
    ),
  present: async (_page, root) => {
    const strip = root.locator(INSTALL_CONFIG_CALLOUT_SLOT);
    await expect(strip).toBeVisible();
    // The spec's centred needs-review framing (design#71 §VI) — never a bare
    // list; the strip is the "Set up connections first:" callout.
    await expect(strip).toContainText("Set up connections first:");
  },
  fields: {
    // name = manifest.displayName — the strip lists each required connector by
    // its human displayName (the SAME name the §I ListingCard + Connectors grid
    // render), NEVER the package name or slug. The fixture's displayName shares
    // no token with either, so the binding cannot false-green on a lookalike.
    name: {
      source: "manifest.displayName",
      assert: async (_page, root) => {
        const nameLink = root.locator(
          `${INSTALL_CONFIG_CALLOUT_SLOT} [data-field="manifest.displayName"]`,
        );
        await expect(nameLink).toHaveText(CONFORMANCE_INSTALL_CONFIG_CALLOUT.connector.displayName);
        await expect(nameLink).not.toContainText(
          CONFORMANCE_INSTALL_CONFIG_CALLOUT.connector.packageName,
        );
        await expect(nameLink).not.toContainText(
          CONFORMANCE_INSTALL_CONFIG_CALLOUT.connector.slug,
        );
      },
    },
  },
  actions: {
    // configure -> connector-setup: the displayName affordance is an actionable
    // link deep-linked to THAT connector's own setup page
    // (/connectors/<vendor>/<slug>/setup). The outcome is a NAVIGATION target,
    // not an in-place mutation (the spec is explicit the strip is a follow-up
    // reminder, never a gate) — so the outcome is proven by the affordance's
    // resolved destination, exactly as the spec depicts it (`<a href=…>`).
    configure: {
      outcome: "connector-setup",
      run: async (_page, root) => {
        const link = root
          .locator(INSTALL_CONFIG_CALLOUT_SLOT)
          .getByRole("link", {
            name: CONFORMANCE_INSTALL_CONFIG_CALLOUT.connector.displayName,
            exact: true,
          });
        await expect(link).toBeVisible();
        await expect(link).toHaveAttribute(
          "href",
          CONFORMANCE_INSTALL_CONFIG_CALLOUT.connector.settingsHref,
        );
      },
    },
  },
  states: {
    // kind:connector — the listed dependency is a CONNECTOR: its setup deep-link
    // resolves under the Connectors surface (/connectors/<vendor>/<slug>/setup),
    // the connector kind's own configuration home. summarizeConfigurationNeeds
    // only ever surfaces required CONNECTOR dependencies, so a callout that
    // renders at all is a connector-kind callout by construction; asserting the
    // route namespace pins that classification.
    "kind:connector": async (_page, root) => {
      const link = root
        .locator(INSTALL_CONFIG_CALLOUT_SLOT)
        .getByRole("link", {
          name: CONFORMANCE_INSTALL_CONFIG_CALLOUT.connector.displayName,
          exact: true,
        });
      await expect(link).toHaveAttribute("href", /^\/connectors\/.+\/setup$/);
    },
    // empty — every required connector configured: the card returns to its
    // normal active (non-greyed) treatment and the strip is ABSENT (the caller
    // stops passing configurationNeeds).
    empty: async (page) => {
      const emptyRoot = page.locator(
        '[data-surface-id="install-config-needs-callout"][data-variant="empty"]',
      );
      const card = emptyRoot.locator('[data-slot="installed-extension-card"]');
      await expect(card).toBeVisible();
      await expect(card).not.toHaveAttribute("data-needs-review", "");
      await expect(emptyRoot.locator(INSTALL_CONFIG_CALLOUT_SLOT)).toHaveCount(0);
    },
  },
};

// ---------------------------------------------------------------------------
// Approvals + Scheduling drivers (cinatra#1043) — the surfaces the app manifest
// gained at spec 4d7b3505. Mounted on the base conformance harness by
// src/app/design-fixtures/conformance/approvals-scheduling-fixtures.tsx. Their
// real screens drive every decision through a server action that needs an
// authenticated session + seeded rows (unreachable on the standalone harness,
// which is why the LIVE-render conformance was proven by hand); the harness
// models each surface with the REAL design-system primitives it is built from
// and exercises each manifest action to its specified outcome (asserted on the
// harness `data-outcome` instrumentation, mirrored by a real StatusPill).
// ---------------------------------------------------------------------------

/** The populated (interactive) root of an approvals/scheduling harness surface. */
function harnessRoot(id: string): (page: Page) => Locator {
  return (page) => page.locator(`[data-surface-id="${id}"][data-variant="populated"]`);
}

/** Assert a state variant's real design-system treatment renders. */
function variantSlotState(id: string, variant: string, slot: string): StateAssert {
  return async (page) => {
    await expect(
      page.locator(`[data-surface-id="${id}"][data-variant="${variant}"] [data-slot="${slot}"]`),
    ).toBeVisible();
  };
}

/**
 * Action driver: click `button` (retrying through hydration), optionally clear a
 * one-step confirm (`confirm`), then assert the surface root reaches
 * `data-outcome=outcome` and — when the outcome maps to a lifecycle status — the
 * matching real StatusPill renders.
 */
function outcomeAction(
  outcome: string,
  button: string,
  opts?: { confirm?: string; pillStatus?: string; fill?: { label: string; value: string } },
): { outcome: string; run: (page: Page, root: Locator) => Promise<void> } {
  return {
    outcome,
    run: async (_page, root) => {
      if (opts?.confirm) {
        await clickUntil(root.getByRole("button", { name: button, exact: true }), async () => {
          await expect(
            root.getByRole("button", { name: opts.confirm!, exact: true }),
          ).toBeVisible({ timeout: 2_000 });
        });
        // A required reason field (mirrors the real reject ceremony) blocks the
        // confirm submit until filled — fill it before confirming.
        if (opts.fill) {
          await root.getByLabel(opts.fill.label).fill(opts.fill.value);
        }
        await clickUntil(root.getByRole("button", { name: opts.confirm, exact: true }), async () => {
          await expect(root).toHaveAttribute("data-outcome", outcome, { timeout: 2_000 });
        });
      } else {
        await clickUntil(root.getByRole("button", { name: button, exact: true }), async () => {
          await expect(root).toHaveAttribute("data-outcome", outcome, { timeout: 2_000 });
        });
      }
      if (opts?.pillStatus) {
        await expect(
          root.locator(`[data-slot="status-pill"][data-status="${opts.pillStatus}"]`),
        ).toBeVisible();
      }
    },
  };
}

/** Assert a named affordance button renders on the populated root. */
function presentButton(name: string): (page: Page, root: Locator) => Promise<void> {
  return async (_page, root) => {
    await expect(root.getByRole("button", { name, exact: true })).toBeVisible();
  };
}

const APPROVALS_INBOX_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: harnessRoot("approvals-inbox"),
  present: presentButton("Approve"),
  fields: {},
  actions: {
    approve: outcomeAction("approved", "Approve", { pillStatus: "approved" }),
    reject: outcomeAction("rejected", "Reject", {
      confirm: "Confirm rejection",
      pillStatus: "declined",
      fill: { label: "Reason for rejection", value: "Not aligned with policy." },
    }),
  },
  states: {
    empty: variantSlotState("approvals-inbox", "empty", "empty"),
    error: variantSlotState("approvals-inbox", "error", "alert"),
  },
};

const APPROVALS_YOUR_REQUESTS_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: harnessRoot("approvals-your-requests"),
  present: presentButton("Approve"),
  fields: {},
  actions: {
    approve: outcomeAction("approved", "Approve", { pillStatus: "approved" }),
    withdraw: outcomeAction("withdrawn", "Withdraw", { pillStatus: "archived" }),
  },
  states: {
    empty: variantSlotState("approvals-your-requests", "empty", "empty"),
    error: variantSlotState("approvals-your-requests", "error", "alert"),
  },
};

const APPROVALS_MARKETPLACE_STATES_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: harnessRoot("approvals-marketplace-states"),
  present: presentButton("Try again"),
  fields: {},
  actions: {
    // Retry re-derives the group — the real MarketplaceNotConnectedGroup (a
    // "Connect registry" CTA) returns as the reloaded content.
    retry: {
      outcome: "reloaded",
      run: async (_page, root) => {
        await clickUntil(root.getByRole("button", { name: "Try again", exact: true }), async () => {
          await expect(root).toHaveAttribute("data-outcome", "reloaded", { timeout: 2_000 });
        });
        await expect(root.getByRole("link", { name: "Connect registry" })).toBeVisible();
      },
    },
  },
  states: {
    // Connectivity state (a): the REAL group-level "Marketplace not connected"
    // Empty + Connect registry CTA.
    empty: async (page) => {
      const empty = page.locator(
        '[data-surface-id="approvals-marketplace-states"][data-variant="empty"]',
      );
      await expect(empty.locator('[data-slot="empty"]')).toBeVisible();
      await expect(empty.getByText("Marketplace not connected")).toBeVisible();
      await expect(empty.getByRole("link", { name: "Connect registry" })).toBeVisible();
    },
    error: variantSlotState("approvals-marketplace-states", "error", "alert"),
  },
};

const SCHEDULING_STEP_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: harnessRoot("scheduling-step"),
  present: presentButton("Schedule run"),
  fields: {},
  actions: {
    schedule: outcomeAction("armed", "Schedule run", { pillStatus: "scheduled" }),
  },
  states: {
    error: variantSlotState("scheduling-step", "error", "alert"),
    loading: async (page) => {
      await expect(
        page.locator(
          '[data-surface-id="scheduling-step"][data-variant="loading"] [data-testid="scheduling-step-loading"]',
        ),
      ).toBeVisible();
    },
  },
};

/**
 * scheduling-step-configured — the surface that REPLACED scheduling-trigger-tab
 * when the design system redrew the schedule step after cinatra#2972 (adopted
 * by the cinatra#3057 pin reconciliation). The two operations are the ones the
 * shipped card draws: Save changes (`save-schedule-changes`, settling to
 * "Saved — the trigger is re-armed on these rows") and Cancel schedule
 * (`cancel-trigger-schedule`), which asks once before it stops the schedule.
 * Run now is gone with its whole action path, which is why the retired
 * surface's `release -> released` has no counterpart here.
 */
const SCHEDULING_STEP_CONFIGURED_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: harnessRoot("scheduling-step-configured"),
  present: presentButton("Save changes"),
  fields: {},
  actions: {
    "save-schedule": outcomeAction("rearmed", "Save changes", {
      pillStatus: "scheduled",
    }),
    "cancel-schedule": outcomeAction("stopped", "Cancel schedule", {
      confirm: "Confirm cancel schedule",
      pillStatus: "archived",
    }),
  },
  states: {
    error: variantSlotState("scheduling-step-configured", "error", "alert"),
    loading: async (page) => {
      await expect(
        page.locator(
          '[data-surface-id="scheduling-step-configured"][data-variant="loading"] [data-testid="scheduling-step-configured-loading"]',
        ),
      ).toBeVisible();
    },
  },
};

// ---------------------------------------------------------------------------
// App-shell drivers adopted with the cinatra#3057 pin reconciliation:
// `sidebar-assistants-entry` (conformance/app.json) and
// `breadcrumb-entity-resolution` (conformance/app-components.json). Both name
// mechanisms this repo already ships — the §IX Assistants nav entry
// (src/components/app-sidebar.tsx, epic #1873 W3) and the crumb-contributions
// resolution road (src/lib/breadcrumb-contributions.ts +
// src/lib/breadcrumb-trail.ts, cinatra#1737/#1738) — so the adoption is
// harness and test-id catch-up, not product work.
// ---------------------------------------------------------------------------

const SIDEBAR_ASSISTANTS_ENTRY_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: harnessRoot("sidebar-assistants-entry"),
  present: async (_page, root) => {
    // The two literals testid-contract.json pins on the REAL entry, asserted
    // here on the mount that carries them, plus the label and the glyph.
    await expect(
      root.locator('[data-conformance-id="sidebar-assistants-entry"]'),
    ).toBeVisible();
    await expect(
      root.locator('[data-action="open-assistants -> assistants"]'),
    ).toBeVisible();
    await expect(root.getByRole("button", { name: "Assistants", exact: true })).toBeVisible();
  },
  fields: {},
  actions: {
    "open-assistants": outcomeAction("assistants", "Assistants"),
  },
  states: {},
};

const BREADCRUMB_ENTITY_RESOLUTION_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: harnessRoot("breadcrumb-entity-resolution"),
  present: async (_page, root) => {
    await expect(root.locator('[data-testid="crumb-label"]')).toBeVisible();
    await expect(root.locator('[data-testid="crumb-placeholder"]')).toBeVisible();
  },
  fields: {
    // The resolved crumb carries the entity's DISPLAY NAME, published by the
    // gated route onto the contributions bus — never the id it was resolved
    // from. The seed shares no token with the id, so asserting the wrong
    // source cannot accidentally pass.
    "crumb-label": {
      source: "entity.displayName",
      assert: async (_page, root) => {
        const crumb = root
          .locator('[data-testid="crumb-label"] [data-slot="breadcrumb-page"]')
          .last();
        await expect(crumb).toHaveText(BREADCRUMB_ENTITY_DISPLAY_NAME);
        await expect(crumb).not.toContainText(BREADCRUMB_ENTITY_ID);
      },
    },
    // With nothing resolved, the crumb is the short-id placeholder DERIVED
    // from the entity id — the cinatra#1737 floor rule that keeps
    // title-cased hex ("9c0dfce6 B2cb 4dab …") off the screen.
    "crumb-placeholder": {
      source: "entity.id",
      assert: async (_page, root) => {
        const crumb = root
          .locator('[data-testid="crumb-placeholder"] [data-slot="breadcrumb-page"]')
          .last();
        await expect(crumb).toHaveText(BREADCRUMB_ENTITY_PLACEHOLDER);
        await expect(crumb).not.toHaveText(BREADCRUMB_ENTITY_DISPLAY_NAME);
      },
    },
  },
  actions: {
    // Visiting a negative surface clears the parked snapshot, so a
    // previously-authorized name cannot survive into the unauthorized visit:
    // the resolved crumb falls back to its placeholder.
    "visit-unauthorized": {
      outcome: "resolved-names-cleared",
      run: async (page, root) => {
        await expect(
          root.locator('[data-testid="crumb-label"] [data-slot="breadcrumb-page"]').last(),
        ).toHaveText(BREADCRUMB_ENTITY_DISPLAY_NAME);
        await outcomeAction("resolved-names-cleared", "Visit an unauthorized page").run(
          page,
          root,
        );
        await expect(
          root.locator('[data-testid="crumb-label"] [data-slot="breadcrumb-page"]').last(),
        ).toHaveText(BREADCRUMB_ENTITY_PLACEHOLDER);
      },
    },
  },
  states: {
    loading: async (page) => {
      const loadingRoot = page.locator(
        '[data-surface-id="breadcrumb-entity-resolution"][data-variant="loading"]',
      );
      await expect(loadingRoot).toBeVisible();
      // The loading treatment IS the placeholder floor — an empty or skeleton
      // crumb would be a different contract, so assert the content, not just
      // the wrapper (the convention every other loading driver here follows).
      const crumb = loadingRoot
        .locator('[data-testid="crumb-placeholder-loading"] [data-slot="breadcrumb-page"]')
        .last();
      await expect(crumb).toHaveText(BREADCRUMB_ENTITY_PLACEHOLDER);
      await expect(crumb).not.toHaveText(BREADCRUMB_ENTITY_DISPLAY_NAME);
    },
  },
};

// ---------------------------------------------------------------------------
// The §X Workspace surfaces of the application drawing, adopted with the
// ratification that made the entity-page tablist a five-entry strip
// (epic cinatra#2806, part of cinatra#3144).
//
// The mechanisms these three surfaces name — the Workspace nav entry, the
// Workspace scope page and its empty tab — are NOT on the default branch. They
// arrive with the per-scope surfaces change (cinatra#3152, open at the time of
// writing), and until that lands there is nothing on the conformance harness to
// assert against.
//
// Two things follow, and both are deliberate:
//
//   - The app pin IS advanced to the published manifest, so all three surfaces
//     are declared and generate their batteries. A pin advance is a claim that
//     this branch answers for the drawing at the new revision, and it does:
//     these three answer with a named SKIP, never with a pass. The guard, the
//     allowlist and the testid-contract holdbacks that keep that honest are
//     checked in scripts/design/__tests__/awaiting-mount-guard.test.mjs.
//   - The drivers below are nonetheless written in full, against the ratified
//     manifest's own field sources, action outcomes and state variants. They are
//     what the advance is waiting for. Nothing here stands in for the surface: a
//     driver whose surface the harness does not mount SKIPS with the reason, and
//     the same assertions run for real — unchanged — the moment the mount exists.
// ---------------------------------------------------------------------------

/** Why an awaiting-mount driver skips, named on every skipped test. */
const AWAITING_PER_SCOPE_SURFACES =
  "the real component is not on the default branch yet — it arrives with the " +
  "per-scope surfaces change (cinatra#3152) — so the conformance harness mounts " +
  "no such surface. Every assertion in this driver is written and runs unchanged " +
  "the moment the mount exists.";

/**
 * Wrap a fully written driver whose SURFACE is not on the default branch yet.
 *
 * The guard is the harness mount itself, never a branch name or a revision: while
 * nothing on the harness carries the surface id the whole battery SKIPS with the
 * reason above; the moment a mount does, every assertion runs for real. That is
 * why this is not a stub — it asserts nothing it cannot see, and it hides nothing
 * it can.
 */
/**
 * A surface the conformance harness has mounted since long before this change.
 * It is the proof that the harness itself rendered, and it is what makes the
 * guard below fail-CLOSED: a blank page, a boot error or a route regression
 * would otherwise look exactly like "the surface is not on the branch yet", and
 * the whole battery would skip instead of failing.
 */
const HARNESS_ANCHOR_SURFACE_ID = "status-pills";

/**
 * How long the harness is given to settle before absence is read as absence.
 * The suite navigates with `waitUntil: "domcontentloaded"`, so an instantaneous
 * count would race a surface that mounts a tick later and skip a shipped screen.
 */
const AWAITING_MOUNT_SETTLE_MS = 5_000;

function awaitingMount(
  surfaceId: string,
  driver: SurfaceDriver,
  reason: string = AWAITING_PER_SCOPE_SURFACES,
): SurfaceDriver {
function awaitingMount(
  surfaceId: string,
  driver: SurfaceDriver,
  /** Why this surface is not mounted yet. Defaults to the per-scope surfaces
   *  wait above; another wave naming its own reason passes it here. */
  reason: string = AWAITING_PER_SCOPE_SURFACES,
): SurfaceDriver {
function awaitingMount(
  surfaceId: string,
  driver: SurfaceDriver,
  /**
   * Why this surface is not on the harness yet. Defaults to the per-scope
   * reason this helper was introduced for; a later wave whose surfaces await a
   * DIFFERENT landing (cinatra#3165, epic #3155 W9) passes its own, so the
   * reason a skipped test prints always names what that surface is waiting on.
   */
  reason: string = AWAITING_PER_SCOPE_SURFACES,
): SurfaceDriver {
  const guard = async (page: Page): Promise<void> => {
    await expect(
      page.locator(`[data-surface-id="${HARNESS_ANCHOR_SURFACE_ID}"]`).first(),
      `the conformance harness itself did not render — this is a real failure, never a surface whose mount has not landed yet`,
      `the conformance harness itself did not render — this is a real failure, never a surface awaiting its own landing`,
    ).toBeAttached({ timeout: AWAITING_MOUNT_SETTLE_MS });

    let mounted = true;
    try {
      await page
        .locator(`[data-surface-id="${surfaceId}"]`)
        .first()
        .waitFor({ state: "attached", timeout: AWAITING_MOUNT_SETTLE_MS });
    } catch {
      mounted = false;
    }
    test.skip(!mounted, `${surfaceId}: ${reason}`);
  };
  return {
    ...driver,
    present: async (page, root) => {
      await guard(page);
      await driver.present(page, root);
    },
    fields: Object.fromEntries(
      Object.entries(driver.fields).map(([name, field]) => [
        name,
        {
          source: field.source,
          assert: async (page: Page, root: Locator) => {
            await guard(page);
            await field.assert(page, root);
          },
        },
      ]),
    ),
    actions: Object.fromEntries(
      Object.entries(driver.actions).map(([name, entry]) => [
        name,
        (Array.isArray(entry) ? entry : [entry]).map((candidate) => ({
          outcome: candidate.outcome,
          run: async (page: Page, root: Locator) => {
            await guard(page);
            await candidate.run(page, root);
          },
        })),
      ]),
    ),
    states: Object.fromEntries(
      Object.entries(driver.states).map(([name, assertState]) => [
        name,
        async (page: Page, root: Locator) => {
          await guard(page);
          await assertState(page, root);
        },
      ]),
    ),
  };
}

/**
 * sidebar-workspace-entry — the Workspace nav entry the amended §IX strip adds.
 * The manifest binds its title to `nav.title` and its one action to
 * `open-workspace -> workspace`; both literals are the conformance contract the
 * real entry must carry, exactly as the Assistants entry above carries its own.
 */
const SIDEBAR_WORKSPACE_ENTRY_DRIVER: SurfaceDriver = awaitingMount("sidebar-workspace-entry", {
  path: HARNESS_PATH,
  root: harnessRoot("sidebar-workspace-entry"),
  present: async (_page, root) => {
    await expect(root.locator('[data-conformance-id="sidebar-workspace-entry"]')).toBeVisible();
    await expect(root.locator('[data-action="open-workspace -> workspace"]')).toBeVisible();
    await expect(root.getByRole("button", { name: "Workspace", exact: true })).toBeVisible();
  },
  fields: {
    // title = nav.title — the entry renders the navigation title, not a scope
    // name and not a route segment.
    title: {
      source: "nav.title",
      assert: async (_page, root) => {
        await expect(
          root.locator('[data-conformance-id="sidebar-workspace-entry"]'),
        ).toHaveText("Workspace");
      },
    },
  },
  actions: {
    "open-workspace": outcomeAction("workspace", "Workspace"),
  },
  states: {},
});

/**
 * workspace-scope-page — the Workspace scope page the amended drawing adds to
 * the scopes. Its one field binds the page's name to the scope identity's
 * DISPLAY NAME; the three state variants are the drawing's own.
 */
const WORKSPACE_SCOPE_PAGE_DRIVER: SurfaceDriver = awaitingMount("workspace-scope-page", {
  path: HARNESS_PATH,
  root: harnessRoot("workspace-scope-page"),
  present: async (_page, root) => {
    await expect(root.locator('[data-conformance-id="workspace-scope-page"]')).toBeVisible();
    await expect(root.locator('[data-testid="workspace-scope-name"]')).toBeVisible();
  },
  fields: {
    // name = identity.displayName — the page names the scope by its display
    // name and NEVER by the id it was resolved from (the same floor rule the
    // breadcrumb driver above holds). The mount publishes both on the surface
    // root, so asserting the wrong source cannot accidentally pass.
    name: {
      source: "identity.displayName",
      assert: async (_page, root) => {
        const displayName = await root.getAttribute("data-identity-display-name");
        expect(
          displayName,
          'the harness mount for "workspace-scope-page" must publish the seeded identity display name as data-identity-display-name, so this assertion names a source of truth rather than whatever the page rendered',
        ).toBeTruthy();
        const name = root.locator('[data-testid="workspace-scope-name"]');
        await expect(name).toHaveText(displayName!);
        const identityId = await root.getAttribute("data-identity-id");
        if (identityId) await expect(name).not.toContainText(identityId);
      },
    },
  },
  actions: {},
  states: {
    empty: variantSlotState("workspace-scope-page", "empty", "empty"),
    error: variantSlotState("workspace-scope-page", "error", "alert"),
    loading: variantSlotState("workspace-scope-page", "loading", "skeleton"),
  },
});

/**
 * workspace-scope-empty-tab — a tab of the five-entry strip that the Workspace
 * scope has nothing to show in. The drawing gives it exactly one state, and the
 * whole point of the surface is that the empty state is a real, drawn treatment
 * rather than a blank panel.
 */
const WORKSPACE_SCOPE_EMPTY_TAB_DRIVER: SurfaceDriver = awaitingMount("workspace-scope-empty-tab", {
  path: HARNESS_PATH,
  root: (page) => page.locator('[data-surface-id="workspace-scope-empty-tab"][data-variant="empty"]'),
  present: async (_page, root) => {
    await expect(root.locator('[data-slot="empty"]')).toBeVisible();
  },
  fields: {},
  actions: {},
  states: {
    empty: variantSlotState("workspace-scope-empty-tab", "empty", "empty"),
  },
});


/**
 * The ratified entity-page tab strip: five entries, in this order, on EVERY
 * scope. Settings is not a member of it — where a scope has one it is appended
 * AFTER these five, which is exactly what the amendment changed (Settings used
 * to be the second entry, and a personal scope used to carry Dashboards alone).
 */
const SCOPE_TAB_STRIP = ["Dashboards", "Assistants", "Agents", "Artifacts", "Skills"];

/**
 * Action driver for a surface whose control declares its own manifest action.
 *
 * The conformance harness marks such a control `data-action="<action> -> <outcome>"`
 * (the notifications and suggestion-chip mounts already do), which binds the
 * click to the manifest entry rather than to a copy string this file would
 * otherwise have to guess. The assertion is the surface root reaching that
 * outcome, the same evidence `outcomeAction` takes.
 */
function declaredAction(
  action: string,
  outcome: string,
): { outcome: string; run: (page: Page, root: Locator) => Promise<void> } {
  return {
    outcome,
    run: async (_page, root) => {
      await clickUntil(root.locator(`[data-action="${action} -> ${outcome}"]`), async () => {
        await expect(root).toHaveAttribute("data-outcome", outcome, { timeout: 2_000 });
      });
    },
  };
}

/**
 * scope-dashboards-tab — the entity-page tab the same ratification amended, in
 * section IX of the artifacts drawing.
 *
 * Measured against the two published artifacts, the amendment moved the drawing
 * bytes and moved NO declared aspect of this surface: its one field, its three
 * actions and its four states are identical before and after. So the strip
 * itself needs an assertion the manifest cannot ask for, and `present` makes it
 * — the five entries in the ratified order, with Settings appended LAST where a
 * scope has one and absent where it has none. The declared aspects are driven on
 * the harness instrumentation this file already uses everywhere else: the field
 * element names its own binding (`data-field="name=identity.displayName"`, the
 * convention the shipped dashboard row carries), and each action is the control
 * that declares that action and outcome.
 *
 * Like the three surfaces above, none of this is on the default branch: the
 * scope surfaces arrive with cinatra#3152, so the whole battery SKIPS with the
 * reason until the harness mounts the surface, and runs unchanged afterwards.
 */
const SCOPE_DASHBOARDS_TAB_DRIVER: SurfaceDriver = awaitingMount("scope-dashboards-tab", {
  path: HARNESS_PATH,
  root: harnessRoot("scope-dashboards-tab"),
  present: async (page) => {
    // "on every scope, Settings appended last only where a scope has one" is a
    // statement about a SET of scopes, so it is graded over every mount of the
    // surface, and each mount has to declare which half of the rule it stands
    // for. `data-scope-has-settings` is that declaration, in the same shape as
    // the `data-field` / `data-action` instrumentation this file already reads;
    // an undeclared mount FAILS rather than being read charitably.
    const mounts = page.locator(`[data-surface-id="scope-dashboards-tab"]`);
    const mountCount = await mounts.count();
    expect(mountCount, "no scope-dashboards-tab mount on the harness").toBeGreaterThan(0);

    const withSettings: boolean[] = [];
    for (let index = 0; index < mountCount; index += 1) {
      const mount = mounts.nth(index);
      const declared = await mount.getAttribute("data-scope-has-settings");
      expect(
        declared,
        `every scope-dashboards-tab mount declares data-scope-has-settings="true" or "false" — the tested scope's own answer to the conditional half of the ratified strip. Mount ${index} declares ${JSON.stringify(declared)}.`,
      ).toMatch(/^(true|false)$/);
      const hasSettings = declared === "true";
      const entries = (await mount.locator('[role="tablist"] [role="tab"]').allInnerTexts()).map(
        (entry) => entry.trim(),
      );
      expect(
        entries,
        `the entity-page tablist is the five-entry strip in the ratified order — Dashboards, Assistants, Agents, Artifacts, Skills — with Settings appended LAST where the scope has one and absent where it has none (mount ${index}, data-scope-has-settings=${declared})`,
      ).toEqual(hasSettings ? [...SCOPE_TAB_STRIP, "Settings"] : [...SCOPE_TAB_STRIP]);
      withSettings.push(hasSettings);
    }

    expect(
      withSettings.includes(true) && withSettings.includes(false),
      `the ratified strip is conditional, so both halves must be mounted: a scope that HAS Settings and a scope that has none. The harness mounts ${JSON.stringify(withSettings)}.`,
    ).toBe(true);
  },
  fields: {
    // name = identity.displayName — the listing row names the entity by its
    // display name. The element declares its own binding, so a mount that bound
    // the wrong source cannot satisfy this locator by accident.
    name: {
      source: "identity.displayName",
      assert: async (_page, root) => {
        await expect(
          root.locator('[data-field="name=identity.displayName"]').first(),
        ).toBeVisible();
      },
    },
  },
  actions: {
    "open-add-picker": declaredAction("open-add-picker", "add-picker-open"),
    "open-dashboard": declaredAction("open-dashboard", "dashboard-canonical"),
    "remove-listing": declaredAction("remove-listing", "listing-removed"),
  },
  states: {
    empty: variantSlotState("scope-dashboards-tab", "empty", "empty"),
    error: variantSlotState("scope-dashboards-tab", "error", "alert"),
    loading: variantSlotState("scope-dashboards-tab", "loading", "skeleton"),
    // kind:artifact — the listing row's own kind declaration, the same
    // `kind:` state shape the extension-detail and connector drivers assert.
    "kind:artifact": async (_page, root) => {
      await expect(root.locator('[data-kind="artifact"]').first()).toBeVisible();
    },
  },
});

// ---------------------------------------------------------------------------
// /notifications unified-surface drivers (cinatra#1549 E11-AC2) — the nine
// surfaces of conformance/app-notifications.json (design@2bcc2c7e). Mounted on
// the base conformance harness by
// src/app/design-fixtures/conformance/notifications-conformance-fixtures.tsx.
// The real /notifications screen resolves its rows through an authenticated
// session + the ApprovalSource registry + the E6 client store (unreachable on
// the standalone harness, same as the approvals/scheduling surfaces), so each
// surface is modelled with the REAL design-system primitives the live feed is
// built from (the §II row shell, the §III filter chips, the §IV badge-only
// bell, the §V "No notifications" empty, the §VI degraded line) plus the REAL
// shipped loading skeletons (src/app/notifications/notifications-skeletons.tsx,
// packages/notifications/src/bell-skeleton.tsx); each action is exercised to its
// specified outcome on the harness `data-outcome` instrumentation.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The ARTIFACT-KIND DISPLAY family, STANDALONE (cinatra#3158, epic #3155 W2)
// ---------------------------------------------------------------------------
//
// The eleven artifact-kind display surfaces of the artifact-review drawing: the
// displays the fleet adds, one per type, drawn on the artifact's own page and —
// unchanged — on the review step of the run page. This is the standalone reading
// of the same family W1 drives in a conversation.
//
// ONE LIST, ONE MAP. The rows live in artifact-review-displays.ts, keyed by the
// manifest surface id, and the map below is built FROM them: being listed is
// being mapped, so there is no second place a surface could be forgotten. The
// three surfaces whose per-kind display shape is the whole of what the drawing
// gives them ride the factory alone; the eight that carry a drawn structure of
// their own extend it.
//
// NONE OF THESE DISPLAYS IS ON THE DEFAULT BRANCH, and this wave does not
// pretend otherwise. Grounded by reading the shipped tree, not assumed: seven of
// the eleven belong to extensions that declare a type and ship no renderer at
// all; the pointer and the page draw through ONE renderer the drawing names
// (@cinatra-ai/website-artifacts:page-diff) which no package in the tree ships;
// the shipped markdown display draws its two readings SIDE BY SIDE, which the
// drawing forbids in those words; and the download card, which IS shipped and
// does draw what §V.2 describes, carries none of the conformance anchors this
// contract addresses and is an extension renderer the conformance harness may
// not mount at all. So every driver below is guarded by `awaitingMount` — the
// same guard, and the same fail-closed harness anchor, the Workspace surfaces
// have used since cinatra#3152 — and each names in its skip reason exactly what
// its display is waiting for. Nothing here stands in for a surface: every
// assertion is written in full against the drawing's own declarations and runs
// unchanged, for real, the moment a mount exists.
//
// WHY NO HARNESS MOUNT LANDS WITH THIS WAVE. W0's mount is the real shipped chip
// row under the real host declaration. There is no equivalent to mount here: a
// harness element drawing a display the product does not have would be a stand-in
// — the one thing this epic's road forbids — and mounting the one display that
// does ship would put a real extension instance in a core fixture, which is
// precisely what the core/extension instance-coupling ban exists to stop. The
// mount lands with the display.

/** The populated mount of one artifact-kind display. */
function kindDisplayMount(surface: string, variant: string): string {
  return `[data-surface-id="${surface}"][data-variant="${variant}"]`;
}

/** The display panel itself, inside its mount. It carries the surface anchor. */
function kindDisplayPanel(root: Locator, surface: string): Locator {
  return root.locator(`[data-conformance-id="${surface}"]`);
}

/**
 * A drawn state variant: its own mount, drawing the same display in that
 * reading.
 *
 * §XI is explicit about what a reading is NOT: "a sentence about a failure …
 * reports through the app's toast surface, never as a line written into the
 * panel", and "where content is absent by right … the display draws the named
 * gap in the missing thing's place, never a blank plate and never a row appended
 * beneath the work". So a state variant is the display drawn differently, never
 * a note added to it — and never the floor, which §V.2 keeps strictly apart from
 * a display ("a display and a floor are never drawn for each other").
 */
function kindDisplayState(surface: string, variant: string): StateAssert {
  return async (page) => {
    const mount = page.locator(kindDisplayMount(surface, variant));
    await expect(mount).toHaveCount(1);
    const display = kindDisplayPanel(mount, surface);
    await expect(display).toBeVisible();
    await expect(display).toHaveAttribute("data-display-state", variant);
    await expect(display.locator('[data-conformance-id="review-target-floor"]')).toHaveCount(0);
    // "a sentence about a failure ... reports through the app's toast surface,
    // never as a line written into the panel" — so NO reading of the display
    // carries an alert of its own, the failure reading least of all.
    await expect(display.locator('[role="alert"]')).toHaveCount(0);
    if (variant === "empty") {
      // "the display draws the named gap in the missing thing's place, never a
      // blank plate": an empty reading that says nothing is a red, not a pass.
      await expect(display).not.toHaveText(/^\s*$/);
    }
  };
}

/**
 * The `kind:*` reading. The display carries the artifact kind it draws, the same
 * way the extension listing card carries its catalog kind (`cardKindState`).
 */
function kindDisplayKindState(surface: string, kind: string): StateAssert {
  return async (_page, root) => {
    await expect(kindDisplayPanel(root, surface)).toHaveAttribute("data-kind", kind);
  };
}

/**
 * The shared per-kind display factory.
 *
 * What every display in this family owes the drawing, and therefore what this
 * factory asserts for all eleven:
 *
 *   - §XI: "A display draws the work and nothing about itself — no renderer chip
 *     and no provenance line"; §V says the same for the slot, and the
 *     lifecycle-cards drawing a third time.
 *   - §XI: "It carries no decision affordance: Comment, Regenerate and Continue
 *     are the review floor's … drawn by the surface around the display and never
 *     inside it, so a display drawn where there is no review shows no control at
 *     all."
 *   - §XI: "Where a display divides one artifact into readings, they are the
 *     design system's tabs … never a toggle and never a segmented control."
 *   - the one field the manifest binds, addressed through the binding the
 *     display names on itself — the `data-field="<name>=<source>"` convention the
 *     shipped review target already carries — so a display bound to the wrong
 *     source cannot resolve the locator at all.
 *   - the one action the manifest declares, pressed on the control that declares
 *     exactly that action AND that outcome (`declaredAction`), so a driver
 *     cannot press one control and report another one's outcome.
 *   - every state variant the manifest declares.
 */
function artifactKindDisplayDriver(row: ArtifactKindDisplay): SurfaceDriver {
  const driver: SurfaceDriver = {
    path: HARNESS_PATH,
    root: (page) => page.locator(kindDisplayMount(row.surface, "populated")),
    present: async (_page, root) => {
      const display = kindDisplayPanel(root, row.surface);
      await expect(display).toBeVisible();
      // Nothing about itself.
      await expect(
        display.locator('[data-conformance-id="review-provenance-native"]'),
      ).toHaveCount(0);
      await expect(
        display.locator('[data-conformance-id="review-provenance-marketplace"]'),
      ).toHaveCount(0);
      // No decision affordance, ever, inside a display.
      await expect(display.locator('[data-conformance-id="review-decision-bar"]')).toHaveCount(0);
      // Readings are tabs, never a switch and never a segmented control.
      await expect(display.locator('[role="switch"]')).toHaveCount(0);
      await expect(display.locator('[data-slot="toggle-group"]')).toHaveCount(0);
    },
    fields: {},
    actions: {},
    states: {},
  };

  const field = row.field;
  if (field !== null) {
    driver.fields[field.name] = {
      source: field.source,
      assert: async (_page, root) => {
        const bound = kindDisplayPanel(root, row.surface).locator(
          `[data-field="${field.name}=${field.source}"]`,
        );
        await expect(bound).toHaveCount(1);
        await expect(bound).toBeVisible();
      },
    };
  }

  const action = row.action;
  if (action !== null) {
    driver.actions[action.name] = declaredAction(action.name, action.outcome);
  }

  for (const state of row.states) {
    driver.states[state] = state.startsWith("kind:")
      ? kindDisplayKindState(row.surface, state.slice("kind:".length))
      : kindDisplayState(row.surface, state);
  }

  return driver;
}

/** Assert the display draws no tab strip at all — a surface the drawing gives
 *  ONE view ("There is no tab strip and no second reading to switch to"). */
async function expectOneView(root: Locator, surface: string): Promise<void> {
  await expect(kindDisplayPanel(root, surface).locator('[data-slot="tabs-list"]')).toHaveCount(0);
}

/**
 * The way back to the live dashboard, which §XI.5 and §XI.6 draw ONLY once the
 * review is continued: "while a decision is still open the proposal is not the
 * live dashboard, so the display offers no way to open one, and the navigation
 * appears with the settled marker".
 *
 * So the action is driven on the SETTLED mount, and the open reading is asserted
 * to carry no such control at all — the absence is half of what the drawing says.
 */
function openLiveDashboardOnceContinued(
  surface: string,
): { outcome: string; run: (page: Page, root: Locator) => Promise<void> } {
  return {
    outcome: "dashboard-canonical",
    run: async (page, root) => {
      // The absence below is evidence ONLY if the open reading is actually
      // drawn: on a missing populated mount a zero count proves nothing, and the
      // settled half alone would carry the whole test.
      await expect(page.locator(kindDisplayMount(surface, "populated"))).toHaveCount(1);
      await expect(kindDisplayPanel(root, surface)).toBeVisible();
      await expect(
        kindDisplayPanel(root, surface).locator(
          '[data-action="open-live-dashboard -> dashboard-canonical"]',
        ),
      ).toHaveCount(0);
      const settled = page.locator(kindDisplayMount(surface, "continued"));
      await expect(settled).toHaveCount(1);
      await expect(settled.locator('[data-conformance-id="settled-marker"]')).toBeVisible();
      await clickUntil(
        settled.locator('[data-action="open-live-dashboard -> dashboard-canonical"]'),
        async () => {
          await expect(settled).toHaveAttribute("data-outcome", "dashboard-canonical", {
            timeout: 2_000,
          });
        },
      );
    },
  };
}

/**
 * What each of the eight displays that carry a drawn structure of their own adds
 * to the family shape. Keyed by the surface union, so a row without an entry is
 * a deliberate omission (the three factory-only surfaces) rather than a typo.
 */
/**
 * The eight surfaces that carry a drawn structure of their own — the union
 * minus the three the wave rides on the factory alone. The extras map below is
 * typed over THIS union and is NOT Partial, so dropping one of the eight is a
 * compile error rather than a silently thinner driver.
 */
type ArtifactKindDisplayExtraSurfaceId = Exclude<
  ArtifactKindDisplaySurfaceId,
  "markdown-display-tabs" | "binary-download-card" | "chart-display-only"
>;

const ARTIFACT_KIND_DISPLAY_EXTRAS: Record<
  ArtifactKindDisplayExtraSurfaceId,
  (base: SurfaceDriver) => SurfaceDriver
> = {
  // §XI.1 — one view: the sender block, the subject under it, the body under a
  // rule. "There is no tab strip and no second reading to switch to." "A text
  // display draws no picture: the avatar is the sender's initials set in a plain
  // disc, never an image." And "beyond those two fields the pane offers nothing:
  // it carries no reply field and no compose affordance of any kind — not inert,
  // not disabled, absent".
  "email-body-display": (base) => ({
    ...base,
    present: async (page, root) => {
      await base.present(page, root);
      await expectOneView(root, "email-body-display");
      const display = kindDisplayPanel(root, "email-body-display");
      const sender = display.locator('[data-conformance-id="email-body-sender"]');
      await expect(sender).toBeVisible();
      await expect(sender.locator("img")).toHaveCount(0);
      await expect(display.locator('[data-conformance-id="email-body-subject"]')).toBeVisible();
      await expect(display.locator('[data-conformance-id="email-body-reply"]')).toHaveCount(0);
    },
  }),

  // §XI.2 — "the reader sees one panel, not two": the display branches on the
  // artifact's own content form and draws it on a renderer the fleet already has
  // — the markdown display over text, the embedded pdf viewer over pdf — and
  // never a viewer written for this kind.
  "mixed-kind-display": (base) => ({
    ...base,
    present: async (page, root) => {
      await base.present(page, root);
      const display = kindDisplayPanel(root, "mixed-kind-display");
      await expect(
        display.locator(
          '[data-conformance-id="markdown-display-tabs"], [data-conformance-id="pdf-embedded-viewer"]',
        ),
      ).toHaveCount(1);
    },
  }),

  // §XI.3 — "The display shows the captured picture and, beneath it, the facts
  // that make a screenshot readable a week later: where it was taken, at what
  // viewport, and when."
  "screenshot-display": (base) => ({
    ...base,
    present: async (page, root) => {
      await base.present(page, root);
      const display = kindDisplayPanel(root, "screenshot-display");
      await expect(display.locator('[data-conformance-id="screenshot-picture"]')).toBeVisible();
      for (const fact of ["captured-url", "captured-viewport", "captured-at"]) {
        await expect(display.locator(`[data-conformance-id="screenshot-${fact}"]`)).toBeVisible();
      }
    },
  }),

  // §XI.4 — the exported deck in the embedded viewer, and "the display adds no
  // controls of its own": no page counter, no Previous and no Next.
  "slide-deck-display": (base) => ({
    ...base,
    present: async (page, root) => {
      await base.present(page, root);
      const display = kindDisplayPanel(root, "slide-deck-display");
      await expect(display.locator('[data-conformance-id="pdf-embedded-viewer"]')).toBeVisible();
      await expect(display.locator('[data-conformance-id="deck-page-counter"]')).toHaveCount(0);
      for (const name of ["Previous", "Next"]) {
        await expect(display.getByRole("button", { name, exact: true })).toHaveCount(0);
      }
    },
  }),

  // §XI.5 — the shared read-only composition: "no toolbar, no filters, no drag,
  // no save, and no decision affordance", and one line that says both facts at
  // once with the time the numbers were read.
  "dashboard-display": (base) => ({
    ...base,
    present: async (page, root) => {
      await base.present(page, root);
      const display = kindDisplayPanel(root, "dashboard-display");
      await expect(display.locator('[data-conformance-id="dashboard-composition"]')).toBeVisible();
      for (const forbidden of ["dashboard-toolbar", "dashboard-filters", "dashboard-save"]) {
        await expect(display.locator(`[data-conformance-id="${forbidden}"]`)).toHaveCount(0);
      }
      await expect(display.locator('[data-conformance-id="pinned-and-current"]')).toBeVisible();
    },
    actions: {
      ...base.actions,
      "open-live-dashboard": openLiveDashboardOnceContinued("dashboard-display"),
    },
  }),

  // §XI.6 — one entry of a dashboard, drawn exactly as it sits in it, "and says
  // which dashboard and which dashboard revision it was cut from, so a reader can
  // always get back to where it came from".
  "portlet-display": (base) => ({
    ...base,
    present: async (page, root) => {
      await base.present(page, root);
      const display = kindDisplayPanel(root, "portlet-display");
      await expect(display.locator('[data-conformance-id="dashboard-composition"]')).toBeVisible();
      await expect(display.locator('[data-conformance-id="portlet-cut-from"]')).toBeVisible();
      await expect(display.locator('[data-conformance-id="pinned-and-current"]')).toBeVisible();
    },
    actions: {
      ...base.actions,
      "open-live-dashboard": openLiveDashboardOnceContinued("portlet-display"),
    },
  }),

  // §XI.7 — the pointer draws through the page display, and "a pointer is still
  // never a review target": "the identity line reads not pinnable where a target
  // reads its revision, and no decision floor is drawn anywhere the pointer
  // appears".
  "drupal-pointer-display": (base) => ({
    ...base,
    present: async (page, root) => {
      await base.present(page, root);
      await expectOneView(root, "drupal-pointer-display");
      const display = kindDisplayPanel(root, "drupal-pointer-display");
      await expect(display.locator('[data-conformance-id="page-embed"]')).toBeVisible();
      await expect(display.locator('[data-conformance-id="changed-excerpts"]')).toBeVisible();
      await expect(display.locator('[data-conformance-id="pointer-identity"]')).toContainText(
        "not pinnable",
      );
      await expect(root.locator('[data-conformance-id="review-decision-bar"]')).toHaveCount(0);
    },
  }),

  // §XI.8 — "one view and no tab strip": the page embedded live in a frame, a
  // diff of only the changed excerpts beneath it, and Open in the CMS drawn under
  // the excerpts, the same way in every reading.
  "cms-page-display": (base) => ({
    ...base,
    present: async (page, root) => {
      await base.present(page, root);
      await expectOneView(root, "cms-page-display");
      const display = kindDisplayPanel(root, "cms-page-display");
      await expect(display.locator('[data-conformance-id="page-embed"]')).toBeVisible();
      await expect(display.locator('[data-conformance-id="changed-excerpts"]')).toBeVisible();
      await expect(
        display.locator('[data-action="open-in-cms -> cms-opened"]'),
      ).toBeVisible();
    },
  }),
};

/** Why an artifact-kind display driver skips, named on every skipped test. */
function artifactKindDisplayReadiness(row: ArtifactKindDisplay): string {
  return (
    `the display drawn in §${row.section} of the artifact-review drawing is not on the ` +
    `default branch yet — ${row.readiness}. Every assertion in this driver is written ` +
    `against the drawing's own declarations and runs unchanged the moment the mount exists.`
  );
}

/** The eleven drivers, built from the one row list. */
const ARTIFACT_KIND_DISPLAY_DRIVERS: Record<string, SurfaceDriver> = Object.fromEntries(
  ARTIFACT_KIND_DISPLAY_ROWS.map((row) => {
    const base = artifactKindDisplayDriver(row);
    const extend = (
      ARTIFACT_KIND_DISPLAY_EXTRAS as Partial<
        Record<ArtifactKindDisplaySurfaceId, (base: SurfaceDriver) => SurfaceDriver>
      >
    )[row.surface];
    return [
      row.surface,
      awaitingMount(row.surface, extend ? extend(base) : base, artifactKindDisplayReadiness(row)),
    ];
  }),
);

// ---------------------------------------------------------------------------
// The RUN STEP-RAIL FAMILY (cinatra#3162, epic #3155 W6)
// ---------------------------------------------------------------------------
//
// The fourteen surfaces of the artifact-review drawing's run family: the run
// surface itself, the rail down its left, and the steps that stand on that rail
// — Skills, the schedule, the stored-ideas list, the run's last step, and the
// review, each in the readings the drawing gives it.
//
// ONE FACTORY, TWO AXES. cinatra#3162 asks for "a new run-step-family factory,
// parameterized by step kind (skills/schedule/idea/review) and step state
// (open/running/fired/placeholder)", and that is exactly the shape below: a
// family shape every surface of the run page owes the drawing, then ONE
// assertion per step KIND and ONE per step STATE. Both maps are TOTAL Records
// over their union, so a new kind or a new state is a compile error rather than
// a surface that quietly rides the family shape alone.
//
// ONE LIST, ONE MAP. The rows live in run-step-rail-family.ts, keyed by the
// manifest surface id, and the map below is built FROM them: being listed is
// being mapped, so there is no second place a surface could be forgotten.
//
// WHAT IS ON THE BRANCH, AND WHAT IS NOT. Grounded by reading the shipped tree,
// never assumed. The rail IS shipped and IS mounted by this wave
// (src/app/design-fixtures/conformance/run-step-rail-conformance-fixtures.tsx
// mounts the real `RunStepRailPanel`), so its whole battery runs for real. Of
// the family's declared action-and-outcome pairs, exactly ONE is a literal
// anywhere in src/ or packages/ — `open-run-step -> step-detail`, carried on the
// rail root — and even that root does not act on it: the component that turns a
// row press into an open step in the right column is the two-column frame, which
// no core route may import. So every other surface here is guarded by
// `awaitingMount` — the same guard, and the same fail-closed harness anchor, the
// Workspace surfaces have used since cinatra#3152 — and names in its skip reason
// exactly what it is waiting for. Nothing stands in for a surface: every
// assertion is written in full against the drawing's own declarations and runs
// unchanged, for real, the moment a mount exists.

/** The mount of one run-step-rail-family surface. */
function runStepMount(surface: string): string {
  return `[data-surface-id="${surface}"]`;
}

/** One state variant's own mount, drawing the same surface in that reading. */
function runStepVariantMount(surface: string, variant: string): string {
  return `[data-surface-id="${surface}"][data-variant="${variant}"]`;
}

/** The surface itself, inside its mount. It carries the surface anchor. */
function runStepPanel(root: Locator, surface: string): Locator {
  return root.locator(`[data-conformance-id="${surface}"]`);
}

type RunStepAssert = (page: Page, root: Locator) => Promise<void>;

/**
 * WHAT EVERY SURFACE OF THIS FAMILY OWES THE DRAWING, whichever kind it is.
 *
 * Section I: "Selecting a step opens that step's page in the run detail, and the
 * page carries the one card of the step it belongs to ... an answered Skills row
 * is never drawn above the HITL card, the review card, the schedule card or any
 * other card, and two cards are never stacked in one detail."
 */
function runStepFamilyPresent(row: RunStepRailRow): RunStepAssert {
  return async (_page, root) => {
    const panel = runStepPanel(root, row.surface);
    await expect(panel).toBeVisible();
    // ONE PAGE PER GATE: never two cards stacked in one detail.
    expect(
      await panel.locator("[data-lifecycle-card]").count(),
      `${row.surface}: one page per gate — the page carries the ONE card of the step it belongs to, and two cards are never stacked in one detail`,
    ).toBeLessThanOrEqual(1);
    // "Nothing about the run lives on a separate page": a step reads in the run,
    // never as a standalone document lifted out of it.
    await expect(panel.locator('[role="dialog"]')).toHaveCount(0);
  };
}

/** The rail row at a 1-based position, as the rail draws it. */
function railRow(root: Locator, position: number): Locator {
  return root.locator('[data-slot="stepper-item"]').nth(position - 1);
}

/**
 * THE STEP KIND axis. One entry per kind, total over the union — a new kind
 * cannot be added without saying what the drawing owes it.
 */
const RUN_STEP_KIND_ASSERT: Record<RunStepKind, (row: RunStepRailRow) => RunStepAssert> = {
  // Section I — "The surface is a two-column frame: a step rail down the left
  // names the run's ordered steps, and the run detail on the right shows the
  // selected step", and "a gate step opens the gate's own surface in place ...
  // right here in the run detail, under the same rail, never as a standalone
  // document".
  frame: (row) => async (_page, root) => {
    const panel = runStepPanel(root, row.surface);
    await expect(panel.locator('[data-conformance-id="run-step-rail-column"]')).toBeVisible();
    const detail = panel.locator('[data-conformance-id="run-detail-column"]');
    await expect(detail).toBeVisible();
    // The gate reads IN PLACE, in the detail column — not beside the rail as a
    // second frame, and not lifted out of the run.
    expect(await detail.locator("[data-lifecycle-card]").count()).toBeLessThanOrEqual(1);
  },

  // Section I — the rail's own four claims, asserted on the REAL shipped rail
  // this wave mounts: the rows in the run's order with the gates woven in at the
  // point the run reached them; the step the run is paused on highlighted; what
  // is passed above it and what is still to come below; and a resolved gate
  // keeping its place as read-only history that records how it was settled.
  rail: (row) => async (_page, root) => {
    const panel = runStepPanel(root, row.surface);
    // The rail declares, on itself, what selecting a step does.
    await expect(panel).toHaveAttribute(
      "data-action",
      `${SHIPPED_RAIL_ACTION.name} -> ${SHIPPED_RAIL_ACTION.outcome}`,
    );

    const rows = panel.locator('[data-slot="stepper-item"]');
    await expect(rows).toHaveCount(RUN_STEP_RAIL_CONFORMANCE_LABELS.length);
    // "The rail lists the run's steps in order" — in the rail's own DOM order.
    // The expected labels are the wave's own statement of the reading, written
    // out beside the fixture rather than derived from it, so a rail that echoed
    // its input in any order could not satisfy them.
    for (const [index, label] of RUN_STEP_RAIL_CONFORMANCE_LABELS.entries()) {
      await expect(rows.nth(index)).toContainText(label);
    }
    // "merged so that a gate is not a page outside the run but a step in the
    // run": each entry sits INLINE, in its place, and says WHICH it is on
    // itself — the shipped rail publishes `data-rail-kind` and
    // `data-rail-status` on every row, so gate identity is read from the
    // product rather than guessed from a label a work step could also carry.
    for (const [index, kind] of RUN_STEP_RAIL_CONFORMANCE_ROW_KINDS.entries()) {
      await expect(railRow(panel, index + 1).locator("[data-rail-kind]")).toHaveAttribute(
        "data-rail-kind",
        kind,
      );
    }
    for (const [index, status] of RUN_STEP_RAIL_CONFORMANCE_ROW_STATUSES.entries()) {
      await expect(railRow(panel, index + 1).locator("[data-rail-status]")).toHaveAttribute(
        "data-rail-status",
        status,
      );
    }
    for (const position of RUN_STEP_RAIL_CONFORMANCE_GATE_POSITIONS) {
      await expect(
        railRow(panel, position).locator('[data-rail-kind="gate"]'),
      ).toHaveCount(1);
    }

    // "The step the run is paused on is highlighted" — and exactly one is.
    await expect(
      railRow(panel, RUN_STEP_RAIL_CONFORMANCE_PAUSED_POSITION),
    ).toHaveAttribute("data-state", "active");
    await expect(panel.locator('[data-slot="stepper-item"][data-state="active"]')).toHaveCount(1);

    // "steps already passed sit above it, steps still to come below".
    for (const position of RUN_STEP_RAIL_CONFORMANCE_PASSED_POSITIONS) {
      expect(position).toBeLessThan(RUN_STEP_RAIL_CONFORMANCE_PAUSED_POSITION);
      await expect(railRow(panel, position)).toHaveAttribute("data-state", "completed");
    }
    for (const position of RUN_STEP_RAIL_CONFORMANCE_UPCOMING_POSITIONS) {
      expect(position).toBeGreaterThan(RUN_STEP_RAIL_CONFORMANCE_PAUSED_POSITION);
      await expect(railRow(panel, position)).toHaveAttribute("data-state", "inactive");
    }

    // "A resolved gate stays on the rail as read-only history — its entry keeps
    // its place and records how it was settled."
    const settled = railRow(panel, RUN_STEP_RAIL_CONFORMANCE_SETTLED_POSITION);
    await expect(settled).toHaveAttribute("data-state", "completed");
    // Read-only HISTORY, said by the row itself — the shipped gate row marks a
    // resolved gate `data-rail-gate-history` and an unanswered one
    // `data-rail-gate-pending`, so "kept as history" is evidence the product
    // publishes rather than a status word this file infers.
    await expect(settled.locator('[data-rail-gate-history="true"]')).toHaveCount(1);
    await expect(settled.locator('[data-rail-gate-pending="true"]')).toHaveCount(0);
    await expect(settled).toContainText(RUN_STEP_RAIL_CONFORMANCE_SETTLED_DISPOSITION);
    // The gate the run is paused on is the pending one, and it is the only one.
    await expect(
      railRow(panel, RUN_STEP_RAIL_CONFORMANCE_PAUSED_POSITION).locator(
        '[data-rail-gate-pending="true"]',
      ),
    ).toHaveCount(1);
    await expect(panel.locator('[data-rail-gate-pending="true"]')).toHaveCount(1);
  },

  // Section I — the arrival: "It happens on its own: there is nothing for the
  // reader to open or press to bring it."
  notification: (row) => async (_page, root) => {
    const panel = runStepPanel(root, row.surface);
    await expect(panel.locator("button")).toHaveCount(0);
    await expect(panel.locator("a[href]")).toHaveCount(0);
  },

  // Section II — the Skills page carries the chip row and nothing else: "one
  // pill per skill, each carrying a checkbox in front of its label ... and one
  // Continue beneath the list", and "the scheduling form is never drawn on the
  // Skills page".
  skills: (row) => async (_page, root) => {
    const panel = runStepPanel(root, row.surface);
    const pills = panel.locator('[data-conformance-id="suggestion-chips"], [data-skill-pill]');
    expect(await pills.count()).toBeGreaterThan(0);
    await expect(panel.locator('[data-conformance-id="run-schedule-tab"]')).toHaveCount(0);
    await expect(panel.locator('[data-conformance-id="review-target"]')).toHaveCount(0);
  },

  // Section I — "the card frame, and a spinning icon ... It names no status,
  // reports no result and draws nothing to press."
  progress: (row) => async (_page, root) => {
    const panel = runStepPanel(root, row.surface);
    await expect(panel.locator('[data-slot="spinner"]')).toBeVisible();
    await expect(panel.locator('[data-slot="status-pill"]')).toHaveCount(0);
    await expect(panel.locator("button")).toHaveCount(0);
  },

  // Section I — "the standard scheduling step ... the same heading, the same
  // three option rows, the same estimated duration — with no summary panel above
  // it, no status label, no held-steps list and no Adjust to press first",
  // "There is no Run now", and "the Skills row is never drawn on the schedule
  // page".
  schedule: (row) => async (_page, root) => {
    const panel = runStepPanel(root, row.surface);
    await expect(panel.locator('[data-conformance-id="schedule-option-rows"]')).toBeVisible();
    await expect(panel.locator('[data-conformance-id="schedule-duration"]')).toBeVisible();
    for (const forbidden of [
      "schedule-armed-summary",
      "schedule-gated-steps",
      "run-chip-row",
    ]) {
      await expect(panel.locator(`[data-conformance-id="${forbidden}"]`)).toHaveCount(0);
    }
    for (const name of ["Adjust", "Run now"]) {
      await expect(panel.getByRole("button", { name, exact: true })).toHaveCount(0);
    }
  },

  // Section I.1 — "one row per stored idea no draft has used ... the idea's
  // first line as its title over the idea's own text", with "Generate new ideas"
  // and the primary Continue over a hairline floor, and "Nothing is selected for
  // them".
  idea: (row) => async (_page, root) => {
    const panel = runStepPanel(root, row.surface);
    const rows = panel.locator('[data-conformance-id="run-idea-row"]');
    expect(await rows.count()).toBeGreaterThan(0);
    await expect(panel.locator('[data-conformance-id="run-idea-row"][aria-selected="true"]')).toHaveCount(0);
    await expect(
      panel.locator('[data-action="generate-ideas -> ideas-stored"]'),
    ).toBeVisible();
  },

  // Section I.2 — "Every row carries the artifact's title, the type that owns
  // it, the revision the run filed or read, and the control that opens it on its
  // own page", and "Rows are not ranked or graded".
  outputs: (row) => async (_page, root) => {
    const panel = runStepPanel(root, row.surface);
    const first = panel.locator('[data-conformance-id="run-output-row"]').first();
    await expect(first).toBeVisible();
    for (const part of ["title", "type", "revision"]) {
      await expect(first.locator(`[data-conformance-id="run-output-${part}"]`)).toBeVisible();
    }
    await expect(first.locator('[data-action="open-output -> artifact-page"]')).toBeVisible();
    // "a file that could only be typed as bytes is listed like any other row ...
    // never marked as a failure".
    await expect(panel.locator('[data-conformance-id="run-output-failed"]')).toHaveCount(0);
  },

  // Section I.3 — "the same gate header, target, decision bar and prompt window
  // the gate draws anywhere else", and "Both readings end in the same floor —
  // Comment, Regenerate, Continue, over the one Note field".
  review: (row) => async (_page, root) => {
    const panel = runStepPanel(root, row.surface);
    await expect(panel.locator('[data-conformance-id="review-target"]')).toBeVisible();
    await expect(panel.locator('[data-conformance-id="review-decision-bar"]')).toBeVisible();
    await expect(panel.locator('[data-conformance-id="review-prompt-window"]')).toBeVisible();
  },
};

/**
 * THE STEP STATE axis. One entry per state, total over the union — the reading
 * the drawing draws, on top of whatever its kind already owes.
 */
const RUN_STEP_STATE_ASSERT: Record<RunStepState, (row: RunStepRailRow) => RunStepAssert> = {
  // The reading a reader is on and may still act in: never the read-only one,
  // and never a blank plate.
  open: (row) => async (_page, root) => {
    const panel = runStepPanel(root, row.surface);
    await expect(panel).not.toHaveAttribute("data-read-only", "true");
    await expect(panel).not.toHaveText(/^\s*$/);
  },

  // Section I — opened once the run has started: "the same pills read-only,
  // with no Continue".
  running: (row) => async (_page, root) => {
    const panel = runStepPanel(root, row.surface);
    await expect(panel.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
  },

  // Section I — "It names no status, reports no result and draws nothing to
  // press."
  placeholder: (row) => async (_page, root) => {
    const panel = runStepPanel(root, row.surface);
    await expect(panel.locator("button")).toHaveCount(0);
  },

  // Section I — a spent schedule: "opening it shows the form read-only, with no
  // controls at all".
  fired: (row) => async (_page, root) => {
    const panel = runStepPanel(root, row.surface);
    await expect(panel.locator("button")).toHaveCount(0);
    await expect(panel.locator("input:not([disabled]), select:not([disabled])")).toHaveCount(0);
  },

  // Section I — a recurring schedule is not spent: "the same editable rows, the
  // same Save changes and the same Cancel schedule as before the fire".
  "fired-recurring": (row) => async (_page, root) => {
    const panel = runStepPanel(root, row.surface);
    await expect(panel.locator('[data-action="save-schedule -> rearmed"]')).toBeVisible();
    await expect(panel.locator('[data-action="cancel-schedule -> stopped"]')).toBeVisible();
  },

  // Section I.3 — on the post's review "what that display renders is the post
  // itself: its title and its body text. The picture is not in it."
  post: (row) => async (_page, root) => {
    const target = runStepPanel(root, row.surface).locator(
      '[data-conformance-id="review-target"]',
    );
    await expect(target.locator('[data-conformance-id="markdown-display-tabs"]')).toBeVisible();
    await expect(target.locator("img")).toHaveCount(0);
  },

  // Section I.3 — on the featured image's review "the target is the picture
  // drawn by the image display and nothing else — the display carries no
  // Regenerate of its own".
  picture: (row) => async (_page, root) => {
    const target = runStepPanel(root, row.surface).locator(
      '[data-conformance-id="review-target"]',
    );
    await expect(target.locator("img")).toHaveCount(1);
    await expect(
      target.locator('[data-action="regenerate-review -> successor-gate-opened"]'),
    ).toHaveCount(0);
  },

  // Section II — "the Skills entry at the head of the rail".
  placement: (row) => async (_page, root) => {
    const panel = runStepPanel(root, row.surface);
    const rail = root.locator('[data-conformance-id="run-step-rail-column"]');
    await expect(rail.locator("> *").first()).toContainText("Skills");
    await expect(panel).toBeVisible();
  },

  // Section I.2 — "where the run consumed an artifact to make them — that
  // artifact too, marked used".
  listing: (row) => async (_page, root) => {
    const panel = runStepPanel(root, row.surface);
    await expect(panel.locator('[data-conformance-id="run-output-used"]')).toBeVisible();
  },
};

/**
 * A drawn state variant: its own mount, drawing the same surface in that
 * reading. `kind:*` is read off the surface's own declaration, the same way the
 * extension listing card carries its catalog kind.
 */
/**
 * The SEMANTIC treatment a drawn state owes, beyond carrying its own name.
 *
 * A variant mount that only publishes `data-variant="error"` proves the harness
 * labelled itself, not that the surface draws an error. The three states every
 * drawing in this system declares have a drawn treatment with a slot of its own,
 * and W0's own `variantSlotState` already holds the scope surfaces to exactly
 * these slots — this family is held to the same floor.
 */
const RUN_STEP_STATE_SLOT: Readonly<Record<string, string>> = {
  empty: "empty",
  error: "alert",
  loading: "skeleton",
};

function runStepStateVariant(surface: string, variant: string): StateAssert {
  const slot = RUN_STEP_STATE_SLOT[variant];
  return async (page) => {
    const mount = page.locator(runStepVariantMount(surface, variant));
    await expect(mount).toHaveCount(1);
    const panel = runStepPanel(mount, surface);
    await expect(panel).toBeVisible();
    if (slot === undefined) return;
    await expect(
      panel.locator(`[data-slot="${slot}"]`),
      `${surface}: the "${variant}" reading must draw its own treatment (a [data-slot="${slot}"] element), not populated content wearing a data-variant label`,
    ).toBeVisible();
  };
}

function runStepKindState(surface: string, kind: string): StateAssert {
  return async (_page, root) => {
    const panel = runStepPanel(root, surface);
    await expect(panel).toHaveAttribute("data-kind", kind);
    // One kind, declared once: a surface that publishes a second, different
    // `data-kind` beneath itself is drawing two readings at once, and the
    // attribute above would no longer say which one the reader sees.
    await expect(panel.locator(`[data-kind]:not([data-kind="${kind}"])`)).toHaveCount(0);
    await expect(panel).not.toHaveText(/^\s*$/);
  };
}

/**
 * THE FAMILY FACTORY, parameterized by step kind and step state.
 *
 *   - the family shape every surface of the run page owes the drawing,
 *   - the assertion its KIND owes,
 *   - the assertion its STATE owes,
 *   - each field the manifest binds, addressed through the binding the surface
 *     names on itself (`data-field="<name>=<source>"`, the convention the
 *     shipped review target already carries), so a surface bound to the wrong
 *     source cannot resolve the locator at all,
 *   - each action the manifest declares, pressed on the control that declares
 *     exactly that action AND that outcome (`declaredAction`), so a driver
 *     cannot press one control and report another one's outcome,
 *   - every state variant the manifest declares.
 *
 * An aspect this wave names on the row's `unshippedAspects` is left OUT of the
 * driver rather than approximated through something else; the row's readiness
 * sentence says why, and the wave's own test refuses an unshipped aspect that
 * carries no reason.
 */
function runStepRailFamilyDriver(row: RunStepRailRow): SurfaceDriver {
  const unshipped = new Set(row.unshippedAspects);
  const driver: SurfaceDriver = {
    path: HARNESS_PATH,
    root: (page) => page.locator(runStepMount(row.surface)),
    present: async (page, root) => {
      await runStepFamilyPresent(row)(page, root);
      await RUN_STEP_KIND_ASSERT[row.kind](row)(page, root);
      await RUN_STEP_STATE_ASSERT[row.state](row)(page, root);
    },
    fields: {},
    actions: {},
    states: {},
  };

  for (const field of row.fields) {
    const aspect = `field:${field.name}`;
    driver.fields[field.name] = {
      source: field.source,
      assert: unshipped.has(aspect)
        ? async () => {
            test.skip(true, runStepAspectReadiness(row, aspect));
          }
        : async (_page, root) => {
            const panel = runStepPanel(root, row.surface);
            // Exactly ONE element claims this field name, and it claims the
            // source the drawing binds. A surface that annotates the name
            // against a second source, or against the wrong one, fails one half
            // or the other — the pair is what makes the binding checkable.
            await expect(
              panel.locator(`[data-field^="${field.name}="]`),
              `${row.surface}: "${field.name}" must be bound exactly once, and to ${field.source}`,
            ).toHaveCount(1);
            const bound = panel.locator(`[data-field="${field.name}=${field.source}"]`);
            await expect(bound).toHaveCount(1);
            await expect(bound).toBeVisible();
            // A binding that draws nothing is not a reading.
            await expect(bound).not.toHaveText(/^\s*$/);
            // Where the mount publishes the source's own value — the convention
            // the W0 scope-page driver established, so an assertion names a
            // source of truth rather than whatever the page rendered — the drawn
            // reading must BE that value.
            const published = await panel.getAttribute(`data-field-value-${field.name}`);
            if (published !== null) await expect(bound).toHaveText(published);
          },
    };
  }

  for (const action of row.actions) {
    const aspect = `action:${action.name}`;
    driver.actions[action.name] = unshipped.has(aspect)
      ? {
          outcome: action.outcome,
          run: async () => {
            test.skip(true, runStepAspectReadiness(row, aspect));
          },
        }
      : declaredAction(action.name, action.outcome);
  }

  for (const state of row.states) {
    const aspect = `state:${state}`;
    driver.states[state] = unshipped.has(aspect)
      ? async () => {
          test.skip(true, runStepAspectReadiness(row, aspect));
        }
      : state.startsWith("kind:")
        ? runStepKindState(row.surface, state.slice("kind:".length))
        : runStepStateVariant(row.surface, state);
  }

  return driver;
}

/**
 * Why ONE aspect of a surface this wave DOES mount is not asserted.
 *
 * An aspect the default branch does not ship is never dropped from the driver
 * map: an unpinned manifest generates no test for an aspect with no driver, so a
 * silent omission would read as coverage that was never claimed and never
 * skipped. It is registered instead, and SKIPS with this reason — visible in the
 * run, named, and gone the moment the product ships the aspect.
 */
function runStepAspectReadiness(row: RunStepRailRow, aspect: string): string {
  return (
    `${row.surface}: the drawing declares ${aspect}, and the default branch does not ` +
    `ship it — ${row.readiness}. The assertion is written and runs unchanged the ` +
    `moment the product declares the aspect.`
  );
}

/** Why a run-step-rail-family driver skips, named on every skipped test. */
function runStepRailReadiness(row: RunStepRailRow): string {
  return (
    `the surface drawn in section ${row.section} of the artifact-review drawing is not ` +
    `on the default branch yet — ${row.readiness}. Every assertion in this driver is ` +
    `written against the drawing's own declarations and runs unchanged the moment the ` +
    `mount exists.`
  );
}

/** The fourteen drivers, built from the one row list. */
const RUN_STEP_RAIL_FAMILY_DRIVERS: Record<string, SurfaceDriver> = Object.fromEntries(
  RUN_STEP_RAIL_ROWS.map((row) => {
    const driver = runStepRailFamilyDriver(row);
    return [
      row.surface,
      row.mounted ? driver : awaitingMount(row.surface, driver, runStepRailReadiness(row)),
    ];
  }),
);

const NOTIFICATIONS_LIST_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: harnessRoot("notifications-list"),
  present: async (_page, root) => {
    await expect(root.locator("ul li").first()).toBeVisible();
  },
  fields: {
    // title = item.title — the row title renders the item's title, NEVER its id
    // (the fixture item's id shares no token with the title, so a driver reading
    // the wrong field could not false-green).
    title: {
      source: "item.title",
      assert: async (_page, root) => {
        const title = root.locator('[data-field="item.title"]');
        await expect(title).toHaveText("Prospect list finished — 240 rows");
        await expect(title).not.toContainText("notif-");
      },
    },
  },
  actions: {
    // decide-approval -> decided: the eligible approval row's inline decide
    // settles the row (§ decided-row-disappears); the harness reflects the
    // specified outcome on data-outcome.
    "decide-approval": {
      outcome: "decided",
      run: async (_page, root) => {
        await clickUntil(
          root.getByRole("button", { name: "Review & approve", exact: true }),
          async () => {
            await expect(root).toHaveAttribute("data-outcome", "decided", { timeout: 2_000 });
          },
        );
      },
    },
    // "activate" is polymorphic by species (§II): -> navigated on a
    // notification/approval WITH an href (the stretched sibling LINK — proven
    // by the resolved navigation target, never fired in-test), -> toggled on
    // an href-less notification (the stretched sibling BUTTON, which flips
    // read-state exactly like the trailing toggle).
    activate: [
      {
        outcome: "navigated",
        run: async (_page, root) => {
          await expect(
            root.locator('[data-action="activate -> navigated"]').first(),
          ).toHaveAttribute("href", "/data/prospect-lists/240-rows");
        },
      },
      {
        outcome: "toggled",
        run: async (_page, root) => {
          await clickUntil(
            root.locator('[data-action="activate -> toggled"]'),
            async () => {
              await expect(root).toHaveAttribute("data-outcome", "toggled", { timeout: 2_000 });
            },
          );
        },
      },
    ],
    // toggle-read -> toggled: the per-card trailing toggle button (§II "one
    // glyph, two states").
    "toggle-read": {
      outcome: "toggled",
      run: async (_page, root) => {
        await clickUntil(
          root.locator('[data-action="toggle-read -> toggled"]').last(),
          async () => {
            await expect(root).toHaveAttribute("data-outcome", "toggled", { timeout: 2_000 });
          },
        );
      },
    },
    // page-prev -> paged / page-next -> paged: known-total numbered
    // pagination (§VII) — the pager next/prev controls page the FILTERED,
    // post-collapse rendered rows.
    "page-prev": {
      outcome: "paged",
      run: async (_page, root) => {
        // Advance to page 2 first so "Previous" is enabled.
        await root.locator('[data-action="page-next -> paged"]').click();
        await clickUntil(root.locator('[data-action="page-prev -> paged"]'), async () => {
          await expect(root).toHaveAttribute("data-outcome", "paged", { timeout: 2_000 });
        });
      },
    },
    "page-next": {
      outcome: "paged",
      run: async (_page, root) => {
        await clickUntil(root.locator('[data-action="page-next -> paged"]'), async () => {
          await expect(root).toHaveAttribute("data-outcome", "paged", { timeout: 2_000 });
        });
      },
    },
  },
  states: {
    // The one universal empty state — exactly "No notifications" (§V).
    empty: async (page) => {
      await expect(
        page.locator('[data-surface-id="notifications-list"][data-variant="empty"]'),
      ).toContainText("No notifications");
    },
    // The single inline degraded line (§VI) above an otherwise-rendered list.
    error: async (page) => {
      await expect(
        page.locator('[data-surface-id="notifications-list"][data-variant="error"]'),
      ).toContainText("some approvals are currently unavailable");
    },
    // The real list skeleton (notifications-skeletons.tsx) mid-load.
    loading: async (page) => {
      await expect(
        page
          .locator('[data-surface-id="notifications-list"][data-variant="loading"]')
          .locator('[data-slot="feed-row-skeleton"]')
          .first(),
      ).toBeVisible();
    },
  },
};

const NOTIFICATIONS_FILTERS_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: harnessRoot("notifications-filters"),
  present: async (_page, root) => {
    for (const label of ["All", "Needs action", "Unread", "In progress"]) {
      await expect(root.getByRole("button", { name: new RegExp(`^${label}`) })).toBeVisible();
    }
  },
  fields: {},
  actions: {
    // filter -> filtered: selecting a chip narrows the ONE list in place — the
    // surviving rows are a strict subset (approvals, which carry no read-state,
    // never survive the Unread filter). Reflected on data-outcome.
    filter: {
      outcome: "filtered",
      run: async (_page, root) => {
        const rows = root.locator('[data-slot="filtered-rows"] li');
        const before = await rows.count();
        await clickUntil(root.getByRole("button", { name: /^Unread/ }), async () => {
          await expect(root).toHaveAttribute("data-outcome", "filtered", { timeout: 2_000 });
        });
        expect(await rows.count()).toBeLessThan(before);
        await expect(
          root.locator('[data-slot="filtered-rows"] li[data-row-kind="approval"]'),
        ).toHaveCount(0);
      },
    },
  },
  states: {},
};

const NOTIFICATION_ROW_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: harnessRoot("notification-row"),
  present: async (_page, root) => {
    await expect(root.getByText("Import finished")).toBeVisible();
    // The read/unread toggle (§II "one glyph, two states") — approvals never
    // carry one.
    await expect(root.getByRole("button", { name: "Mark as read" }).first()).toBeVisible();
  },
  fields: {},
  actions: {
    // "activate" is polymorphic by species (§II) — see NOTIFICATIONS_LIST_DRIVER.
    activate: [
      {
        outcome: "navigated",
        run: async (_page, root) => {
          await expect(
            root.locator('[data-action="activate -> navigated"]').first(),
          ).toHaveAttribute("href", "/data/imports/finished");
        },
      },
      {
        outcome: "toggled",
        run: async (_page, root) => {
          await clickUntil(
            root.locator('[data-action="activate -> toggled"]'),
            async () => {
              await expect(root).toHaveAttribute("data-outcome", "toggled", { timeout: 2_000 });
            },
          );
        },
      },
    ],
    "toggle-read": {
      outcome: "toggled",
      run: async (_page, root) => {
        await clickUntil(
          root.locator('[data-action="toggle-read -> toggled"]').last(),
          async () => {
            await expect(root).toHaveAttribute("data-outcome", "toggled", { timeout: 2_000 });
          },
        );
      },
    },
  },
  states: {
    loading: async (page) => {
      await expect(
        page
          .locator('[data-surface-id="notification-row"][data-variant="loading"]')
          .locator('[data-slot="feed-row-skeleton"]'),
      ).toBeVisible();
    },
  },
};

const APPROVAL_ROW_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: harnessRoot("approval-row"),
  present: async (_page, root) => {
    await expect(root.getByText("Approve connector install")).toBeVisible();
    // An approval row carries the eligibility status pill (§II), never a read-dot.
    await expect(root.getByText("Awaiting you")).toBeVisible();
  },
  fields: {},
  actions: {
    "decide-approval": {
      outcome: "decided",
      run: async (_page, root) => {
        await clickUntil(
          root.getByRole("button", { name: "Review & approve", exact: true }),
          async () => {
            await expect(root).toHaveAttribute("data-outcome", "decided", { timeout: 2_000 });
          },
        );
      },
    },
    // activate -> navigated: an approval WITH an href renders the stretched
    // sibling link — navigate only, no read semantics (approvals never carry
    // read-state).
    activate: {
      outcome: "navigated",
      run: async (_page, root) => {
        await expect(
          root.locator('[data-action="activate -> navigated"]').first(),
        ).toHaveAttribute("href", "/marketplace/connectors/install/482");
      },
    },
  },
  states: {
    loading: async (page) => {
      await expect(
        page
          .locator('[data-surface-id="approval-row"][data-variant="loading"]')
          .locator('[data-slot="feed-row-skeleton"]'),
      ).toBeVisible();
    },
  },
};

const NOTIFICATIONS_FILTER_RAIL_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: (page) =>
    page.locator('[data-surface-id="notifications-filter-rail"][data-variant="loading"]'),
  present: async (_page, root) => {
    await expect(
      root.locator('[data-conformance-id="notifications-filter-rail"]'),
    ).toBeVisible();
  },
  fields: {},
  actions: {},
  states: {
    // The real filter-rail skeleton (§III): the labelled group in its aria-busy
    // loading state with four chip-shaped toggle-group placeholders plus the
    // trailing "Mark all read" placeholder — five Skeleton elements total.
    loading: async (_page, root) => {
      const rail = root.locator(
        '[data-conformance-id="notifications-filter-rail"][data-state="loading"]',
      );
      await expect(rail).toHaveAttribute("aria-busy", "true");
      await expect(rail.locator('[data-slot="skeleton"]')).toHaveCount(5);
    },
  },
};

const NOTIFICATIONS_BELL_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: harnessRoot("notifications-bell"),
  present: async (_page, root) => {
    await expect(root.getByRole("link", { name: /^Notifications/ })).toBeVisible();
  },
  fields: {},
  actions: {
    // open -> navigated: the bell is a badge + link (no flyout, §IV); the
    // outcome is the navigation TARGET (/notifications), proven by the resolved
    // href exactly as the spec depicts it (same pattern as install-config
    // configure -> connector-setup).
    open: {
      outcome: "navigated",
      run: async (_page, root) => {
        await expect(root.getByRole("link", { name: /^Notifications/ })).toHaveAttribute(
          "href",
          "/notifications",
        );
      },
    },
  },
  states: {
    // The real bell loading presentation (packages/notifications bell-skeleton).
    loading: async (page) => {
      const skeleton = page.locator(
        '[data-surface-id="notifications-bell"][data-variant="loading"] [data-conformance-id="notifications-bell"][data-state="loading"]',
      );
      await expect(skeleton).toHaveAttribute("aria-busy", "true");
      await expect(skeleton.locator('[data-slot="skeleton"]')).toBeVisible();
    },
  },
};

const NOTIFICATIONS_EMPTY_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: (page) => page.locator('[data-surface-id="notifications-empty"][data-variant="empty"]'),
  present: async (_page, root) => {
    await expect(root).toContainText("No notifications");
  },
  fields: {},
  actions: {},
  states: {
    empty: async (_page, root) => {
      await expect(root).toContainText("No notifications");
    },
  },
};

const NOTIFICATIONS_VENDOR_GATE_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: (page) =>
    page.locator('[data-surface-id="notifications-vendor-gate"][data-variant="empty"]'),
  present: async (_page, root) => {
    // Non-vacuous: the non-vendor instance DOES render its notifications +
    // approvals (the absence is of VENDOR content, not of all content).
    await expect(root.locator("[data-source-id]")).toHaveCount(2);
    await expect(root.getByText("Approve access scope for Outreach agent")).toBeVisible();
  },
  fields: {},
  actions: {},
  states: {
    // Absence contract (§V): the rendered source-id set is EXACTLY the
    // non-vendor set; NEITHER vendor-gated source id (marketplace-vendor-app-
    // status / -moderation, gated behind isRegisteredVendor) appears. A leaked
    // vendor row would carry one of those ids and break the exact-set check, so
    // this is not a vacuous assertion over a marker that never exists.
    empty: async (_page, root) => {
      const gated = ((await root.getAttribute("data-vendor-gated-source-ids")) ?? "")
        .split(" ")
        .filter(Boolean);
      expect(gated.length).toBeGreaterThan(0);
      for (const sourceId of gated) {
        await expect(root.locator(`[data-source-id="${sourceId}"]`)).toHaveCount(0);
      }
      await expect(root.locator("[data-source-id]")).toHaveCount(2);
      await expect(root.locator('[data-source-id="agent-creation-requests"]')).toHaveCount(1);
      await expect(root.locator('[data-source-id="notification"]')).toHaveCount(1);
    },
  },
};

const NOTIFICATIONS_DEGRADED_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: (page) =>
    page.locator('[data-surface-id="notifications-degraded"][data-variant="error"]'),
  present: async (_page, root) => {
    await expect(root).toContainText("some approvals are currently unavailable");
  },
  fields: {},
  actions: {},
  states: {
    error: async (_page, root) => {
      await expect(root).toContainText("some approvals are currently unavailable");
    },
  },
};

// ---------------------------------------------------------------------------
// §II connector-SETUP drivers (cinatra#2354) — the four surfaces the pinned
// app-connectors manifest gained relative to its two-surface predecessor:
// connector-setup, connector-config-tab, connector-multi-setup,
// connector-connections. Mounted on the base conformance harness by
// src/app/design-fixtures/conformance/connector-setup-fixture.tsx and
// connector-multi-connection-fixture.tsx.
//
// Each driver asserts against the conformance id the PRODUCT component emits
// (sdk-ui ConnectorSetupColumns / ConnectionsList, and the schema-config
// form's custom-tab panel) — the harness `data-surface-id` wrapper only
// selects WHICH mount/variant, so a driver can never pass against harness-only
// chrome. Field keys ARE the manifest sources (`config.apiKey` → key
// `apiKey`), and every seeded value is an anti-lookalike token, so a
// wrong-source read reds.
// ---------------------------------------------------------------------------

/** The single-connection setup mount, by variant. */
const setupTabbed = (variant: string) =>
  `[data-surface-id="connector-setup-tabbed"][data-variant="${variant}"]`;
/** The tabbed multi-connection setup mount, by variant. */
const multiMount = (variant: string) =>
  `[data-surface-id="connector-multi"][data-variant="${variant}"]`;
/** A standalone Connections-list mount, by variant. */
const connectionsMount = (variant: string) =>
  `[data-surface-id="connector-connections"][data-variant="${variant}"]`;

const SCHEMA_FORM = '[data-testid="schema-config-form"]';

/**
 * Fulfil the host action endpoint (`/api/extensions/{installId}/actions/{id}`)
 * at the NETWORK boundary.
 *
 * That endpoint requires an authenticated session and a canonical
 * installed_extension row — neither of which the standalone conformance boot
 * has by construction (the same reason the approvals / scheduling /
 * notifications surfaces are modelled rather than driven through their real
 * screens). Substituting it here, in the suite, rather than behind an
 * injection prop keeps the components under test BYTE-IDENTICAL to production:
 * the real `invokeAction` fetch runs, the real result parsing runs, and every
 * state transition it feeds — the connected flip that releases the gated
 * Disconnect, the probe's badge transition, the cinatra#1109 banner-variant
 * toast — is the real machinery. Only the round-trip is replaced.
 *
 * Per-action payloads: the config tab's save returns the `{ banner }` result
 * its schema declares, so `save-config -> saved` resolves the DECLARED
 * variant's message and cannot pass on a generic confirmation.
 */
type ActionCall = { actionId: string; body: Record<string, unknown> };

/** The fixture connectors' WRITE action ids (everything else is a read). */
const WRITE_ACTION_IDS = new Set([
  "saveConnection",
  "clearConnection",
  "createServer",
  CONNECTOR_CONFIG_TAB.saveActionId,
]);

/** Action ids the fixture connectors declare — anything else is a driver bug. */
const KNOWN_ACTION_IDS = new Set([
  ...WRITE_ACTION_IDS,
  "connectionStatus",
  "helpContentReady",
]);

type ActionLog = {
  /** Dispatches the stub accepted, in order. */
  accepted: ActionCall[];
  /** Dispatches the stub REFUSED (wrong method / install / unknown action). */
  rejected: string[];
};

async function stubConnectorActionEndpoint(page: Page): Promise<ActionLog> {
  const calls: ActionCall[] = [];
  const rejected: string[] = [];
  await page.route("**/api/extensions/*/actions/*", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const parts = pathname.split("/");
    const actionId = decodeURIComponent(parts.pop() ?? "");
    const installId = decodeURIComponent(parts[parts.length - 2] ?? "");
    // FAIL CLOSED on anything the fixtures do not declare: a wrong method,
    // a stray install id, or an unknown action must surface as a 400 the
    // driver's outcome assertion then fails on — never a blanket success that
    // could green-light a misrouted dispatch.
    if (
      request.method() !== "POST" ||
      installId !== CONNECTOR_SETUP_INSTALL_ID ||
      !KNOWN_ACTION_IDS.has(actionId)
    ) {
      rejected.push(`${request.method()} ${pathname}`);
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          error: `unexpected action dispatch: ${request.method()} ${pathname}`,
        }),
      });
      return;
    }
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
    } catch {
      body = {};
    }
    calls.push({ actionId, body });
    const result =
      actionId === CONNECTOR_CONFIG_TAB.saveActionId ? { banner: "saved" } : {};
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ result }),
    });
  });
  return { accepted: calls, rejected };
}

/**
 * Assert the dispatch log for `actionId` and return the payload it carried.
 *
 * LAST rather than only: a hydration-sensitive click is retried (clickUntil),
 * and a pre-hydration click that WAS delivered would make an "exactly one"
 * assertion flaky. So the retries are tolerated but NOT ignored:
 *   - the stub must have refused NOTHING (an unexpected method/install/action
 *     anywhere in this test is a red, not a silently dropped request),
 *   - the WRITE actions dispatched must be EXACTLY the one under assertion
 *     (asserting `connect` cannot pass while a stray `disconnect` also fired;
 *     a read-only action must have triggered no write at all), and
 *   - every retry of this action must have submitted the IDENTICAL payload, so
 *     an earlier malformed dispatch cannot hide behind a later good one.
 *
 * Reads (the status probe, the Help advisories' readiness probes) are mount-
 * time and incidental, so they are not constrained here.
 */
function assertDispatch(log: ActionLog, actionId: string): Record<string, unknown> {
  expect(
    log.rejected,
    `the action endpoint refused unexpected dispatch(es): ${log.rejected.join(", ")}`,
  ).toEqual([]);
  const writes = [
    ...new Set(log.accepted.map((c) => c.actionId).filter((id) => WRITE_ACTION_IDS.has(id))),
  ].sort();
  expect(
    writes,
    `unexpected write dispatch alongside "${actionId}"`,
  ).toEqual(WRITE_ACTION_IDS.has(actionId) ? [actionId] : []);
  const matching = log.accepted.filter((c) => c.actionId === actionId);
  expect(
    matching.length,
    `expected at least one "${actionId}" dispatch, saw none (dispatched: ${
      log.accepted.map((c) => c.actionId).join(", ") || "nothing"
    })`,
  ).toBeGreaterThan(0);
  const latest = matching[matching.length - 1]!.body;
  for (const call of matching) {
    expect(
      call.body,
      `retried "${actionId}" dispatches submitted DIFFERENT payloads`,
    ).toEqual(latest);
  }
  return latest;
}

/**
 * Activate the custom config tab of a setup mount. The form force-mounts every
 * panel (so inactive-tab inputs stay collectable) and hides the inactive ones,
 * so the panel is in the DOM but not visible until its trigger is pressed.
 */
async function openConfigTab(page: Page, variant: string): Promise<Locator> {
  const mount = page.locator(setupTabbed(variant));
  const panel = mount.locator('[data-conformance-id="connector-config-tab"]');
  await clickUntil(
    mount.getByRole("tab", { name: CONNECTOR_CONFIG_TAB.tabLabel, exact: true }),
    async () => {
      await expect(panel).toBeVisible({ timeout: 5_000 });
    },
  );
  return panel;
}

/** Assert a text input carries its seeded config value (and nothing else's). */
function boundInput(
  source: string,
  key: string,
  value: string,
): { source: string; assert: (page: Page, root: Locator) => Promise<void> } {
  return {
    source,
    assert: async (_page, root) => {
      await expect(root.locator(`input[name="${key}"]`)).toHaveValue(value);
    },
  };
}

/**
 * A `secret` binding. The vocabulary makes secrets WRITE-ONLY — "the stored
 * value is never echoed back" — so the provable binding is the control's
 * identity plus that write-only contract: the input exists under the manifest's
 * own config key, is masked, and carries NO value (a renderer that echoed the
 * stored secret back into the DOM would be both a binding drift and a leak).
 */
function boundSecret(
  source: string,
  key: string,
): { source: string; assert: (page: Page, root: Locator) => Promise<void> } {
  return {
    source,
    assert: async (_page, root) => {
      const input = root.locator(`input[name="${key}"]`);
      await expect(input).toHaveAttribute("type", "password");
      await expect(input).toHaveValue("");
    },
  };
}

/**
 * A `select` binding: the hidden input the form submits carries the HYDRATED
 * config value and the trigger renders that option's label. Both seeded values
 * are the SECOND option, so a driver reading the first-option fallback (or the
 * schema default) instead of the config value reds.
 */
function boundSelect(
  source: string,
  key: string,
  value: string,
  optionLabel: string,
): { source: string; assert: (page: Page, root: Locator) => Promise<void> } {
  return {
    source,
    assert: async (_page, root) => {
      await expect(root.locator(`input[name="${key}"]`)).toHaveValue(value);
      await expect(root.locator(`[role="combobox"]#${key}`)).toContainText(optionLabel);
    },
  };
}

const CONNECTOR_SETUP_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: (page) =>
    page.locator(`${setupTabbed("populated")} [data-conformance-id="connector-setup"]`),
  present: async (_page, root) => {
    // The §II two-column body: the configuration fields and the 236px status
    // card are BOTH inside the one annotated surface. (The form's FieldSet is
    // this surface's ANCESTOR — the tablist is page-header chrome hoisted
    // above the two-column grid — so the fields column is asserted by its
    // inputs, never by the form wrapper.)
    await expect(root).toHaveAttribute("data-state", "ready");
    await expect(
      root.locator(`input[name="${CONNECTOR_SETUP_CONFIG.apiKey.key}"]`),
    ).toBeVisible();
    await expect(root.locator('[data-testid="connector-connect"]')).toBeVisible();
    await expect(root.locator('[data-testid="connector-status-probe-card"]')).toBeVisible();
  },
  fields: {
    "api-key": boundSecret("config.apiKey", CONNECTOR_SETUP_CONFIG.apiKey.key),
    "project-id": boundInput(
      "config.projectId",
      CONNECTOR_SETUP_CONFIG.projectId.key,
      CONNECTOR_SETUP_CONFIG.projectId.value,
    ),
    "organization-id": boundInput(
      "config.organizationId",
      CONNECTOR_SETUP_CONFIG.organizationId.key,
      CONNECTOR_SETUP_CONFIG.organizationId.value,
    ),
    "service-tier": boundSelect(
      "config.serviceTier",
      CONNECTOR_SETUP_CONFIG.serviceTier.key,
      CONNECTOR_SETUP_CONFIG.serviceTier.value,
      CONNECTOR_SETUP_CONFIG.serviceTier.optionLabel,
    ),
    "default-model": boundSelect(
      "config.defaultModel",
      CONNECTOR_SETUP_CONFIG.defaultModel.key,
      CONNECTOR_SETUP_CONFIG.defaultModel.value,
      CONNECTOR_SETUP_CONFIG.defaultModel.optionLabel,
    ),
  },
  actions: {
    // connect -> connected THROUGH the real machinery: the connector is seeded
    // NOT connected, so the transition is genuine — the form's live connected
    // state flips and the §II item-8 gate on Disconnect is released.
    connect: {
      outcome: "connected",
      run: async (page, root) => {
        const log = await stubConnectorActionEndpoint(page);
        // The form wrapper carrying the live connected state is the SURFACE's
        // ancestor (the tablist sits above the two-column grid), so it is
        // located on the mount, not under the surface root.
        const form = page.locator(setupTabbed("populated")).locator(SCHEMA_FORM);
        await expect(form).not.toHaveAttribute("data-connected", "");
        await expect(root.locator('[data-testid="connector-disconnect"]')).toBeDisabled();
        await clickUntil(root.locator('[data-testid="connector-connect"]'), async () => {
          await expect(form).toHaveAttribute("data-connected", "", { timeout: 5_000 });
        });
        await expect(root.locator('[data-testid="connector-disconnect"]')).toBeEnabled();
        // The connect DISPATCH carried THIS connector's own configuration —
        // the real collectFormInputs scan, scoped to this form.
        //
        // assertDispatch is EXACTLY-ONCE-SET, not exactly-once (see its doc):
        // it tolerates clickUntil retries but requires the set of WRITE actions
        // dispatched anywhere in this test to be exactly {saveConnection}, and
        // every retry to have carried an identical payload. So a stray
        // clearConnection alongside this connect is red, and an earlier
        // malformed payload cannot hide behind a later good one.
        const body = assertDispatch(log, "saveConnection");
        expect(body[CONNECTOR_SETUP_CONFIG.projectId.key]).toBe(
          CONNECTOR_SETUP_CONFIG.projectId.value,
        );
        expect(body[CONNECTOR_SETUP_CONFIG.serviceTier.key]).toBe(
          CONNECTOR_SETUP_CONFIG.serviceTier.value,
        );
        // …and NOT the multi-connection connector's fields (a document-wide
        // input scan would leak the OTHER form's values in here).
        expect(body).not.toHaveProperty(CONNECTOR_MULTI_SETUP_CONFIG.baseUrl.key);
      },
    },
    // disconnect -> confirming: the specified outcome is the CONFIRMATION
    // ceremony, not the removal — Disconnect never writes unconfirmed. The
    // real gate is honoured first (Disconnect is inert until the connector is
    // genuinely connected), so this cannot pass against a dead affordance.
    disconnect: {
      outcome: "confirming",
      run: async (page, root) => {
        const log = await stubConnectorActionEndpoint(page);
        const disconnect = root.locator('[data-testid="connector-disconnect"]');
        await expect(disconnect).toBeDisabled();
        await clickUntil(root.locator('[data-testid="connector-connect"]'), async () => {
          await expect(disconnect).toBeEnabled({ timeout: 5_000 });
        });
        await clickUntil(disconnect, async () => {
          await expect(page.getByRole("alertdialog")).toBeVisible({ timeout: 5_000 });
        });
        const dialog = page.getByRole("alertdialog");
        await expect(dialog).toContainText("Disconnect connector?");
        await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
        await expect(
          dialog.locator('[data-testid="connector-disconnect-confirm"]'),
        ).toBeVisible();
        // "confirming" means NOTHING was written yet: the disconnect action id
        // must NOT have been dispatched by merely opening the confirmation
        // (only the connect that released the gate may appear in the log).
        expect(log.rejected).toEqual([]);
        expect(log.accepted.map((c) => c.actionId)).not.toContain("clearConnection");

        // …and then the ceremony's terminal step, with its PAYLOAD asserted
        // (cinatra#2355, closing the #2382 review note). The confirm button
        // lives in a PORTAL, outside the <form>, so it cannot resolve its own
        // form by `closest()`. It anchors the input scan to the TRIGGER
        // instead — and since cinatra#2357 made the scan's `origin` parameter
        // REQUIRED, that anchoring is the only path there is; the
        // document-wide fallback that would have masked a broken anchor is
        // gone. This assertion is what proves the anchor actually works: a
        // regression that lost the trigger ref would either dispatch an empty
        // body or leak the OTHER form's fields, and both are red here.
        //
        // assertDispatch cannot be used for this one: its exactly-once-SET rule
        // demands the dispatched write actions be exactly {clearConnection},
        // and this driver legitimately dispatched `saveConnection` first to
        // release the §II item-8 gate. So the SAME three guarantees are
        // asserted by hand below against the two-element write set this
        // driver does expect — nothing refused, the write set exactly
        // {saveConnection, clearConnection}, and identical payloads across
        // retries.
        await clickUntil(
          dialog.locator('[data-testid="connector-disconnect-confirm"]'),
          async () => {
            await expect(
              page.locator(setupTabbed("populated")).locator(SCHEMA_FORM),
            ).not.toHaveAttribute("data-connected", "", { timeout: 5_000 });
          },
        );
        expect(log.rejected).toEqual([]);
        // The COMPLETE write set — the guarantee assertDispatch would have
        // given. Without this a stray createServer or saveShellConfig fired by
        // the confirm would go unnoticed.
        expect(
          [
            ...new Set(
              log.accepted
                .map((c) => c.actionId)
                .filter((id) => WRITE_ACTION_IDS.has(id)),
            ),
          ].sort(),
          "unexpected write dispatch alongside the disconnect ceremony",
        ).toEqual(["clearConnection", "saveConnection"]);
        const clears = log.accepted.filter((c) => c.actionId === "clearConnection");
        expect(
          clears.length,
          "the confirm dispatched no clearConnection at all",
        ).toBeGreaterThan(0);
        // Every retry carried the SAME body (the exactly-once-set guarantee,
        // applied to this action by hand).
        for (const call of clears) {
          expect(call.body).toEqual(clears[0].body);
        }
        const clearBody = clears[0].body;
        // The scan reached THIS form through the trigger anchor…
        expect(clearBody[CONNECTOR_SETUP_CONFIG.projectId.key]).toBe(
          CONNECTOR_SETUP_CONFIG.projectId.value,
        );
        expect(clearBody[CONNECTOR_SETUP_CONFIG.serviceTier.key]).toBe(
          CONNECTOR_SETUP_CONFIG.serviceTier.value,
        );
        // …and no further: the OTHER connector's form is a different <form> on
        // the same document, so a scan that lost its anchor and went
        // document-wide would leak those fields in here.
        expect(clearBody).not.toHaveProperty(CONNECTOR_MULTI_SETUP_CONFIG.baseUrl.key);
      },
    },
    // check-connection -> checked: the right-column card runs the connector's
    // OWN declared status-probe action id and resolves the badge to the probe
    // result. Seeded disconnected, so a resolved "connected" badge proves the
    // probe actually ran (never a no-op re-assertion).
    "check-connection": {
      outcome: "checked",
      run: async (page, root) => {
        const log = await stubConnectorActionEndpoint(page);
        const badge = root.locator('[data-slot="connection-status-badge"]');
        await expect(badge).toHaveAttribute("data-status", "disconnected");
        await clickUntil(root.getByRole("button", { name: "Check", exact: true }), async () => {
          await expect(badge).toHaveAttribute("data-status", "connected", { timeout: 10_000 });
        });
        // The card probed the connector's OWN declared status-probe action id
        // ("connectionStatus"); the host never invents a probe id, so a card
        // that resolved its badge WITHOUT dispatching that id is a red.
        // assertDispatch additionally pins that Check is a READ. Its rule is
        // exactly-once-SET, not exactly-once: for a read-only action id it
        // requires the set of WRITE actions dispatched anywhere in this test to
        // be EMPTY, while tolerating the clickUntil retries of the probe itself
        // (each of which must have carried an identical payload).
        assertDispatch(log, "connectionStatus");
      },
    },
  },
  states: {
    // The surface stays MOUNTED in both non-ready variants (it keeps its
    // conformance id) and swaps its body for the state's own treatment — a
    // variant is a state OF the surface, never its absence.
    loading: async (page) => {
      const root = page.locator(
        `${setupTabbed("loading")} [data-conformance-id="connector-setup"][data-state="loading"]`,
      );
      const line = root.locator('[data-slot="connector-setup-loading"]');
      await expect(line).toBeVisible();
      await expect(line).toHaveAttribute("aria-busy", "true");
      await expect(line).toContainText(CONNECTOR_SETUP_LOADING_LABEL);
      // The two-column body is genuinely REPLACED, not merely relabelled.
      await expect(
        root.locator(`input[name="${CONNECTOR_SETUP_CONFIG.apiKey.key}"]`),
      ).toHaveCount(0);
      await expect(root.locator('[data-testid="connector-connect"]')).toHaveCount(0);
    },
    error: async (page) => {
      const root = page.locator(
        `${setupTabbed("error")} [data-conformance-id="connector-setup"][data-state="error"]`,
      );
      const line = root.locator('[data-slot="connector-setup-error"]');
      await expect(line).toBeVisible();
      await expect(line).toHaveAttribute("role", "alert");
      await expect(line).toContainText(CONNECTOR_SETUP_ERROR_LABEL);
      await expect(
        root.locator(`input[name="${CONNECTOR_SETUP_CONFIG.apiKey.key}"]`),
      ).toHaveCount(0);
      await expect(root.locator('[data-testid="connector-connect"]')).toHaveCount(0);
    },
  },
};

const CONNECTOR_CONFIG_TAB_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: (page) =>
    page.locator(`${setupTabbed("populated")} [data-conformance-id="connector-config-tab"]`),
  present: async (page) => {
    const panel = await openConfigTab(page, "populated");
    await expect(panel).toHaveAttribute("data-state", "ready");
    // §II: "a custom tab's content narrows to the Narrow width (max-w-xl ·
    // 576px, §VII)".
    //
    // cinatra#2355 (closing the #2382 review note): this used to say the claim
    // was "asserted structurally by the panel being the annotated surface
    // itself" while the only assertion was `data-state="ready"` — i.e. it was
    // not asserted at all. It is now, on BOTH sides of the same decision: the
    // token the component carries, and the width the browser actually laid
    // out. The viewport here is 1280px wide, so an unbounded panel would
    // measure far past 576 and a token-only check would miss a container that
    // overrode it.
    await expect(panel).toHaveClass(/\bmax-w-xl\b/);
    const box = await panel.boundingBox();
    expect(box, "the config-tab panel has no layout box").not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(576);
  },
  fields: {
    // The tab's inputs are force-mounted with the panel, so a binding is
    // readable without activating the tab; each is still asserted on the
    // ACTIVE panel so a driver cannot pass against a panel the user can
    // never reach.
    "sandbox-enabled": {
      source: "config.shell.enabled",
      assert: async (page) => {
        const panel = await openConfigTab(page, "populated");
        await expect(
          panel.locator(`input[name="${CONNECTOR_CONFIG_TAB.fields.shellEnabled.key}"]`),
        ).toHaveValue(CONNECTOR_CONFIG_TAB.fields.shellEnabled.value);
        await expect(
          panel.getByRole("switch", { name: CONNECTOR_CONFIG_TAB.fields.shellEnabled.label }),
        ).toBeChecked();
      },
    },
    "container-image": {
      source: "config.shell.containerImage",
      assert: async (page) => {
        const panel = await openConfigTab(page, "populated");
        await expect(
          panel.locator(`input[name="${CONNECTOR_CONFIG_TAB.fields.shellContainerImage.key}"]`),
        ).toHaveValue(CONNECTOR_CONFIG_TAB.fields.shellContainerImage.value);
      },
    },
    "max-execution-seconds": {
      source: "config.shell.maxSeconds",
      assert: async (page) => {
        const panel = await openConfigTab(page, "populated");
        await expect(
          panel.locator(`input[name="${CONNECTOR_CONFIG_TAB.fields.shellMaxSeconds.key}"]`),
        ).toHaveValue(CONNECTOR_CONFIG_TAB.fields.shellMaxSeconds.value);
      },
    },
    // The two list bindings serialize to ONE hidden JSON input each — assert
    // the serialized payload AND the visible entry row, so neither half can
    // drift alone.
    "readable-roots": {
      source: "config.shell.readRoots",
      assert: async (page) => {
        const panel = await openConfigTab(page, "populated");
        await expect(
          panel.locator(`input[name="${CONNECTOR_CONFIG_TAB.fields.shellReadRoots.key}"]`),
        ).toHaveValue(JSON.stringify([CONNECTOR_CONFIG_TAB.fields.shellReadRoots.value]));
        await expect(panel.getByRole("textbox", { name: "root 1" })).toHaveValue(
          CONNECTOR_CONFIG_TAB.fields.shellReadRoots.value,
        );
      },
    },
    "allowed-command-prefixes": {
      source: "config.shell.allowedPrefixes",
      assert: async (page) => {
        const panel = await openConfigTab(page, "populated");
        await expect(
          panel.locator(`input[name="${CONNECTOR_CONFIG_TAB.fields.shellAllowedPrefixes.key}"]`),
        ).toHaveValue(JSON.stringify([CONNECTOR_CONFIG_TAB.fields.shellAllowedPrefixes.value]));
        await expect(panel.getByRole("textbox", { name: "prefix 1" })).toHaveValue(
          CONNECTOR_CONFIG_TAB.fields.shellAllowedPrefixes.value,
        );
      },
    },
  },
  actions: {
    // save-config -> saved: §II — "a custom tab ends in its own Save". The
    // outcome is resolved by the REAL result-driven banner machinery: the save
    // returns `{ banner: "saved" }` and the form surfaces the SCHEMA-DECLARED
    // variant's message, so a generic confirmation would not satisfy it.
    "save-config": {
      outcome: "saved",
      run: async (page) => {
        const log = await stubConnectorActionEndpoint(page);
        const panel = await openConfigTab(page, "populated");
        await clickUntil(
          panel.getByRole("button", { name: CONNECTOR_CONFIG_TAB.saveLabel, exact: true }),
          async () => {
            await expect(page.getByText("Shell settings saved.")).toBeVisible({
              timeout: 5_000,
            });
          },
        );
        // The save DISPATCH carried the tab's OWN settings — the custom tab's
        // panel is force-mounted precisely so its inputs stay collectable, and
        // this pins that (a regression that dropped inactive-tab inputs would
        // still toast "saved" but submit nothing).
        //
        // assertDispatch is exactly-once-SET: the WRITE actions dispatched
        // anywhere in this test must be exactly {saveShellConfig} — so a save
        // that also fired the Setup tab's saveConnection is red — and every
        // clickUntil retry must have carried an identical payload.
        const body = assertDispatch(log, CONNECTOR_CONFIG_TAB.saveActionId);
        expect(body[CONNECTOR_CONFIG_TAB.fields.shellContainerImage.key]).toBe(
          CONNECTOR_CONFIG_TAB.fields.shellContainerImage.value,
        );
        expect(body[CONNECTOR_CONFIG_TAB.fields.shellEnabled.key]).toBe(
          CONNECTOR_CONFIG_TAB.fields.shellEnabled.value,
        );
      },
    },
  },
  states: {
    loading: async (page) => {
      const panel = await openConfigTab(page, "loading");
      await expect(panel).toHaveAttribute("data-state", "loading");
      const line = panel.locator('[data-slot="connector-config-tab-loading"]');
      await expect(line).toBeVisible();
      await expect(line).toHaveAttribute("aria-busy", "true");
      await expect(line).toContainText(CONNECTOR_CONFIG_TAB_LOADING_LABEL);
      await expect(
        panel.locator(`input[name="${CONNECTOR_CONFIG_TAB.fields.shellContainerImage.key}"]`),
      ).toHaveCount(0);
    },
    error: async (page) => {
      const panel = await openConfigTab(page, "error");
      await expect(panel).toHaveAttribute("data-state", "error");
      const line = panel.locator('[data-slot="connector-config-tab-error"]');
      await expect(line).toBeVisible();
      await expect(line).toHaveAttribute("role", "alert");
      await expect(line).toContainText(CONNECTOR_CONFIG_TAB_ERROR_LABEL);
      await expect(
        panel.locator(`input[name="${CONNECTOR_CONFIG_TAB.fields.shellContainerImage.key}"]`),
      ).toHaveCount(0);
    },
  },
};

const CONNECTOR_MULTI_SETUP_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: (page) =>
    page.locator(`${multiMount("populated")} [data-conformance-id="connector-multi-setup"]`),
  present: async (_page, root) => {
    await expect(root).toHaveAttribute("data-state", "ready");
    await expect(
      root.locator(`input[name="${CONNECTOR_MULTI_SETUP_CONFIG.baseUrl.key}"]`),
    ).toBeVisible();
    // The multi roll-up card, NOT the single-connection card: a count badge per
    // status in play and no Check control (§II "Multiple connections").
    const card = root.locator('[data-slot="connection-status-card"][data-variant="multi"]');
    await expect(card).toBeVisible();
    await expect(card.locator('[data-slot="connection-status-badge"]')).toHaveCount(2);
    await expect(card.getByRole("button", { name: "Check", exact: true })).toHaveCount(0);
  },
  fields: {
    "server-base-url": boundInput(
      "config.baseUrl",
      CONNECTOR_MULTI_SETUP_CONFIG.baseUrl.key,
      CONNECTOR_MULTI_SETUP_CONFIG.baseUrl.value,
    ),
    "bearer-token": boundSecret(
      "config.bearerToken",
      CONNECTOR_MULTI_SETUP_CONFIG.bearerToken.key,
    ),
  },
  actions: {
    // connect -> connected. This surface declares Connect ONLY (a single
    // connection is disconnected from its own row in the Connections tab), so
    // the transition is witnessed on the form's live connected state rather
    // than on a released Disconnect gate.
    connect: {
      outcome: "connected",
      run: async (page, root) => {
        const log = await stubConnectorActionEndpoint(page);
        const form = page.locator(multiMount("populated")).locator(SCHEMA_FORM);
        await expect(form).not.toHaveAttribute("data-connected", "");
        // No Disconnect on the multi Setup tab (spec §II).
        await expect(root.locator('[data-testid="connector-disconnect"]')).toHaveCount(0);
        await clickUntil(root.locator('[data-testid="connector-connect"]'), async () => {
          await expect(form).toHaveAttribute("data-connected", "", { timeout: 5_000 });
        });
        // The dispatch carried THIS connector's own server config — and NOT
        // the single-connection connector's fields, even though that form is
        // mounted FIRST on the same page. This is the assertion that pins
        // collectFormInputs' per-form scoping.
        //
        // assertDispatch is exactly-once-SET: the WRITE actions dispatched
        // anywhere in this test must be exactly {createServer} — so a click
        // that also reached the OTHER form's saveConnection is red — and every
        // clickUntil retry must have carried an identical payload.
        const body = assertDispatch(log, "createServer");
        expect(body[CONNECTOR_MULTI_SETUP_CONFIG.baseUrl.key]).toBe(
          CONNECTOR_MULTI_SETUP_CONFIG.baseUrl.value,
        );
        expect(body).not.toHaveProperty(CONNECTOR_SETUP_CONFIG.projectId.key);
        expect(body).not.toHaveProperty(CONNECTOR_SETUP_CONFIG.serviceTier.key);
      },
    },
    // view-connections -> connections: the roll-up card's "All connections"
    // control opens the Connections TAB. The tab's content is unmounted until
    // it is selected, so the connections surface APPEARING is the outcome.
    //
    // COVERAGE HONESTY: the control itself is harness-owned — the roll-up card
    // takes the affordance as a slot ("a link-style button", its own contract)
    // and no core screen supplies one yet. What is PINNED here is the product
    // half: that the card renders the affordance in its action slot, and that
    // selecting the tab genuinely MOUNTS the connections surface (which is
    // absent from the DOM beforehand) and marks the tab selected.
    "view-connections": {
      outcome: "connections",
      run: async (page) => {
        const mount = page.locator(multiMount("populated"));
        const connections = mount.locator('[data-conformance-id="connector-connections"]');
        const tab = mount.getByRole("tab", { name: "Connections", exact: true });
        // The affordance is inside the roll-up card's action slot, not loose
        // chrome — a card that stopped rendering its action is a red.
        await expect(
          mount.locator(
            '[data-slot="connection-status-card"][data-variant="multi"] [data-testid="connector-view-connections"]',
          ),
        ).toBeVisible();
        await expect(connections).toHaveCount(0);
        await expect(tab).toHaveAttribute("aria-selected", "false");
        await clickUntil(
          mount.locator('[data-testid="connector-view-connections"]'),
          async () => {
            await expect(connections).toBeVisible({ timeout: 5_000 });
          },
        );
        await expect(tab).toHaveAttribute("aria-selected", "true");
        await expect(connections.locator('[data-slot="connection-row"]')).toHaveCount(
          CONNECTOR_CONNECTION_ROW_COUNT,
        );
      },
    },
  },
  states: {
    loading: async (page) => {
      const root = page.locator(
        `${multiMount("loading")} [data-conformance-id="connector-multi-setup"][data-state="loading"]`,
      );
      const line = root.locator('[data-slot="connector-setup-loading"]');
      await expect(line).toBeVisible();
      await expect(line).toContainText(CONNECTOR_SETUP_LOADING_LABEL);
      await expect(
        root.locator(`input[name="${CONNECTOR_MULTI_SETUP_CONFIG.baseUrl.key}"]`),
      ).toHaveCount(0);
    },
    error: async (page) => {
      const root = page.locator(
        `${multiMount("error")} [data-conformance-id="connector-multi-setup"][data-state="error"]`,
      );
      const line = root.locator('[data-slot="connector-setup-error"]');
      await expect(line).toBeVisible();
      await expect(line).toHaveAttribute("role", "alert");
      await expect(line).toContainText(CONNECTOR_SETUP_ERROR_LABEL);
      await expect(
        root.locator(`input[name="${CONNECTOR_MULTI_SETUP_CONFIG.baseUrl.key}"]`),
      ).toHaveCount(0);
    },
  },
};

const CONNECTION_ROW = '[data-slot="connection-row"]';
const DISCONNECTED_ROW_SEED = CONNECTOR_CONNECTION_ROWS.find((r) => !r.connected)!;
const CONNECTED_ROW_SEED = CONNECTOR_CONNECTION_ROWS.find((r) => r.connected)!;

/** Locate one seeded connection row by its (unique) display name. */
function connectionRow(root: Locator, name: string): Locator {
  return root.locator(CONNECTION_ROW).filter({ hasText: name });
}

const CONNECTOR_CONNECTIONS_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: (page) =>
    page.locator(
      `${connectionsMount("populated")} [data-conformance-id="connector-connections"]`,
    ),
  present: async (_page, root) => {
    // EXACT cardinality, and the connected/disconnected split is asserted
    // against DISTINCT counts (2 vs 1) so counting the wrong subset reds.
    await expect(root.locator(CONNECTION_ROW)).toHaveCount(CONNECTOR_CONNECTION_ROW_COUNT);
    await expect(root.locator(`${CONNECTION_ROW}[data-status="connected"]`)).toHaveCount(
      CONNECTOR_CONNECTION_CONNECTED_COUNT,
    );
    await expect(root.locator(`${CONNECTION_ROW}[data-status="disconnected"]`)).toHaveCount(
      CONNECTOR_CONNECTION_DISCONNECTED_COUNT,
    );
  },
  fields: {},
  // COVERAGE HONESTY (both actions): `ConnectionsList` is presentational by its
  // own contract — "the status→action mapping + the connection-level confirm
  // dialog live in the consumer" — and no CORE screen is that consumer yet (the
  // multi-connection connector self-chromes its setup page). So the harness
  // plays the consumer, exactly as the approvals / scheduling / notifications
  // fixtures do. What these drivers therefore PIN is the product half: the row
  // primitive's status→presentation derivation (its data-status, its badge
  // status AND that badge's own canonical label), the list's cardinality, and
  // the confirm ceremony's shape. They do NOT claim to pin a consumer's wiring
  // that does not exist yet — when a core consumer lands, these drivers should
  // be re-pointed at it.
  actions: {
    // disconnect -> confirming: a CONNECTED row's destructive action opens the
    // confirmation; the row is not disconnected by the click itself.
    disconnect: {
      outcome: "confirming",
      run: async (page, root) => {
        const row = connectionRow(root, CONNECTED_ROW_SEED.name);
        await expect(row).toHaveAttribute("data-status", "connected");
        await clickUntil(row.locator('[data-testid="connection-row-disconnect"]'), async () => {
          await expect(page.getByRole("alertdialog")).toBeVisible({ timeout: 5_000 });
        });
        const dialog = page.getByRole("alertdialog");
        await expect(dialog).toContainText("Disconnect connection?");
        // A destructive confirmation always offers a way OUT (never a
        // one-button trap).
        await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
        // Still connected: "confirming" is the outcome, not the removal.
        await expect(row).toHaveAttribute("data-status", "connected");
        await expect(
          row.locator('[data-slot="connection-status-badge"][data-status="connected"]'),
        ).toContainText("Connected");
      },
    },
    // connect -> connected: the DISCONNECTED row's primary action reconnects
    // THAT row — the real ConnectionRow re-derives its badge (status AND the
    // badge's canonical label) from the new status, and no sibling row moves.
    connect: {
      outcome: "connected",
      run: async (_page, root) => {
        const row = connectionRow(root, DISCONNECTED_ROW_SEED.name);
        await expect(row).toHaveAttribute("data-status", "disconnected");
        await expect(row.locator('[data-slot="connection-status-badge"]')).toContainText(
          "Disconnected",
        );
        await clickUntil(row.locator('[data-testid="connection-row-connect"]'), async () => {
          await expect(row).toHaveAttribute("data-status", "connected", { timeout: 5_000 });
        });
        const badge = row.locator('[data-slot="connection-status-badge"][data-status="connected"]');
        await expect(badge).toBeVisible();
        // The badge's label is the component's own canonical map, not text the
        // harness passed in — a status→label drift is a red.
        await expect(badge).toHaveText("Connected");
        // Exactly ONE row moved; every sibling kept its seeded status.
        await expect(root.locator(`${CONNECTION_ROW}[data-status="connected"]`)).toHaveCount(
          CONNECTOR_CONNECTION_CONNECTED_COUNT + 1,
        );
        await expect(root.locator(`${CONNECTION_ROW}[data-status="disconnected"]`)).toHaveCount(
          CONNECTOR_CONNECTION_DISCONNECTED_COUNT - 1,
        );
      },
    },
  },
  states: {
    // No saved connections yet — the list's own empty treatment, never a bare
    // (silently blank) column.
    empty: async (page) => {
      const root = page.locator(
        `${connectionsMount("empty")} [data-conformance-id="connector-connections"][data-state="empty"]`,
      );
      await expect(root).toContainText(CONNECTOR_CONNECTIONS_EMPTY_LABEL);
      await expect(root.locator(CONNECTION_ROW)).toHaveCount(0);
    },
    loading: async (page) => {
      const root = page.locator(
        `${connectionsMount("loading")} [data-conformance-id="connector-connections"][data-state="loading"]`,
      );
      await expect(root).toContainText(CONNECTOR_CONNECTIONS_LOADING_LABEL);
      await expect(root.locator(CONNECTION_ROW)).toHaveCount(0);
    },
  },
};

// ---------------------------------------------------------------------------
// extension-install-panel (cinatra#2373, design spec §I.1).
//
// The panel is a FACE of the card, not a separate route: every assertion below
// opens it from the card's own Install now first, which is the only way a user
// reaches it. The surface root is the harness mount, so `present`/fields/actions
// all resolve inside one card.
// ---------------------------------------------------------------------------
const INSTALL_PANEL_MOUNT = '[data-surface-id="extension-install-panel"]';
const INSTALL_PANEL_FACE = '[data-testid="extension-install-panel"]';

/**
 * A `<Type>: <name>` access label as it actually reaches the DOM. Since
 * cinatra#2372 both the trigger and the row render the type prefix and the name
 * as two sibling elements separated by a CSS gap, so their text carries no
 * separating space. Every literal part is regex-escaped; only the separator
 * after the FIRST colon becomes whitespace-optional, which is where the gap is.
 */
function typeNamePairPattern(label: string): RegExp {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const at = label.indexOf(": ");
  if (at === -1) return new RegExp(escape(label));
  return new RegExp(
    `${escape(label.slice(0, at + 1))}\\s*${escape(label.slice(at + 2))}`,
  );
}

/**
 * Open the panel from the idle card's CTA, retrying through hydration (a click
 * landing before React hydrates is silently swallowed on the standalone build).
 */
async function openInstallPanel(root: Locator): Promise<Locator> {
  const face = root.locator(INSTALL_PANEL_FACE);
  await expect(async () => {
    await root.locator('[data-testid="extension-install-panel-open"]').click();
    await expect(face).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  return face;
}

/** The idle face is back and no panel is mounted anywhere in this card. */
async function expectCardRestored(root: Locator): Promise<void> {
  const cta = root.locator('[data-testid="extension-card-cta"]');
  await expect(cta).toHaveAttribute("data-cta-state", "install");
  await expect(cta.getByRole("button", { name: "Install now" })).toBeVisible();
  // Exactly ONE face is ever mounted — the install face is GONE, not hidden.
  await expect(root.locator(INSTALL_PANEL_FACE)).toHaveCount(0);
}

const INSTALL_PANEL_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: (page) => page.locator(INSTALL_PANEL_MOUNT),
  present: async (_page, root) => {
    const face = await openInstallPanel(root);
    // The header band carried over and the body swapped (spec §I.1).
    await expect(face.locator('[data-slot="extension-card-name"]')).toBeVisible();
    await expect(face.locator('[data-testid="extension-install-panel-body"]')).toBeVisible();
    // No popup anywhere on this path.
    await expect(_page.locator('[role="dialog"]')).toHaveCount(0);
  },
  fields: {
    // name = manifest.displayName — the header band's name, carried over from
    // the idle card unchanged, bound to the display name and never the package
    // name (the exact drift the annotated spec forbids).
    name: {
      source: "manifest.displayName",
      assert: async (_page, root) => {
        const face = await openInstallPanel(root);
        const name = face.locator('[data-slot="extension-card-name"]');
        await expect(name).toHaveText(CONFORMANCE_INSTALL_PANEL_FIXTURE.displayName);
        await expect(name).not.toContainText(CONFORMANCE_INSTALL_PANEL_FIXTURE.packageName);
      },
    },
  },
  actions: {
    "close-panel": {
      outcome: "card-restored",
      run: async (_page, root) => {
        const face = await openInstallPanel(root);
        await face.locator('[data-testid="extension-install-panel-close"]').click();
        await expectCardRestored(root);
      },
    },
    "open-picker": {
      outcome: "options-listed",
      run: async (page, root) => {
        const face = await openInstallPanel(root);
        const picker = face.locator('[data-testid="extension-install-panel-picker"]');
        // The closed trigger renders the preselected row VERBATIM (spec §I.1:
        // "its closed value renders exactly as the row reads"). Since
        // cinatra#2372 the TRIGGER composes the same two gap-separated elements
        // the row does, so — exactly like the row assertions below — its text
        // carries no separating space and the pair must be matched.
        const trigger = picker.getByRole("combobox");
        await expect(trigger).toContainText(typeNamePairPattern(CONFORMANCE_INSTALL_PANEL_DEFAULT_LABEL));
        await trigger.click();
        // Outcome "options-listed": the server-offered rows are listed. The
        // popover is PORTALLED, so it is searched on the page, not in the card
        // — which is also the proof it escapes the panel's overflow.
        //
        // A ROW renders its `<Type>:` prefix and its name as two elements with
        // a CSS gap, so its text carries no separating space; match the pair.
        const options = page.getByRole("option");
        await expect(options.filter({ hasText: /Workspace:\s*All/ })).toBeVisible();
        await expect(options.filter({ hasText: /Workspace:\s*Admins only/ })).toBeVisible();
        await expect(options.filter({ hasText: /Team:\s*Finance/ })).toBeVisible();
      },
    },
    "cancel-install": {
      outcome: "card-restored",
      run: async (_page, root) => {
        const face = await openInstallPanel(root);
        await face.locator('[data-testid="extension-install-panel-cancel"]').click();
        await expectCardRestored(root);
      },
    },
    "submit-install": {
      outcome: "installed",
      run: async (_page, root) => {
        const face = await openInstallPanel(root);
        await face.locator('[data-testid="extension-install-panel-submit"]').click();
        // Outcome "installed": the REAL resolveMarketplaceCardCta re-derives
        // the CTA from the mutated install state, so the card comes back in
        // the §I Installed presentation — and the panel is gone with it.
        const cta = root.locator('[data-testid="extension-card-cta"]');
        await expect(cta).toHaveAttribute("data-cta-state", "installed", { timeout: 15_000 });
        await expect(cta.getByRole("button", { name: "Installed" })).toBeDisabled();
        await expect(root.locator(INSTALL_PANEL_FACE)).toHaveCount(0);
      },
    },
  },
  states: {},
};

// ---------------------------------------------------------------------------
// The REVIEW-COMPOSER family (cinatra#3159, epic #3155 W3)
// ---------------------------------------------------------------------------
//
// §I of the in-conversation drawing puts ONE row above the review floor and
// gives it THREE readings and ONE control. The manifest surfaces below are the
// readings of that one row, plus the group the drawing draws the two unbound
// ones in, plus the chat box the row is about. So they are driven together, over
// one harness that mounts the SHIPPED row fed by the SHIPPED binding hook inside
// the SHIPPED focus store.
//
// EVERY ASPECT DRIVEN HERE IS SHIPPED ON THE DEFAULT BRANCH after this wave's
// one first-party change: the row's control now carries the name the drawing
// gives it in the reading it is drawn in — `release-review-composer -> unbound`
// while bound, `focus-review-composer -> bound` while not — instead of one name
// for both readings, which said the opposite of what the press does in one of
// them. testid-contract.json requires each of those literals in the file that
// ships them, so a driver naming a control the product does not ship is RED in
// scripts/design/check-conformance-testids.mjs before any browser opens.
//
// THE READING IS NEVER ASSERTED FROM THE HARNESS. Every assertion below reads
// the shipped row's own attributes and the shipped sentence's own conformance
// id. The harness holds one thing — which open review the reader chose — and
// `resolveComposerTarget` turns that into the reading.
//
// The manifest's aspects elsewhere in this family that no shipped control
// carries are NOT driven here, and are not approximated through a different
// control either. They are on this wave's surface-readiness list.

/** The §I row of one mounted fixture row. */
function composerRow(root: Locator): Locator {
  return root.locator('[data-conformance-id="review-composer-focus"]').first();
}

/**
 * The row's one control, addressed by the MANIFEST'S OWN action name.
 *
 * The shipped attribute is written `"<action> -> <outcome>"`, so this locator
 * cannot resolve at all unless the product ships a control for exactly the
 * action-and-outcome pair the manifest declares — which is what stops a driver
 * from pressing one control and reporting another one's outcome. It is also
 * exactly the property this wave had to make true: before it, the one toggle
 * carried a single name in both readings.
 */
function composerOffering(root: Locator, action: string, outcome: string): Locator {
  return composerRow(root).locator(`[data-action="${action} -> ${outcome}"]`);
}

/**
 * Press until the reaction is observed. Same hydration retry as
 * `pressChipUntil`: a click that lands before React hydration is silently
 * swallowed on the production standalone build.
 */
async function pressComposerUntil(control: Locator, reacted: () => Promise<void>): Promise<void> {
  await expect(async () => {
    await control.click();
    await reacted();
  }).toPass({ timeout: 30_000 });
}

/** The row is drawn, in the reading the shipped resolver put it in. */
async function expectReading(
  root: Locator,
  reading: { bound: boolean; ambiguous: boolean; sentence: string },
): Promise<void> {
  // ONE row per mount. `composerRow` takes the first match so a group root can
  // still be read through, which means the COUNT has to be asserted here: a
  // double mount would otherwise let every reading below, and every press, run
  // against a copy while the other row went unchecked.
  await expect(root.locator('[data-conformance-id="review-composer-focus"]')).toHaveCount(1);
  const row = composerRow(root);
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-composer-bound", String(reading.bound));
  await expect(row).toHaveAttribute("data-composer-ambiguous", String(reading.ambiguous));
  await expect(row.locator(`[data-conformance-id="${reading.sentence}"]`)).toBeVisible();
}

const COMPOSER_BOUND = { bound: true, ambiguous: false, sentence: "review-composer-bound" };
const COMPOSER_AMBIGUOUS = {
  bound: false,
  ambiguous: true,
  sentence: "review-composer-ambiguous",
};
const COMPOSER_UNBOUND = { bound: false, ambiguous: false, sentence: "review-composer-unbound" };

/**
 * The `release-review-composer -> unbound` driver: the reader GIVES THE BINDING
 * BACK.
 *
 * §I: "The binding is always refusable … one press gives it back — because a
 * lone review would otherwise turn every chat message into a comment." So the
 * outcome is read as the drawing states it: the row leaves the bound reading,
 * says so in the shipped sentence, and the same one control now offers the way
 * back — the toggle is its own inverse, exactly as the suggestion chip is.
 */
function releaseComposerAction(): {
  outcome: string;
  run: (page: Page, root: Locator) => Promise<void>;
} {
  return {
    outcome: "unbound",
    run: async (_page, root) => {
      await expectReading(root, COMPOSER_BOUND);
      await pressComposerUntil(
        composerOffering(root, "release-review-composer", "unbound"),
        async () => {
          await expect(composerRow(root)).toHaveAttribute("data-composer-bound", "false", {
            timeout: 5_000,
          });
        },
      );
      await expectReading(root, COMPOSER_UNBOUND);
      // ONE control per row: the bound reading is gone and the same control now
      // offers the way back.
      await expect(
        composerRow(root).locator('[data-conformance-id="review-composer-bound"]'),
      ).toHaveCount(0);
      await expect(composerOffering(root, "focus-review-composer", "bound")).toHaveCount(1);
    },
  };
}

/**
 * The `focus-review-composer -> bound` driver: the reader TAKES the binding on a
 * row that does not hold it.
 */
function focusComposerAction(from: {
  bound: boolean;
  ambiguous: boolean;
  sentence: string;
}): { outcome: string; run: (page: Page, root: Locator) => Promise<void> } {
  return {
    outcome: "bound",
    run: async (_page, root) => {
      await expectReading(root, from);
      await pressComposerUntil(
        composerOffering(root, "focus-review-composer", "bound"),
        async () => {
          await expect(composerRow(root)).toHaveAttribute("data-composer-bound", "true", {
            timeout: 5_000,
          });
        },
      );
      await expectReading(root, COMPOSER_BOUND);
      await expect(composerOffering(root, "release-review-composer", "unbound")).toHaveCount(1);
    },
  };
}

function composerRowDriver(
  mount: LifecycleComposerRowMount,
  reading: { bound: boolean; ambiguous: boolean; sentence: string },
): SurfaceDriver {
  return {
    path: HARNESS_PATH,
    root: (page) => page.locator(`[data-surface-id="${mount}"]`),
    present: async (_page, root) => {
      await expectReading(root, reading);
    },
    fields: {},
    actions: {},
    states: {},
  };
}

/**
 * §I's row itself, drawn bound: the reading, and the control that gives the
 * binding back.
 */
const REVIEW_COMPOSER_FOCUS_DRIVER: SurfaceDriver = {
  ...composerRowDriver("composer-row-bound", COMPOSER_BOUND),
  actions: { "release-review-composer": releaseComposerAction() },
};

/**
 * The same row in the section that draws it while the bound composer's own
 * message is being acted on. Its own mount, because the drawing draws it in its
 * own place; the manifest gives it the same one action.
 */
const COMPOSER_BOUND_ACTING_DRIVER: SurfaceDriver = {
  ...composerRowDriver("composer-row-acting", COMPOSER_BOUND),
  actions: { "release-review-composer": releaseComposerAction() },
};

/**
 * The example the drawing captions "waiting to be told which review, or given
 * back" — BOTH unbound readings drawn together, and the control that ends the
 * waiting.
 */
const REVIEW_COMPOSER_UNBOUND_CARD_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: (page) => page.locator('[data-surface-id="composer-rows-unbound"]'),
  present: async (_page, root) => {
    // Both readings, each in its own row, in the order the drawing shows them.
    await expectReading(root.locator('[data-surface-id="composer-row-choosing"]'), COMPOSER_AMBIGUOUS);
    await expectReading(root.locator('[data-surface-id="composer-row-elsewhere"]'), COMPOSER_UNBOUND);
  },
  fields: {},
  actions: {
    // The press lands on the row that is WAITING to be told which review: that
    // is the reading whose control takes the binding for the reader.
    "focus-review-composer": {
      outcome: "bound",
      // BOTH drawn controls, in one test. The drawing draws this example as two
      // rows and the manifest declares the control on it TWICE, once per row;
      // the generated battery collapses two identical declarations into one
      // test, so unless this one test presses both, the second row's control is
      // never exercised and could be missing, misnamed or dead while the
      // surface stayed green. The two rows are separate mounts holding their own
      // shipped stores, so neither press moves the other row's reading — which
      // is itself asserted at the end.
      run: async (page, root) => {
        const choosing = root.locator('[data-surface-id="composer-row-choosing"]');
        const elsewhere = root.locator('[data-surface-id="composer-row-elsewhere"]');
        // The row that is WAITING to be told which review.
        await focusComposerAction(COMPOSER_AMBIGUOUS).run(page, choosing);
        // And the ambiguity is answered: the prompt is gone from the row that
        // now holds the binding.
        await expect(
          composerRow(choosing).locator('[data-conformance-id="review-composer-ambiguous"]'),
        ).toHaveCount(0);
        // The row whose binding was GIVEN BACK, drawn beside it: its own
        // control, its own press, the manifest's second declaration.
        await focusComposerAction(COMPOSER_UNBOUND).run(page, elsewhere);
        // One press did not move the other row's reading.
        await expectReading(choosing, COMPOSER_BOUND);
      },
    },
  },
  states: {},
};

/** §I's ONE primary input: the conversation's chat box. */
const CHAT_COMPOSER_PRIMARY_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: (page) => page.locator(`[data-surface-id="${LIFECYCLE_CHAT_COMPOSER_MOUNT}"]`),
  present: async (_page, root) => {
    const field = root.locator('[data-conformance-id="chat-composer-primary"]');
    await expect(field).toBeVisible();
    // §I: the chat box is the one primary input, and a card's subordinate note
    // field can never read as its peer. The heavier edge is what draws that
    // difference, and the shipped field takes it from its own `primary`
    // declaration.
    await expect(field).toHaveClass(/border-line-strong/);
    // It is an input, not a picture of one.
    await expect(field.locator("[contenteditable]")).toBeVisible();
  },
  fields: {},
  actions: {},
  states: {},
};

/**
 * The manifest surfaces each harness mount stands for.
 *
 * It lives HERE, on the test side, for the reason the fixture-data file gives:
 * one drawn row stands for several manifest surfaces, so a `data-surface-id` per
 * surface would have to repeat one row under several names. Keyed by the mount
 * union, so a new mount with no manifest surface is a typecheck failure rather
 * than an undefined driver key.
 */
const COMPOSER_ROW_MANIFEST_SURFACES: Readonly<
  Record<LifecycleComposerRowMount, readonly string[]>
> = {
  "composer-row-bound": ["review-composer-focus", "review-composer-bound"],
  "composer-row-acting": ["composer-bound-acting"],
  "composer-rows-unbound": ["review-composer-unbound-card"],
  "composer-row-choosing": ["review-composer-ambiguous"],
  "composer-row-elsewhere": ["review-composer-unbound"],
  "chat-composer-primary-field": ["chat-composer-primary"],
};

/** The drivers this family registers, one per manifest surface above. */
export const COMPOSER_FAMILY_DRIVERS: Readonly<Record<string, SurfaceDriver>> = {
  "review-composer-focus": REVIEW_COMPOSER_FOCUS_DRIVER,
  "review-composer-bound": composerRowDriver("composer-row-bound", COMPOSER_BOUND),
  "composer-bound-acting": COMPOSER_BOUND_ACTING_DRIVER,
  "review-composer-unbound-card": REVIEW_COMPOSER_UNBOUND_CARD_DRIVER,
  "review-composer-ambiguous": composerRowDriver("composer-row-choosing", COMPOSER_AMBIGUOUS),
  "review-composer-unbound": composerRowDriver("composer-row-elsewhere", COMPOSER_UNBOUND),
  "chat-composer-primary": CHAT_COMPOSER_PRIMARY_DRIVER,
};

/**
 * Aspects a manifest surface this family DRIVES declares, and this wave does
 * NOT drive — named here, with the reason, instead of being left to the skip.
 *
 * An unpinned manifest SKIPS a declared aspect with no driver entry silently, so
 * an omission inside an otherwise-covered surface is invisible until the pin
 * lands and turns it into a red. Naming it makes the omission a decision on the
 * record and, through the check in functional-acceptance.spec.ts, makes any
 * FUTURE omission fail the battery rather than disappear into the skip.
 *
 * `review-composer-unbound-card`'s three states are the CARD's states, not the
 * row's: the surface's control lives on the two rows this family mounts, but
 * `empty`, `kind:artifact` and `loading` are readings of the review card those
 * rows sit above, and the card cannot be composed outside itself. That is the
 * same wall the rest of this wave's deferred surfaces meet, and it is on the
 * wave's surface-readiness list.
 *
 * This is NOT an allowlist entry and buys no exemption at the pin gate: it is a
 * statement of what is still owed before this drawing can be pinned.
 */
export const COMPOSER_FAMILY_DEFERRED_ASPECTS: Readonly<Record<string, readonly string[]>> = {
  "review-composer-unbound-card": ["state:empty", "state:kind:artifact", "state:loading"],
};

// Every surface the mount table names has a driver, and every driver names a
// surface the mount table declares. Checked HERE, at import, rather than left to
// a reader comparing two lists: a wave that adds a mount and forgets its driver
// would otherwise leave the surface silently unmapped, which on an unpinned
// manifest generates no test at all.
for (const [mount, surfaces] of Object.entries(COMPOSER_ROW_MANIFEST_SURFACES)) {
  for (const surface of surfaces) {
    if (COMPOSER_FAMILY_DRIVERS[surface] === undefined) {
      throw new Error(
        `composer family: mount "${mount}" names manifest surface "${surface}", which has no driver`,
      );
    }
  }
}
for (const surface of Object.keys(COMPOSER_FAMILY_DRIVERS)) {
  const named = Object.values(COMPOSER_ROW_MANIFEST_SURFACES).some((surfaces) =>
    surfaces.includes(surface),
  );
  if (!named) {
    throw new Error(`composer family: driver "${surface}" is not drawn by any harness mount`);
  }
}

// ---------------------------------------------------------------------------
// The RECOMMENDATION family (cinatra#3160, epic #3155 W4) — READINESS, NOT A
// DRIVER MAP.
// ---------------------------------------------------------------------------
//
// The drawing's §V gives ONE row three readings, and thirteen manifest surfaces
// of app-lifecycle-cards stand on them. This suite drives NONE of them, and the
// reason is a property of the product rather than a gap in this file.
//
// The row has exactly ONE composer, `RecommendationHoldCard` (the one-card
// gate's rule R2, scripts/audit/chat-hitl-one-card-gate.mjs). That card takes no
// reading from its host: it RESOLVES the run's authoritative hold state itself
// and derives the offer, the settled answer and the reader's rights from that
// answer alone. A first cut of this wave drove these surfaces by mounting the
// row directly and handing it a reading per mount; that was a second renderer of
// `recommendation_hold` — the class R2 forbids and the defect its own history
// records — so the harness now mounts the card, and the card resolves.
//
// The conformance harness route is a dev-only PUBLIC path driven with no
// session, so the card's cookie-bound resolve answers "no row for this reader"
// there and it draws nothing. That is the shipped card's own fail-closed
// reading, and it is the same constraint the W0 harness already recorded for the
// review card ("the card as a whole draws no DOM before an authorised server
// resolve"). Reaching these readings in a browser needs a real reader and a real
// held run, which this suite has neither of.
//
// So the thirteen surfaces are named as READINESS: their manifest
// (app-lifecycle-cards) stays UNPINNED — which is this program's mechanism for
// recording partial coverage without a false green or a permanently red suite —
// and allowlist.json gains nothing (the ratchet only shrinks). Where the
// readings ARE proven: tests/e2e/chat-hitl-held-turn/held-turn.spec.ts drives a
// real held turn with a real session, and
// src/app/design-fixtures/conformance/__tests__/lifecycle-recommendation-fixture.test.tsx
// drives all four readings through the shipped card and the shipped row by
// answering the card's OWN resolve with the authoritative state each run stands
// for.
//

// ---------------------------------------------------------------------------
// The REVIEW-TARGET / DECISION-FLOOR family (cinatra#3163, epic #3155 W7)
// ---------------------------------------------------------------------------
//
// The fifteen surfaces of the artifact-review drawing that make up the review
// target, the floor beneath it, the decision at its foot, the gate's own
// readings, the conversation above the prompt window, and the promoted row.
//
// ONE LIST, ONE MAP. The rows live in review-decision-floor.ts, keyed by the
// manifest surface id, and the map below is built FROM them: being listed is
// being mapped, so there is no second place a surface could be forgotten. The
// family factory takes its two parameters off the row — the gate state §VII
// names (loading / blocked / disabled) and the provenance tier §V draws (a
// build-time renderer / a runtime one / the floor) — exactly as cinatra#3163
// asks for.
//
// TWO OF THE FIFTEEN ARE DRAWN TODAY, AND THIS WAVE DRIVES THEM FOR REAL. The
// gate's LOADING skeleton and its BLOCKED panel are props-only components of the
// one review renderer, and the harness mounts them
// (src/app/design-fixtures/conformance/review-gate-state-fixtures.tsx). Their
// drivers run on every boot: the skeleton's busy region and its silence, and the
// blocked panel's reason from the drawing's own CLOSED SET together with the
// refresh back to the live gate.
//
// THE OTHER THIRTEEN ARE NOT, and this wave does not pretend otherwise. Grounded
// by reading the shipped tree, not assumed: the target panel, its floor region,
// the decision bar, its disabled reason and the prompt window all ship — and
// none of them can be composed here, because the repository's one-card gate
// keeps the decision floor to the card and to the bar's own module (the
// foundational wave of this epic moved its own proof off the floor for exactly
// that reason), and the target panel is server-only and mounts a real type
// renderer, which a core fixture may not name. Two of the bar's three
// affordances are not on the default branch at all — the branch draws
// reject-review and approve-review where the drawing draws Regenerate and
// Continue — and land with open pull request 3100. The conversation panel ships
// and draws the exchange, but carries no anchor for any of its three surfaces
// and is filled by a request its parent owns. Nothing in the tree promotes a
// row. So each of those thirteen is guarded by `awaitingMount` — the same guard,
// and the same fail-closed harness anchor, the Workspace surfaces have used
// since cinatra#3152 — and each names in its skip reason exactly what it is
// waiting for. Nothing here stands in for a surface: every assertion is written
// in full against the drawing's own declarations and runs unchanged, for real,
// the moment a mount exists.

/** A mount of one review-decision-floor surface, in one reading. */
function reviewDecisionFloorMount(surface: string, variant: string): string {
  return `[data-surface-id="${surface}"][data-variant="${variant}"]`;
}

/**
 * The surface's own drawn panel inside its mount.
 *
 * A row whose `anchor` is null draws no panel of its own by design (§V's two
 * renderer tiers, which the drawing forbids from naming themselves): those are
 * read on the target they render, so the panel there IS the review target.
 */
function reviewDecisionFloorPanel(root: Locator, row: ReviewDecisionFloorRow): Locator {
  return root.locator(`[data-conformance-id="${row.anchor ?? "review-target"}"]`);
}

/**
 * Assert a manifest field is drawn BOUND to its declared source, addressed
 * through the binding the surface names on itself — the
 * `data-field="<name>=<source>"` convention the shipped review target already
 * carries on its own root. A surface bound to the wrong source cannot resolve
 * the locator at all. The union covers both shapes the convention allows: the
 * panel itself carrying the binding, and a descendant of it carrying it.
 */
function reviewDecisionFloorField(
  row: ReviewDecisionFloorRow,
  field: { name: string; source: string },
): { source: string; assert: (page: Page, root: Locator) => Promise<void> } {
  const anchor = row.anchor ?? "review-target";
  const binding = `${field.name}=${field.source}`;
  return {
    source: field.source,
    assert: async (_page, root) => {
      const bound = root.locator(
        `[data-conformance-id="${anchor}"][data-field="${binding}"], ` +
          `[data-conformance-id="${anchor}"] [data-field="${binding}"]`,
      );
      await expect(bound).toHaveCount(1);
      await expect(bound).toBeVisible();
    },
  };
}

/**
 * THE GUARD EVERY ABSENCE READING TAKES FIRST.
 *
 * Several of this family's assertions are absences the drawing states in so many
 * words — "nothing on either target says which resolved it", "there is no
 * dedicated request changes button", "there is no panel above an empty
 * exchange". An absence is evidence ONLY once the thing it is read on is proven
 * drawn: on a missing mount a zero count proves nothing at all. So every such
 * reading asserts its mount first, through this one helper.
 */
const REVIEW_DECISION_FLOOR_ABSENCE_GUARD = async (
  page: Page,
  surface: string,
  variant: string,
): Promise<Locator> => {
  const mount = page.locator(reviewDecisionFloorMount(surface, variant));
  await expect(mount).toHaveCount(1);
  return mount;
};

/** The closed set §VII names for a gate that cannot be prepared or decided.
 *  The drawing fixes the SET, so the driver reads membership of it and never
 *  one chosen value: no-longer-pending, targets-mismatch, revision-not-live. */
const REVIEW_BLOCKED_REASONS = ["no-longer-pending", "targets-mismatch", "revision-not-live"];

/**
 * A drawn state variant: its own mount, drawing the same surface in that
 * reading.
 *
 * §V.1 is explicit about what a reading is NOT — a sentence about a failure
 * "reports through the app's toast surface, never as a line written into the
 * panel" — and §VIII is explicit about what no reading of this family may grow:
 * "There is no control for no". So a state variant is the surface drawn
 * differently, never a note or a control added to it.
 */
function reviewDecisionFloorState(row: ReviewDecisionFloorRow, variant: string): StateAssert {
  return async (page) => {
    const mount = await REVIEW_DECISION_FLOOR_ABSENCE_GUARD(page, row.surface, variant);
    const panel = reviewDecisionFloorPanel(mount, row);
    await expect(panel).toBeVisible();
    if (row.gateState === "blocked") {
      // §VII: "a single blocked state naming the reason from the closed set".
      const reason = await panel.getAttribute("data-blocked-reason");
      expect(
        REVIEW_BLOCKED_REASONS,
        `${row.surface}: a blocked gate names its reason from the closed set, and "${reason}" is not in it`,
      ).toContain(reason);
      // "A blocked gate offers a refresh back to the live gate."
      await expect(panel.locator('[data-action="refresh-gate -> live-gate"]')).toBeVisible();
      return;
    }
    if (row.gateState === "loading") {
      // §VII: "a loading skeleton in the target slot — never a flash of empty
      // chrome", and never a status word: a skeleton reports nothing.
      await expect(panel).toHaveAttribute("aria-busy", "true");
      await expect(panel).toHaveText(/^\s*$/);
      return;
    }
    // Every other reading of this family: the failure sentence is a toast, never
    // a line written into the panel.
    await expect(panel.locator('[role="alert"]')).toHaveCount(0);
    if (variant === "empty") {
      await expect(panel).not.toHaveText(/^\s*$/);
    }
  };
}

/**
 * The `kind:*` reading, which §XI.10's two promotion surfaces declare: the row
 * carries the artifact kind it draws, the same way the extension listing card
 * carries its catalog kind (`cardKindState`).
 */
function reviewDecisionFloorKindState(row: ReviewDecisionFloorRow, kind: string): StateAssert {
  return async (_page, root) => {
    await expect(reviewDecisionFloorPanel(root, row)).toHaveAttribute("data-kind", kind);
  };
}

/**
 * The shared review-decision-family factory, parameterized by the gate state and
 * the provenance tier the row carries.
 *
 * What every surface in this family owes the drawing, and therefore what this
 * factory asserts for all fifteen:
 *
 *   - the surface is drawn on its own mount, addressed by the anchor it carries
 *     (or, for §V's two renderer tiers, on the target they render — the drawing
 *     gives them no anchor of their own on purpose);
 *   - §V: the resolution "is not put on screen: a display shows the work and
 *     nothing about itself — no renderer name, no package identity, no
 *     provenance line". The one region that speaks is the floor, and only there;
 *   - §VIII: "There is no control for no" — no reading of this family draws a
 *     turn-back decision;
 *   - the fields the manifest binds, addressed through the binding the surface
 *     names on itself, so a surface bound to the wrong source cannot resolve;
 *   - the actions the manifest declares, pressed on the control that declares
 *     exactly that action AND that outcome (`declaredAction`), so a driver
 *     cannot press one control and report another one's outcome;
 *   - every state variant the manifest declares.
 */
function reviewDecisionFloorDriver(row: ReviewDecisionFloorRow): SurfaceDriver {
  const driver: SurfaceDriver = {
    path: HARNESS_PATH,
    root: (page) => page.locator(reviewDecisionFloorMount(row.surface, "populated")),
    present: async (page, root) => {
      await REVIEW_DECISION_FLOOR_ABSENCE_GUARD(page, row.surface, "populated");
      const panel = reviewDecisionFloorPanel(root, row);
      await expect(panel).toBeVisible();
      // Nothing about itself. The floor is the ONE region the drawing keeps, so
      // it is the one surface allowed to carry that anchor.
      if (row.provenance !== "floor") {
        await expect(panel.locator('[data-conformance-id="review-target-floor"]')).toHaveCount(0);
      }
      // §VIII — there is no control for "no", anywhere in this family.
      await expect(panel.locator('[data-action^="reject-review"]')).toHaveCount(0);
      await expect(panel.locator('[data-action^="deny-review"]')).toHaveCount(0);
    },
    fields: {},
    actions: {},
    states: {},
  };

  for (const field of row.fields) {
    driver.fields[field.name] = reviewDecisionFloorField(row, field);
  }

  for (const action of row.actions) {
    driver.actions[action.name] = declaredAction(action.name, action.outcome);
  }

  for (const state of row.states) {
    driver.states[state] = state.startsWith("kind:")
      ? reviewDecisionFloorKindState(row, state.slice("kind:".length))
      : reviewDecisionFloorState(row, state);
  }

  return driver;
}

/**
 * What each of the fifteen adds to the family shape — the sentences the drawing
 * writes for that surface alone. Keyed by the surface union and NOT Partial, so
 * dropping one is a compile error rather than a silently thinner driver.
 */
const REVIEW_DECISION_FLOOR_EXTRAS: Record<
  ReviewDecisionFloorSurfaceId,
  (base: SurfaceDriver) => SurfaceDriver
> = {
  // §IV — "The header is inert: it exposes no edit control and no revision
  // picker, because the target is versioned and frozen." And the surface around
  // the representation slot "adds no per-type controls of its own".
  "review-target": (base) => ({
    ...base,
    present: async (page, root) => {
      await base.present(page, root);
      const panel = reviewDecisionFloorPanel(root, REVIEW_DECISION_FLOOR["review-target"]);
      await expect(panel.locator('[data-conformance-id="review-target-revision-picker"]')).toHaveCount(0);
      await expect(panel.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
      // The representation slot: one region, and the type renderer mounts in it.
      await expect(panel.locator("[data-review-representation-slot]")).toHaveCount(1);
    },
  }),

  // §V — a build-time renderer "is not put on screen". The reading IS the
  // absence: the target renders, and nothing on it says what resolved it.
  "review-provenance-native": (base) => ({
    ...base,
    present: async (page, root) => {
      await base.present(page, root);
      const panel = reviewDecisionFloorPanel(root, REVIEW_DECISION_FLOOR["review-provenance-native"]);
      await expect(panel).toBeVisible();
      // The absence the drawing actually forbids is a provenance REGION. Read it
      // on the region ids the surface model owns, not only on attribute names —
      // an absence read on a name the product never uses would pass while a
      // provenance strip stood on screen.
      await expect(
        panel.locator('[data-conformance-id="review-provenance-native"]'),
      ).toHaveCount(0);
      await expect(
        panel.locator('[data-conformance-id="review-provenance-marketplace"]'),
      ).toHaveCount(0);
      await expect(panel).not.toHaveText(/build-time|runtime/i);
      await expect(panel.locator("[data-review-renderer-name]")).toHaveCount(0);
      await expect(panel.locator("[data-review-renderer-package]")).toHaveCount(0);
      await expect(panel.locator('[data-conformance-id="review-target-floor"]')).toHaveCount(0);
    },
  }),

  // §V — and a runtime, marketplace-installed renderer is "drawn the same way",
  // which is only proved by reading the same absence on the other tier.
  "review-provenance-marketplace": (base) => ({
    ...base,
    present: async (page, root) => {
      await base.present(page, root);
      const panel = reviewDecisionFloorPanel(
        root,
        REVIEW_DECISION_FLOOR["review-provenance-marketplace"],
      );
      await expect(panel).toBeVisible();
      // Same reading on the other tier: the drawing says the two tiers are drawn
      // the same way, so BOTH provenance regions must be absent here too.
      await expect(
        panel.locator('[data-conformance-id="review-provenance-marketplace"]'),
      ).toHaveCount(0);
      await expect(
        panel.locator('[data-conformance-id="review-provenance-native"]'),
      ).toHaveCount(0);
      await expect(panel).not.toHaveText(/build-time|runtime/i);
      await expect(panel.locator("[data-review-renderer-name]")).toHaveCount(0);
      await expect(panel.locator("[data-review-renderer-package]")).toHaveCount(0);
      await expect(panel.locator('[data-conformance-id="review-target-floor"]')).toHaveCount(0);
    },
  }),

  // §V — "The floor is never a blank": a sanitized one-line diagnostic
  // (package · slot · reason), over the generic read-only view of the
  // representation, and never an empty panel where a target should be.
  "review-target-floor": (base) => ({
    ...base,
    present: async (page, root) => {
      await base.present(page, root);
      const panel = reviewDecisionFloorPanel(root, REVIEW_DECISION_FLOOR["review-target-floor"]);
      await expect(panel).not.toHaveText(/^\s*$/);
      // A floor is a DISPLAY degrade, not a gate block: the blocked panel of
      // §VII stops the whole surface and is never drawn in a floor's place.
      await expect(panel.locator('[data-conformance-id="review-gate-blocked"]')).toHaveCount(0);
    },
  }),

  // §VI — "It offers exactly three affordances: Continue (primary), Regenerate,
  // and Comment", over ONE free-text note field, and "There is nothing to press
  // for no". The three are the manifest's three actions, driven by the base.
  "review-decision-bar": (base) => ({
    ...base,
    present: async (page, root) => {
      await base.present(page, root);
      const panel = reviewDecisionFloorPanel(root, REVIEW_DECISION_FLOOR["review-decision-bar"]);
      for (const action of REVIEW_DECISION_FLOOR["review-decision-bar"].actions) {
        await expect(
          panel.locator(`[data-action="${action.name} -> ${action.outcome}"]`),
        ).toHaveCount(1);
      }
      // "One note field, and it reads for both roads" — one, never a second
      // input that appeared for one kind of artifact.
      await expect(panel.locator("textarea")).toHaveCount(1);
    },
  }),

  // §VI — "there is no dedicated request changes button": the window IS the
  // request, so the only thing that carries the action is the window itself.
  "review-prompt-window": (base) => ({
    ...base,
    present: async (page, root) => {
      await base.present(page, root);
      const panel = reviewDecisionFloorPanel(root, REVIEW_DECISION_FLOOR["review-prompt-window"]);
      await expect(panel).toBeVisible();
      await expect(panel.getByRole("button", { name: /request changes/i })).toHaveCount(0);
    },
  }),

  // §VII — "A reviewer who may see the gate but not act on it gets the
  // affordances disabled, with a one-line reason, rather than a live control
  // that fails on click."
  "review-decision-disabled": (base) => ({
    ...base,
    present: async (page, root) => {
      await base.present(page, root);
      const panel = reviewDecisionFloorPanel(root, REVIEW_DECISION_FLOOR["review-decision-disabled"]);
      await expect(panel).not.toHaveText(/^\s*$/);
      // The reason accompanies DISABLED controls, never live ones.
      const bar = root.locator('[data-conformance-id="review-decision-bar"]');
      await expect(bar.locator("button[disabled]").first()).toBeAttached();
    },
  }),

  // §VII — the loading skeleton in the target slot. It is drawn today, and the
  // shipped skeleton reports nothing at all: a busy region and no words.
  "review-gate-loading": (base) => ({
    ...base,
    present: async (page, root) => {
      await base.present(page, root);
      const panel = reviewDecisionFloorPanel(root, REVIEW_DECISION_FLOOR["review-gate-loading"]);
      await expect(panel).toHaveAttribute("aria-busy", "true");
      // "never a flash of empty chrome" — the skeleton draws its own bands.
      await expect(panel.locator("div")).not.toHaveCount(0);
      // A skeleton names no status and offers nothing to press.
      await expect(panel).toHaveText(/^\s*$/);
      await expect(panel.locator("button")).toHaveCount(0);
    },
  }),

  // §VII — the single blocked state: the reason from the closed set, and a
  // refresh back to the live gate. Drawn today, and driven for real.
  "review-gate-blocked": (base) => ({
    ...base,
    present: async (page, root) => {
      await base.present(page, root);
      const panel = reviewDecisionFloorPanel(root, REVIEW_DECISION_FLOOR["review-gate-blocked"]);
      const reason = await panel.getAttribute("data-blocked-reason");
      expect(
        REVIEW_BLOCKED_REASONS,
        `review-gate-blocked: the reason must come from the drawing's closed set, and "${reason}" is not in it`,
      ).toContain(reason);
      await expect(panel.locator('[data-action="refresh-gate -> live-gate"]')).toBeVisible();
      // "it never lets a stale decision through" — a blocked gate draws no
      // decision affordance beside its refresh.
      await expect(panel.locator('[data-conformance-id="review-decision-bar"]')).toHaveCount(0);
      await expect(panel).not.toHaveText(/^\s*$/);
    },
  }),

  // §IX — "Each message is a bubble … carries no author label, no avatar and no
  // timestamp — the side it sits on is who said it."
  "per-run-conversation": (base) => ({
    ...base,
    present: async (page, root) => {
      await base.present(page, root);
      const panel = reviewDecisionFloorPanel(root, REVIEW_DECISION_FLOOR["per-run-conversation"]);
      await expect(panel.locator("[data-conversation-bubble]").first()).toBeVisible();
      await expect(panel.locator("[data-conversation-author]")).toHaveCount(0);
      await expect(panel.locator("[data-conversation-timestamp]")).toHaveCount(0);
      await expect(panel.locator("img")).toHaveCount(0);
    },
  }),

  // §IX — "Beneath the last bubble, on the assistant's side, a small dot and the
  // word Thinking… in muted; it is not a bubble." The field goes quiet with it.
  "per-run-conversation-pending": (base) => ({
    ...base,
    present: async (page, root) => {
      await base.present(page, root);
      const panel = reviewDecisionFloorPanel(
        root,
        REVIEW_DECISION_FLOOR["per-run-conversation-pending"],
      );
      const waiting = panel.locator("[data-conversation-waiting]");
      await expect(waiting).toHaveCount(1);
      // "it is not a bubble" — the wait is a turn of its own, never one of them.
      await expect(waiting.locator("[data-conversation-bubble]")).toHaveCount(0);
    },
  }),

  // §IX — "There is no panel above an empty exchange — the window is the field
  // alone until the first message."
  "per-run-conversation-empty": (base) => ({
    ...base,
    present: async (page, root) => {
      await base.present(page, root);
      const panel = reviewDecisionFloorPanel(
        root,
        REVIEW_DECISION_FLOOR["per-run-conversation-empty"],
      );
      await expect(panel).toBeVisible();
      await expect(panel.locator("[data-conversation-bubble]")).toHaveCount(0);
    },
  }),

  // §X — "One thing is read per surface — the sentence in the empty field."
  // Five readings of ONE window: the field, and the review reading's own words.
  "prompt-window-readings": (base) => ({
    ...base,
    present: async (page, root) => {
      await base.present(page, root);
      const panel = reviewDecisionFloorPanel(root, REVIEW_DECISION_FLOOR["prompt-window-readings"]);
      await expect(
        panel.getByPlaceholder("Ask Cinatra about this review, or ask for changes to the work…"),
      ).toBeVisible();
      // "never five windows": one field per reading, never a second composer.
      await expect(panel.locator("textarea")).toHaveCount(1);
    },
  }),

  // §XI.10 — "Nothing is re-typed silently": promotion happens on the matcher's
  // assertion at its threshold AND with the person's confirmation, which is why
  // the confirmation says what the type becomes and what does not move.
  "promotion-confirm": (base) => ({
    ...base,
    present: async (page, root) => {
      await base.present(page, root);
      const panel = reviewDecisionFloorPanel(root, REVIEW_DECISION_FLOOR["promotion-confirm"]);
      await expect(panel.locator("[data-promotion-matcher-score]")).toHaveCount(1);
      // The way out is drawn beside the confirmation: an association on its own
      // promotes nothing, so leaving it as it is has to be offered.
      await expect(panel.locator("[data-promotion-keep-as-is]")).toHaveCount(1);
    },
  }),

  // §XI.10 — "the row reads as the claiming extension's row … and carries a
  // Promoted reading with the base it came from", and the file kind never moves.
  "promoted-row-state": (base) => ({
    ...base,
    present: async (page, root) => {
      await base.present(page, root);
      const panel = reviewDecisionFloorPanel(root, REVIEW_DECISION_FLOOR["promoted-row-state"]);
      await expect(panel.locator("[data-promoted-marker]")).toBeVisible();
      await expect(panel.locator("[data-promoted-from-file-kind]")).toBeVisible();
    },
  }),
};

/** Why a review-decision-floor driver skips, named on every skipped test. */
function reviewDecisionFloorReadiness(row: ReviewDecisionFloorRow): string {
  return (
    `the surface drawn in §${row.section} of the artifact-review drawing is not ` +
    `addressable on the default branch yet — ${row.readiness ?? ""}. Every assertion in ` +
    `this driver is written against the drawing's own declarations and runs unchanged ` +
    `the moment the mount exists.`
  );
}

/** The fifteen drivers, built from the one row list. The two the harness draws
 *  run for real; the other thirteen carry the guard and their own reason. */
const REVIEW_DECISION_FLOOR_DRIVERS: Record<string, SurfaceDriver> = Object.fromEntries(
  REVIEW_DECISION_FLOOR_ROWS.map((row) => {
    const driver = REVIEW_DECISION_FLOOR_EXTRAS[row.surface](reviewDecisionFloorDriver(row));
    return [
      row.surface,
      row.mounted ? driver : awaitingMount(row.surface, driver, reviewDecisionFloorReadiness(row)),
    ];
  }),
);

// ---------------------------------------------------------------------------
// The RESOLVE-BACKED families (cinatra#3164, epic #3155 W8): §VII's verification
// card, §IV's review-state ladder and the §VIII decision floor.
// ---------------------------------------------------------------------------
//
// These cards draw NO DOM until an authorized resolve answers — that is the
// epic's posture, not an obstacle to route around — and a conformance harness
// has no session. So the ONE thing this suite seeds for them is the SERVER'S
// ANSWER, at the card's own seam: the driver fulfils the card's own resolve
// request with the protocol-typed envelope its fixture row names
// (src/app/design-fixtures/conformance/lifecycle-resolve-fixture-data.ts) and
// then opens the harness.
//
// EVERYTHING AFTER THE ANSWER IS THE SHIPPED CARD'S. The envelope goes through
// the shipped parse (`parseLifecycleResolveEnvelope`), which refuses anything
// that is not a well-formed answer to the question the card asked; which rung of
// §IV is drawn, whether any DOM is drawn at all, which controls the floor
// offers, whether they are disabled and what the reason says, and every value on
// the verification reading are decided by the shipped components. No control is
// named by the harness, and no copy string below is invented here: each one is
// either the drawing's own word or the shipped component's.
//
// AND THE SUBSTITUTION LIVES HERE, IN THE TEST. The harness route wraps no
// product module and patches no transport: opened outside this suite those
// mounts issue the same real request every host issues and draw nothing.
//
// The manifest actions of this drawing that NO SHIPPED CONTROL carries —
// `suggestion-floor`'s Regenerate/Continue among them — are not driven here and
// are not approximated through a different control. They are on this wave's
// surface-readiness list.

/** The label §VII fixes for each outcome pill. The pill is the only place the
 *  card carries state colour, so the label and its shipped status treatment are
 *  what a driver reads. */
const VERIFICATION_OUTCOME_LABEL: Readonly<Record<string, string>> = {
  verified: "Verified",
  drifted: "Out-of-scope drift",
  unmet: "Findings not met",
};

/**
 * Answer the card's OWN resolve request from the fixture table, then open the
 * harness.
 *
 * An unknown ref is answered the way an unauthenticated caller is answered — a
 * 401, never an envelope — so a card can only ever draw from a row that was
 * deliberately seeded, and a driver that seeded nothing sees the same nothing a
 * reader without a session sees.
 */
async function openWithSeededResolve(page: Page): Promise<void> {
  await page.route(`**${LIFECYCLE_RESOLVE_PATH}`, async (route) => {
    let ref: unknown;
    let viewType: unknown;
    try {
      const request = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      ref = request.ref;
      viewType = request.viewType;
    } catch {
      // A request this seam cannot read is answered like an unknown ref.
    }
    const fixture = LIFECYCLE_RESOLVE_FIXTURES.find(
      (row) => row.ref === ref && row.kind === viewType,
    );
    if (fixture === undefined) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "unauthorized" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(lifecycleResolveAnswer(fixture)),
    });
  });
  await page.goto(HARNESS_PATH, { waitUntil: "domcontentloaded" });
}

/** The verification card of one mount. */
function verificationCard(root: Locator): Locator {
  return root.locator('[data-conformance-id="verification-card"]');
}

/** The review card of one mount. */
function reviewCard(root: Locator): Locator {
  return root.locator('[data-conformance-id="review-gate-card"]');
}

/**
 * §VII — the verification card, one factory over the outcome the row seeds.
 *
 * The three outcomes and the in-conversation reading are the same card: §IX's
 * rule is that presence is not layout ("the same regions, the same states, the
 * same data on screen"), so ONE factory drives all four and the host it was
 * mounted on is read back off the card rather than assumed.
 */
function verificationDriver(fixture: LifecycleResolveFixture): SurfaceDriver {
  if (fixture.kind !== "verification_summary") {
    throw new Error(`verificationDriver: ${fixture.mount} is not a verification row`);
  }
  const body = fixture.body;
  const rootSel = `[data-surface-id="${fixture.mount}"]`;

  return {
    path: HARNESS_PATH,
    root: (page) => page.locator(rootSel),
    present: async (page, root) => {
      await openWithSeededResolve(page);
      const card = verificationCard(root);
      // The card draws only once its own resolve has answered, so the FIRST
      // assertion after opening the harness waits the way the other
      // hydration-sensitive drivers on this route wait.
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(card).toHaveAttribute("data-lifecycle-card", "verification_summary");
      // §VII resolves ADVISORY — a reading, never a decision.
      await expect(card).toHaveAttribute("data-lifecycle-card-state", "advisory");
      // §IX — the same card on the host that declared it.
      await expect(card).toHaveAttribute("data-lifecycle-card-host", fixture.host);

      // THE OUTCOME PILL — "the only place the card carries state colour", and
      // the shipped status pill rather than a tone table of the card's own.
      const pill = card.locator(`[data-verification-outcome="${body.outcome}"]`);
      await expect(pill).toBeVisible();
      await expect(pill).toHaveText(VERIFICATION_OUTCOME_LABEL[body.outcome]);
      await expect(pill).toHaveAttribute("data-slot", "status-pill");

      // The two revision pins, bound to the body the answer carried.
      const revisions = card.locator("[data-verification-revisions]");
      await expect(revisions).toContainText(body.reviewedRevisionId);
      await expect(revisions).toContainText(body.repairedRevisionId);

      // "The before / after shows exactly the fields that were inspected —
      // nothing more": the table is the body's rows, and only those.
      const rows = card.locator("[data-verification-field-diff] tbody tr");
      await expect(rows).toHaveCount(body.fieldDiff.length);
      for (const row of body.fieldDiff) {
        const drawn = card.locator(`[data-diff-field="${row.field}"]`);
        await expect(drawn).toHaveCount(1);
        await expect(drawn).toHaveAttribute("data-diff-in-scope", row.inScope ? "true" : "false");
        if (row.before !== null) await expect(drawn).toContainText(row.before);
        if (row.after !== null) await expect(drawn).toContainText(row.after);
        // "A field changed that the review never covered … is marked IN PLACE
        // rather than folded into the result."
        if (!row.inScope) await expect(drawn).toContainText("out of scope");
      }
      // Disclosed and out of scope are separate marks: a verified reading
      // carries no out-of-scope row at all, and an unmet one is a field that was
      // inspected and did not move.
      const drifted = body.fieldDiff.filter((row) => !row.inScope);
      if (body.outcome === "drifted") {
        expect(
          drifted.length,
          "the drift reading marks at least one row out of scope",
        ).toBeGreaterThan(0);
      } else {
        expect(drifted.length, "only the drift reading marks a row out of scope").toBe(0);
      }
      if (body.outcome === "unmet") {
        expect(
          body.fieldDiff.some((row) => row.before !== null && row.before === row.after),
          "an unmet reading pins a field that was inspected and did not move",
        ).toBe(true);
      }

      // "It closes with Advisory comments" — and the reading's PROVENANCE is the
      // body of a service comment there, not a line of its own.
      const advisory = card.locator("[data-verification-advisory]");
      await expect(advisory).toBeVisible();
      for (const comment of body.advisoryComments ?? []) {
        const panel = advisory.locator(`[data-advisory-author-kind="${comment.authorKind}"]`);
        await expect(panel).toContainText(comment.body);
      }

      // §VII's own callout: "the bordered panel is the card treatment for a
      // CONVERSATION, where the reading has to separate itself from the turns
      // around it". The reading drawn in a turn is asserted to carry it.
      if (fixture.mount === "verification-in-thread") {
        await expect(card).toHaveCSS("border-top-width", "1px");
      }

      // "IT CARRIES NO FLOOR AT ALL … it asks nothing, so it draws nothing to
      // press." Not a disabled floor, not a link — nothing pressable.
      await expect(card.locator('[data-conformance-id="review-decision-bar"]')).toHaveCount(0);
      await expect(card.getByRole("button")).toHaveCount(0);
      await expect(card.getByRole("link")).toHaveCount(0);
    },
    fields: {},
    actions: {},
    states: {},
  };
}

/**
 * §IV — the review card's state ladder, one factory over the state the row
 * seeds, plus §VIII's decision floor (which is a pending gate carrying
 * suggestions, and is therefore the same card in the same factory).
 *
 * "Four drawn states, and one that draws nothing."
 */
function reviewCardStateDriver(fixture: LifecycleResolveFixture): SurfaceDriver {
  if (fixture.kind !== "artifact_review_gate") {
    throw new Error(`reviewCardStateDriver: ${fixture.mount} is not a review-gate row`);
  }
  const rootSel = `[data-surface-id="${fixture.mount}"]`;
  const stateName = fixture.state.state;
  const card = (root: Locator) => reviewCard(root);
  const floor = (root: Locator) => root.locator('[data-conformance-id="review-decision-bar"]');

  /** The card, drawn on the rung the answer named. */
  const drawnCard = async (page: Page, root: Locator): Promise<Locator> => {
    await openWithSeededResolve(page);
    const drawn = card(root);
    // First assertion after opening the harness — see the note on the
    // verification factory: the card draws on its answer, not on load.
    await expect(drawn).toBeVisible({ timeout: 30_000 });
    await expect(drawn).toHaveAttribute("data-lifecycle-card", "artifact_review_gate");
    await expect(drawn).toHaveAttribute("data-lifecycle-card-state", stateName);
    await expect(drawn).toHaveAttribute("data-lifecycle-card-host", fixture.host);
    return drawn;
  };

  const driver: SurfaceDriver = {
    path: HARNESS_PATH,
    root: (page) => page.locator(rootSel),
    present: async (page, root) => {
      await drawnCard(page, root);
    },
    fields: {},
    actions: {},
    states: {},
  };

  switch (fixture.mount) {
    case "state-loading":
      // "A card is loading while the host prepares the target": the shipped
      // gate skeleton, and no floor — there is nothing to decide yet.
      driver.states.loading = async (page, root) => {
        const drawn = await drawnCard(page, root);
        const skeleton = drawn.locator('[data-conformance-id="review-gate-loading"]');
        await expect(skeleton).toBeVisible();
        await expect(skeleton).toHaveAttribute("aria-busy", "true");
        await expect(floor(drawn)).toHaveCount(0);
      };
      break;

    case "state-restricted":
      // "Restricted when the reader may see the gate but not decide it — the
      // terminal affordances disabled, the reason shown." The card RENDERS: the
      // reader sees the gate and the disabled floor, with the reason on screen.
      driver.present = async (page, root) => {
        const drawn = await drawnCard(page, root);
        const bar = floor(drawn);
        await expect(bar).toBeVisible();
        // The reader may respond, so the non-terminal control stays live.
        const comment = bar.locator('[data-action="comment-review -> annotated"]');
        await expect(comment).toBeVisible();
        await expect(comment).toBeEnabled();
        // Every TERMINAL affordance is disabled — not hidden, not silently
        // dropped: a withheld card must never be drawn as a disabled one, and a
        // disabled one must never be silently dropped.
        for (const terminal of [
          '[data-action="approve-review -> resolved"]',
          '[data-action="reject-review -> resolved"]',
        ]) {
          const control = bar.locator(terminal);
          await expect(control).toBeVisible();
          await expect(control).toBeDisabled();
          await expect(control).toHaveAttribute("aria-disabled", "true");
        }
        // …and the reason is shown, by the shipped bar rather than by the answer.
        await expect(bar.locator('[data-conformance-id="review-decision-disabled"]')).toBeVisible();
      };
      break;

    case "state-no-longer-open":
      // "No longer open when the gate was already settled or the run moved on,
      // offering a refresh rather than letting a stale decision through."
      driver.states.error = async (page, root) => {
        const drawn = await drawnCard(page, root);
        const blocked = drawn.locator('[data-conformance-id="review-gate-blocked"]');
        await expect(blocked).toBeVisible();
        await expect(blocked).toHaveAttribute("data-blocked-reason", "no-longer-pending");
        await expect(blocked).toContainText("This review is no longer open");
        // The refresh the drawing offers in place of a stale decision.
        await expect(blocked.locator('[data-action="refresh-gate -> live-gate"]')).toBeVisible();
        // No decision may be taken from this reading.
        await expect(floor(drawn)).toHaveCount(0);
      };
      break;

    case "state-absent":
      // THE ONE THAT DRAWS NOTHING. "Absent is no card DOM at all — a reader who
      // may not read the target gets no panel, no placeholder and no reason."
      //
      // An absence proves nothing on its own — an unseeded page, a boot failure
      // and a route regression all draw no card either — so it is proved AGAINST
      // the sibling mount that did draw under the same seeded seam. That pairing
      // is also the danger callout itself: restricted and absent are never drawn
      // for each other.
      driver.present = async (page, root) => {
        await openWithSeededResolve(page);
        const sibling = page.locator(`[data-surface-id="${LIFECYCLE_DRAWN_CONTROL_MOUNT}"]`);
        await expect(reviewCard(sibling)).toBeVisible({ timeout: 30_000 });
        await expect(root).toBeAttached();
        await expect(root.locator("[data-lifecycle-card]")).toHaveCount(0);
        await expect(reviewCard(root)).toHaveCount(0);
        await expect(root.locator('[data-conformance-id="review-gate-blocked"]')).toHaveCount(0);
        await expect(root.locator('[data-conformance-id="review-gate-loading"]')).toHaveCount(0);
        await expect(floor(root)).toHaveCount(0);
      };
      driver.states.empty = async (page, root) => {
        await driver.present(page, root);
      };
      break;

    case "suggestion-floor":
      // §VIII — "The suggestions carry no submit of their own: they ride the
      // review card's one terminal decision." So the floor is what this surface
      // is, and it is drawn by the card beneath the chips it decides.
      driver.present = async (page, root) => {
        const drawn = await drawnCard(page, root);
        const chips = drawn.locator('[data-conformance-id="suggestion-chips"]');
        await expect(chips).toBeVisible();
        // LIVE marks: this reader may take the decision they would ride on.
        await expect(chips).toHaveAttribute("data-suggestion-chips-mode", "live");
        const suggestions = "suggestions" in fixture.state ? (fixture.state.suggestions ?? []) : [];
        await expect(chips.locator("[data-suggestion-state]")).toHaveCount(suggestions.length);
        const bar = floor(drawn);
        await expect(bar).toBeVisible();
        // The count line the shipped floor draws for the marks it would carry —
        // every suggestion arrives accepted, so all of them ride this decision.
        const count = bar.locator('[data-conformance-id="suggestion-accepted-count"]');
        await expect(count).toBeVisible();
        await expect(count).toContainText(`${suggestions.length} of ${suggestions.length}`);
        await expect(count).toContainText("ride this decision");
        // The gate is decidable for this reader, so the terminal controls are live.
        await expect(bar.locator('[data-action="approve-review -> resolved"]')).toBeEnabled();
        await expect(bar.locator('[data-action="reject-review -> resolved"]')).toBeEnabled();
        await expect(
          bar.locator('[data-conformance-id="review-decision-disabled"]'),
        ).toHaveCount(0);
      };
      break;
  }

  return driver;
}

// --- §III — what the target shows ------------------------------------------
//
// "A target is never blank." Where the type resolves to a renderer the target
// shows it and says NOTHING about it; where none resolves it falls to the
// metadata floor, "which does say so: a sanitized one-line diagnostic above the
// generic read-only view of the representation".

/** Why the two loadable tiers skip while this harness mounts no renderer. */
const AWAITING_RESOLVED_RENDERER =
  "the tier is decided by the RENDERER: a build-time renderer resolves out of " +
  "the generated build map and a runtime one out of an installed extension, and " +
  "the conformance harness admits neither. A stand-in renderer would prove " +
  "nothing about which tier resolved, so nothing stands in: every assertion here " +
  "runs unchanged the moment the harness mounts a resolved target (cinatra#3164 " +
  "surface-readiness list).";

/**
 * The two loadable tiers, written in full and guarded on the mount.
 *
 * §III's rule for both is the same and is a NEGATIVE one — "no chip, no package
 * identity, no provenance line, because a reader is deciding on the work, not on
 * what drew it" — so what is asserted is that the target carries no floor
 * diagnostic and names no package at all.
 */
function tierRendererDriver(surfaceId: string): SurfaceDriver {
  const TIER_READING = async (_page: Page, root: Locator): Promise<void> => {
    await expect(root).toBeVisible();
    await expect(root).not.toBeEmpty();
    await expect(root.locator("[data-review-target-floor]")).toHaveCount(0);
    await expect(root).not.toContainText(/@[a-z0-9-]+\//);
  };
  return awaitingMount(
    surfaceId,
    {
      path: HARNESS_PATH,
      root: harnessRoot(surfaceId),
      present: async (_page, root) => {
        await expect(root).toBeVisible();
        // §III opens on "A target is never blank", so the FIRST thing a resolved
        // tier owes is something drawn. Without this, the negative rules below
        // would be satisfied by a mount that rendered nothing at all.
        await expect(root).not.toBeEmpty();
        // A resolved renderer never falls to the floor…
        await expect(root.locator("[data-review-target-floor]")).toHaveCount(0);
        // …and says nothing about itself: no package identity anywhere in the
        // target, which is what "no chip, no provenance line" comes to on screen.
        await expect(root).not.toContainText(/@[a-z0-9-]+\//);
      },
      fields: {},
      actions: {},
      states: {
        // §III draws its three tiers as ONE illustration group and annotates the
        // whole group with a single state, so "error" here is the group's mark,
        // not a second reading: these two examples draw a resolved renderer and
        // nothing else. The state therefore asserts exactly the tier reading —
        // the same treatment `state-absent` gives its own single reading above,
        // and it runs under the same mount guard.
        error: async (page, root) => {
          await TIER_READING(page, root);
        },
      },
    },
    AWAITING_RESOLVED_RENDERER,
  );
}

const TIER_BUILD_TIME_DRIVER: SurfaceDriver = tierRendererDriver("tier-build-time");
const TIER_RUNTIME_DRIVER: SurfaceDriver = tierRendererDriver("tier-runtime");

/**
 * The metadata floor — the tier this harness CAN mount, because the floor is the
 * host's own arm of the shipped review-target bridge rather than a renderer it
 * would have to resolve.
 */
const TIER_METADATA_FLOOR_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: harnessRoot("tier-metadata-floor"),
  present: async (_page, root) => {
    await expect(root.locator('[data-review-target-floor="requires-rebuild"]')).toBeVisible();
  },
  fields: {},
  actions: {},
  states: {
    // The floor IS the error reading of a target: the type's semantic renderer
    // is runtime-installed and absent from this build.
    error: async (_page, root) => {
      const floor = root.locator('[data-review-target-floor="requires-rebuild"]');
      await expect(floor).toBeVisible();
      await expect(floor).toHaveAttribute("data-review-floor-package", "@acme/support");
      await expect(floor).toHaveAttribute("data-review-floor-slot", "detail");
      // THE SANITIZED ONE-LINE DIAGNOSTIC, composed by the shipped bridge —
      // package, slot and reason, and nothing else (never a raw error or a
      // manifest value). The drawing sets the same sentence in typographic
      // quotes; the shipped line is the same words in straight ones.
      await expect(floor.getByRole("status")).toHaveText(
        'review target unavailable — package "@acme/support", slot "detail", reason "requires-rebuild"',
      );
      // "A target is never blank": the diagnostic sits ABOVE the generic
      // read-only view of the representation. The view itself is the host's
      // node — the bridge takes it from the caller, exactly as the artifact
      // page hands it its own generic floor — so what is graded here is the
      // BRIDGE'S doing: that it drew that node at all, and that it drew it
      // AFTER the diagnostic rather than in place of or above it. The sibling
      // combinator is the order assertion; a floor that dropped the node, or
      // one that put it first, fails it.
      await expect(
        floor.locator(
          'p[role="status"] ~ [data-conformance-id="review-target-floor-structured-data"]',
        ),
      ).toBeVisible();
    },
  },
};

// ---------------------------------------------------------------------------
// W9 — the remaining ONE-OFF surfaces of the in-conversation lifecycle drawing
// (cinatra#3165, epic #3155)
// ---------------------------------------------------------------------------
//
// Twelve surfaces with no family to share: each stands for one thing the
// drawing says once. There is deliberately no factory here — a factory over
// twelve unlike shapes would be a parameter list pretending to be a pattern.
//
// FOUR ARE DRIVEN FOR REAL, from the components that SHIP them: the review
// target's header and its two other readings (§II / §IV), the run-progress
// placeholder (§II), the same review states outside a conversation (§XIII.1),
// and §IX's READER matrix — the two readings the review card itself produces by
// handing the chip row a mark handler exactly when the reader may decide, drawn
// with the one card piece a harness may mount as the product mounts it.
//
// EIGHT ARE ON THE SURFACE-READINESS LIST below, written in full against the
// manifest's own field sources, action outcomes and state variants, and guarded
// by the harness mount itself. While nothing on the harness carries the surface
// id the whole battery SKIPS with the reason; the moment a mount does, every
// assertion runs for real. Nothing here stands in for a surface, and no aspect
// is asserted at half strength through a different control.
//
// NO ALLOWLIST ENTRY IS ADDED, and none could be — but the gate that would
// refuse one is the ACCEPTANCE SUITE, not the static checker. The static checker
// (scripts/design/check-conformance-testids.mjs) deliberately admits the
// surfaces of a committed-but-unpinned manifest, so an entry naming one passes
// there; functional-acceptance.spec.ts builds its `allSurfaceIds` from the
// PINNED manifests only, so the same entry reds its "allowlist entries reference
// real manifest surfaces/aspects" test while this drawing is unpinned. The
// readiness list below is the only truthful route for an unaddressable aspect,
// and it names what will land it.

/** The shipped anchor of the reviewed target's inert header (§IV). */
const REVIEW_TARGET_HEADER_SEL = '[data-conformance-id="review-target-header"]';

/** One non-populated reading of a W9 mount. */
function oneOffVariant(surfaceId: string, variant: string): (page: Page) => Locator {
  return (page) => page.locator(`[data-surface-id="${surfaceId}"][data-variant="${variant}"]`);
}

/**
 * `name = type.displayName` — the TYPE's short display label, never the
 * artifact's own title.
 *
 * The drawing puts both on the same line, which is exactly why this is worth
 * grading: a driver that read the title and reported the type binding would
 * pass on a card that had drifted. The mount publishes its raw sources on the
 * surface root, so the assertion names a source of truth rather than whatever
 * the header rendered, and the fixture's title and type label share no token.
 */
function reviewTargetNameField(): {
  source: string;
  assert: (page: Page, root: Locator) => Promise<void>;
} {
  return {
    source: "type.displayName",
    assert: async (_page, root) => {
      const header = root.locator(REVIEW_TARGET_HEADER_SEL);
      const title = await root.getAttribute("data-review-target-title");
      expect(
        title,
        "the harness mount must publish the artifact title as data-review-target-title, so this assertion names a source of truth rather than whatever the header rendered",
      ).toBeTruthy();
      // The type tag carries the derived label as its own value AND as its text
      // — the header's two readings of one fact cannot disagree.
      const typeTag = header.locator("[data-review-target-type]");
      await expect(typeTag).toHaveAttribute(
        "data-review-target-type",
        LIFECYCLE_REVIEW_TARGET_TYPE_LABEL,
      );
      await expect(typeTag).toHaveText(LIFECYCLE_REVIEW_TARGET_TYPE_LABEL);
      // Bound to the TYPE, not to the title: the label is not the title, and
      // the title is still drawn beside it (a header that dropped the title
      // would otherwise satisfy a bare "is not the title" check).
      await expect(typeTag).not.toContainText(title!);
      await expect(header).toContainText(title!);
    },
  };
}

/**
 * The gate's LOADING reading, drawn in the target slot while the host prepares
 * the target (§IV). It is the shipped skeleton — and it is NOT the header: a
 * loading state that quietly kept the previous header would be reporting a
 * target it has not resolved.
 */
function reviewGateLoadingState(surfaceId: string): StateAssert {
  return async (page) => {
    const slot = oneOffVariant(surfaceId, "loading")(page);
    const skeleton = slot.locator('[data-conformance-id="review-gate-loading"]');
    await expect(skeleton).toBeVisible();
    await expect(skeleton).toHaveAttribute("aria-busy", "true");
    await expect(slot.locator(REVIEW_TARGET_HEADER_SEL)).toHaveCount(0);
  };
}

/**
 * §IV's "no longer open" — the state this drawing's conformance vocabulary
 * calls `error` (the spec's own `state-no-longer-open` carries
 * `data-state="error"`). The shipped panel names the reason from the closed set
 * and offers a refresh back to the live gate rather than letting a stale
 * decision through.
 */
function reviewGateBlockedState(surfaceId: string): StateAssert {
  return async (page) => {
    const slot = oneOffVariant(surfaceId, "error")(page);
    const panel = slot.locator('[data-conformance-id="review-gate-blocked"]');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-blocked-reason", LIFECYCLE_REVIEW_BLOCKED_REASON);
    await expect(panel).toContainText("This review is no longer open");
    await expect(panel.locator('[data-action="refresh-gate -> live-gate"]')).toBeVisible();
  };
}

/**
 * review-target-in-thread — the target panel of the review card, in the
 * assistant's turn (§II). One field and two states, all three shipped.
 */
const REVIEW_TARGET_IN_THREAD_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: harnessRoot("review-target-in-thread"),
  present: async (_page, root) => {
    const header = root.locator(REVIEW_TARGET_HEADER_SEL);
    await expect(header).toBeVisible();
    // §IV: the header is INERT — it exposes no edit control and no revision
    // picker, because the target is versioned and frozen.
    await expect(header.getByRole("button")).toHaveCount(0);
    await expect(header.getByRole("combobox")).toHaveCount(0);
    await expect(header.getByRole("link")).toHaveCount(0);
  },
  fields: { name: reviewTargetNameField() },
  actions: {},
  states: {
    loading: reviewGateLoadingState("review-target-in-thread"),
    error: reviewGateBlockedState("review-target-in-thread"),
  },
};

/**
 * run-progress-placeholder-in-thread — what the assistant's turn carries BEFORE
 * the output has been generated (§II).
 *
 * It has exactly one reading, and that reading IS the loading one: the card's
 * own fixed name, the arc, and nothing else. The drawing's rule is what makes
 * this worth asserting — the placeholder "names no status, reports no result and
 * draws nothing to press" — so the driver grades the absence as hard as the
 * presence.
 */
const RUN_PROGRESS_PLACEHOLDER_IN_THREAD_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: harnessRoot("run-progress-placeholder-in-thread"),
  present: async (_page, root) => {
    const placeholder = root.locator('[data-conformance-id="review-gate-placeholder"]');
    await expect(placeholder).toBeVisible();
    // The card's own fixed name is the WHOLE of the words on it. Asserted as the
    // placeholder's entire text rather than as a substring, because the drawing's
    // rule here is an absence: a status word ("Running"), a progress line or any
    // early reading of the result would be drawn beside the name and a
    // contains-check would pass with it there.
    await expect(placeholder).toHaveText("Agentic Run Progress");
    // Nothing to press, and nothing to follow.
    await expect(placeholder.getByRole("button")).toHaveCount(0);
    await expect(placeholder.getByRole("link")).toHaveCount(0);
    // ONE arc, and nothing else drawn: a second graphic in this band is a second
    // reading of the same wait.
    await expect(placeholder.locator("svg")).toHaveCount(1);
  },
  fields: {},
  actions: {},
  states: {
    loading: async (_page, root) => {
      const placeholder = root.locator('[data-conformance-id="review-gate-placeholder"]');
      // A busy REGION, named for a reader who cannot see the spin.
      await expect(placeholder).toHaveAttribute("role", "status");
      await expect(placeholder).toHaveAttribute("aria-busy", "true");
      // The arc itself — the design system's spinner, not a second one.
      await expect(placeholder.locator("svg.animate-spin")).toBeVisible();
    },
  },
};

/**
 * review-states-outside-chat — the SAME review states outside a conversation,
 * in the run page's own gate region (§XIII.1).
 *
 * The section's claim is that nothing moves but the frame, so this driver holds
 * the same assertions as the in-thread target above, on a mount whose only
 * difference is the host declaration. Its `continue-review` action is on the
 * readiness list: the ratified terminal control arrives with cinatra#3100.
 */
const REVIEW_STATES_OUTSIDE_CHAT_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: harnessRoot("review-states-outside-chat"),
  present: async (_page, root) => {
    const header = root.locator(REVIEW_TARGET_HEADER_SEL);
    await expect(header).toBeVisible();
    await expect(header.getByRole("button")).toHaveCount(0);
  },
  fields: {},
  // The manifest declares `continue-review -> resolved` for this surface, and an
  // aspect a driver does not name at all is dropped SILENTLY by the acceptance
  // generator while the drawing is unpinned — no test, no skip, no record. So the
  // action is declared here and skips with its own readiness reason: the ratified
  // terminal control arrives with open pull request cinatra#3100, and the floor
  // may be composed only by the review card itself.
  actions: {
    "continue-review": {
      outcome: "resolved",
      run: async () => {
        test.skip(true, `review-states-outside-chat: ${AWAITING_RATIFIED_REVIEW_FLOOR}`);
      },
    },
  },
  states: {
    loading: reviewGateLoadingState("review-states-outside-chat"),
    error: reviewGateBlockedState("review-states-outside-chat"),
    // kind:artifact — what is under review is an ARTIFACT at a pinned
    // representation revision, which is what the header says in its mono line:
    // the type id the artifact declares, the revision the gate pinned, and the
    // pinned marker on it. A target drawn without the pin would be a target the
    // reader could not hold a decision to.
    "kind:artifact": async (_page, root) => {
      const header = root.locator(REVIEW_TARGET_HEADER_SEL);
      const objectType = await root.getAttribute("data-review-target-object-type");
      expect(
        objectType,
        "the harness mount must publish the artifact type id as data-review-target-object-type",
      ).toBeTruthy();
      await expect(header).toContainText(objectType!);
      const revision = header.locator("[data-review-target-revision]");
      await expect(revision).toHaveAttribute(
        "data-review-target-revision",
        LIFECYCLE_REVIEW_TARGET_FIXTURE.revisionId,
      );
      await expect(header).toContainText("pinned");
    },
  },
};

/** The chip row a §IX matrix cell draws. */
function matrixChipRow(cell: Locator): Locator {
  return cell.locator('[data-conformance-id="suggestion-chips"]');
}

/**
 * presence-matrix — §IX: "Every card appears on every host, and it is the same
 * card wherever it appears … Only the frame changes."
 *
 * ON THE READINESS LIST, and the reason is the claim itself. The matrix is about
 * what the HOST DECLARATION does to a card, so the only mount that can grade it
 * is a card that READS that declaration — every shipped one does it the same
 * way (`useLifecycleCardHost`, then `data-lifecycle-card-host` and the host
 * frame), and every shipped one resolves its body through the lifecycle-card
 * transport before it draws anything at all. A harness may not stand a transport
 * up, and the one piece it can mount props-only — the suggestion chip row — does
 * not read the host: dropped into four providers it draws four identical rows
 * whatever the declaration says, so a matrix built from it would stay green
 * through a card that had stopped rendering on a host entirely. That is coverage
 * of the harness, not of the drawing, so nothing is mounted for this surface.
 *
 * The assertions below are written against what a host-aware mount publishes:
 * one cell per host, each drawing the card ITSELF and naming the host it was
 * declared under. They run unchanged the moment such a mount exists.
 */
const PRESENCE_MATRIX_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: harnessRoot("presence-matrix"),
  present: async (_page, root) => {
    await expect(root.locator("[data-presence-host]")).toHaveCount(
      LIFECYCLE_PRESENCE_HOSTS.length,
    );
    // "It is the SAME card wherever it appears": the kind and the drawn state
    // are read off the first cell and then required of every other one, so a
    // per-host variant of the card is a red rather than a cell that happens to
    // hold something.
    const first = root.locator("[data-lifecycle-card]").first();
    const kind = await first.getAttribute("data-lifecycle-card");
    const drawnState = await first.getAttribute("data-lifecycle-card-state");
    for (const host of LIFECYCLE_PRESENCE_HOSTS) {
      const cell = root.locator(`[data-presence-host="${host}"]`);
      // The card the cell drew, and the host IT read — not the host the harness
      // wrote on the cell. A card that stopped drawing under a declaration, or
      // one that read a different one, fails its own cell.
      const card = cell.locator("[data-lifecycle-card]");
      await expect(
        card,
        `§IX: every card appears on every host — nothing is drawn on "${host}"`,
      ).toBeVisible();
      await expect(card).toHaveAttribute("data-lifecycle-card-host", host);
      await expect(card).toHaveAttribute("data-lifecycle-card", kind ?? "");
      await expect(card).toHaveAttribute("data-lifecycle-card-state", drawnState ?? "");
    }
  },
  fields: {},
  actions: {},
  states: {},
};

/**
 * reader-state-matrix — §IX: "What holds a card back is the reader, not the
 * host", and the three readings are never drawn for each other.
 *
 * Each row is a different INPUT to the shipped component, never a different
 * presentation chosen by the harness, and the two inputs are the product's own:
 * the review card passes `onToggleMark` exactly when the reader `canDecide`
 * (packages/agents/src/review-gate-card.tsx), so a mark handler and no mark
 * handler ARE the two readings, and the mode, the press target and the reason
 * sentence are all computed from them by the shipped component.
 *
 * THE THIRD READING IS ON THE READINESS LIST, deliberately. "May not read the
 * target" is not an empty suggestion set — an empty set only proves that a row
 * with nothing in it draws nothing. The real absence is decided inside
 * `ReviewGateCard`, which withholds ALL card DOM before an authorized resolve
 * and again when the reader may not read the target, and reaching either needs
 * the transport this harness may not stand up. Drawing the withheld reading here
 * from an empty list would have graded the harness's own input, so the row is
 * not mounted and is recorded below instead.
 */
const READER_STATE_MATRIX_DRIVER: SurfaceDriver = {
  path: HARNESS_PATH,
  root: harnessRoot("reader-state-matrix"),
  present: async (_page, root) => {
    await expect(root.locator("[data-reader-state]")).toHaveCount(LIFECYCLE_READER_STATES.length);

    // May view and act — the card whole, with its action LIVE (a real press
    // target, not a disabled one).
    const acts = root.locator('[data-reader-state="may-view-and-act"]');
    await expect(matrixChipRow(acts)).toHaveAttribute("data-suggestion-chips-mode", "live");
    await expect(matrixChipRow(acts).getByRole("button")).toHaveCount(1);

    // May view, not act — the card is DRAWN IN FULL and its affordance is gone
    // as a press target, with the reason on screen. Read-only is a different
    // element, never a disabled button: a disabled button would read as "you
    // could do this, later", and this reader could not.
    const views = root.locator('[data-reader-state="may-view-not-act"]');
    const viewRow = matrixChipRow(views);
    await expect(viewRow).toHaveAttribute("data-suggestion-chips-mode", "read-only");
    await expect(viewRow.getByRole("button")).toHaveCount(0);
    await expect(viewRow.locator('[data-conformance-id="suggestion-accepted"]')).toBeVisible();
    await expect(viewRow).toContainText("Deciding these needs approve access on this run.");

    // The two readings are never drawn for each other: read-only is a plain
    // element, and there is no disabled press target anywhere in the matrix.
    await expect(root.locator("button:disabled")).toHaveCount(0);
  },
  fields: {},
  actions: {},
  states: {},
};

// ---------------------------------------------------------------------------
// The wave's SURFACE-READINESS LIST
// ---------------------------------------------------------------------------
//
// Every W9 surface whose declared behaviour is not addressable on the default
// branch today, with what makes it so and what will land it. Each reason is the
// text a skipped test prints, so the list and the skip cannot drift apart.

/** Awaiting the ratified review floor — open pull request cinatra#3100. */
const AWAITING_RATIFIED_REVIEW_FLOOR =
  "the ratified Comment / Regenerate / Continue floor is not on the default " +
  "branch yet — it arrives with open pull request cinatra#3100, which also has " +
  "to reconcile the manifest's `regenerate-review -> successor-gate-opened` " +
  "with the control that pull request ships — and the floor may be composed " +
  "only by the review card itself (the repository's one-card gate forbids a " +
  "page-direct decision composition, and a conformance harness is such a page), " +
  "so the harness mounts no such surface. Every assertion in this driver is " +
  "written and runs unchanged the moment the mount exists.";

/**
 * Awaiting a card mount that READS the host declaration (§IX presence), and the
 * withheld reader reading that goes with it.
 */
const AWAITING_HOST_AWARE_CARD_MOUNT =
  "§IX is a claim about what the HOST DECLARATION does to a card, and every " +
  "shipped card that reads it (`useLifecycleCardHost`) resolves its body " +
  "through the lifecycle-card transport before drawing anything — which a " +
  "conformance harness may not stand up. The one piece mountable props-only, " +
  "the suggestion chip row, does not read the host at all, so a matrix built " +
  "from it would grade the harness rather than the drawing. Nothing is mounted " +
  "for this surface. Every assertion in this driver is written and runs " +
  "unchanged the moment a host-aware mount exists.";

/** Awaiting stable anchors on the shipped conversation column. */
const AWAITING_CONVERSATION_ANCHORS =
  "the conversation column ships (packages/chat/src/conversation-column.tsx) " +
  "but carries no stable conformance anchor for this surface, and it mounts " +
  "only against a host's own chat-view component registry — handing it a " +
  "stand-in registry would be the transport substitution this harness forbids. " +
  "No open pull request read for this wave adds those anchors. Every assertion " +
  "in this driver is written and runs unchanged the moment the mount exists.";

/** Awaiting the relayed refusal as a surface of its own. */
const AWAITING_RELAYED_REFUSAL_TURN =
  "the platform's own sentence ships inside the review card's composer row and " +
  "is drawn only by that card; the ANSWER IN THE TURN that relays it is not a " +
  "shipped surface, so the harness mounts nothing carrying this id. No open " +
  "pull request read for this wave adds it. Every assertion in this driver is " +
  "written and runs unchanged the moment the mount exists.";

/** Awaiting the tool-less sentence inside a conversation. */
const AWAITING_TOOLLESS_IN_CONVERSATION =
  "the platform's tool-less sentence ships for the RUN WINDOW only " +
  "(RUN_WINDOW_TOOL_LESS_NOTICE, src/lib/lifecycle/run-window-turn.ts); the " +
  "conversation's own relay of it, and the composer row that states the limit " +
  "where the binding would have been, are not shipped. No open pull request " +
  "read for this wave adds them. Every assertion in this driver is written and " +
  "runs unchanged the moment the mount exists.";

/**
 * chat-thread — the frame a lifecycle card is met in (§I): the stream, the two
 * turn shapes, and the composer beneath them.
 */
const CHAT_THREAD_DRIVER: SurfaceDriver = awaitingMount(
  "chat-thread",
  {
    path: HARNESS_PATH,
    root: harnessRoot("chat-thread"),
    present: async (_page, root) => {
      const thread = root.locator('[data-conformance-id="chat-thread"]');
      await expect(thread).toBeVisible();
      // §I: two turn shapes — a person's turn and the assistant's — and a card
      // takes the assistant turn's content slot, where prose would sit.
      await expect(thread.locator('[data-turn-shape="person"]')).toBeVisible();
      await expect(thread.locator('[data-turn-shape="assistant"]')).toBeVisible();
      // The composer is part of the frame, drawn beneath the stream.
      await expect(thread.locator('[data-conformance-id="chat-composer"]')).toBeVisible();
    },
    fields: {},
    actions: {},
    states: {},
  },
  AWAITING_CONVERSATION_ANCHORS,
);

/**
 * chat-composer — the conversation's ONE primary input (§I), the box every
 * other place to type in this drawing is subordinate to.
 */
const CHAT_COMPOSER_DRIVER: SurfaceDriver = awaitingMount(
  "chat-composer",
  {
    path: HARNESS_PATH,
    root: harnessRoot("chat-composer"),
    present: async (_page, root) => {
      const composer = root.locator('[data-conformance-id="chat-composer"]');
      await expect(composer).toBeVisible();
      // The primary input, and the send affordance that makes it primary.
      await expect(composer.getByRole("textbox")).toBeVisible();
      await expect(composer.getByRole("button", { name: /send/i })).toBeVisible();
    },
    fields: {},
    actions: {},
    states: {},
  },
  AWAITING_CONVERSATION_ANCHORS,
);

/** The floor's three controls, addressed by the MANIFEST'S own names. */
function floorControl(root: Locator, action: string, outcome: string): Locator {
  return root
    .locator('[data-conformance-id="review-decision-bar"]')
    .locator(`[data-action="${action} -> ${outcome}"]`);
}

/**
 * The ratified floor's three actions, written once and shared by the two
 * surfaces that draw the same floor (§II in the turn, §XII beneath a row that
 * states the conversation's limit).
 *
 * Each is located by the manifest's own action-and-outcome pair, so a driver
 * cannot press one control and report another one's outcome.
 */
function ratifiedFloorActions(): SurfaceDriver["actions"] {
  return {
    // Comment is NON-TERMINAL: it annotates and leaves the card pending, so the
    // floor is still drawn beneath it and the thread simply continues.
    "comment-review": {
      outcome: "annotated",
      run: async (_page, root) => {
        await floorControl(root, "comment-review", "annotated").click();
        await expect(root.locator('[data-review-outcome="annotated"]')).toBeVisible();
        await expect(root.locator('[data-conformance-id="review-decision-bar"]')).toBeVisible();
        await expect(root.locator('[data-review-outcome="decided"]')).toHaveCount(0);
      },
    },
    // Regenerate opens the SUCCESSOR gate: the reviewed work is turned back and
    // the held effect stays held until the successor is decided.
    "regenerate-review": {
      outcome: "successor-gate-opened",
      run: async (_page, root) => {
        await floorControl(root, "regenerate-review", "successor-gate-opened").click();
        await expect(
          root.locator('[data-review-outcome="successor-gate-opened"]'),
        ).toBeVisible();
      },
    },
    // Continue is TERMINAL: the gate resolves and the run is released.
    "continue-review": {
      outcome: "resolved",
      run: async (_page, root) => {
        await floorControl(root, "continue-review", "resolved").click();
        const decided = root.locator('[data-review-outcome="decided"]');
        await expect(decided).toBeVisible();
        // Continued is the only settled reading — there is no second status
        // after it, and no floor beneath it.
        await expect(floorControl(root, "continue-review", "resolved")).toHaveCount(0);
      },
    },
  };
}

/**
 * review-decision-floor-in-thread — the floor that governs the target, drawn in
 * the assistant's turn (§II).
 */
const REVIEW_DECISION_FLOOR_IN_THREAD_DRIVER: SurfaceDriver = awaitingMount(
  "review-decision-floor-in-thread",
  {
    path: HARNESS_PATH,
    root: harnessRoot("review-decision-floor-in-thread"),
    present: async (_page, root) => {
      const floor = root.locator('[data-conformance-id="review-decision-bar"]');
      await expect(floor).toBeVisible();
      // §I's input hierarchy: the note field is SUBORDINATE to the chat box —
      // present, never a second primary input.
      await expect(
        floor.locator('[data-conformance-id="review-note-field-subordinate"]'),
      ).toBeVisible();
      for (const [action, outcome] of [
        ["comment-review", "annotated"],
        ["regenerate-review", "successor-gate-opened"],
        ["continue-review", "resolved"],
      ] as const) {
        await expect(floorControl(root, action, outcome)).toBeVisible();
      }
    },
    fields: {},
    actions: ratifiedFloorActions(),
    states: {},
  },
  AWAITING_RATIFIED_REVIEW_FLOOR,
);

/**
 * decision-floor-live-under-limit — §XII: a conversation whose model cannot use
 * tools cannot work a card by typing, and the card keeps EVERY affordance live.
 * What is closed is the typed road, and only that.
 */
const DECISION_FLOOR_LIVE_UNDER_LIMIT_DRIVER: SurfaceDriver = awaitingMount(
  "decision-floor-live-under-limit",
  {
    path: HARNESS_PATH,
    root: harnessRoot("decision-floor-live-under-limit"),
    present: async (_page, root) => {
      // The limit is stated where the binding would have been, with the row's
      // own toggle disabled — there is no binding to take or give back.
      const row = root.locator('[data-conformance-id="composer-cannot-act"]');
      await expect(row).toBeVisible();
      await expect(row.locator('[data-action="focus-review-composer -> bound"]')).toBeDisabled();
      await expect(
        row.locator('[data-conformance-id="composer-cannot-act-reason"]'),
      ).toBeVisible();
      // And the floor beneath it stays LIVE: nothing on the card is disabled.
      for (const [action, outcome] of [
        ["comment-review", "annotated"],
        ["regenerate-review", "successor-gate-opened"],
        ["continue-review", "resolved"],
      ] as const) {
        await expect(floorControl(root, action, outcome)).toBeEnabled();
      }
    },
    fields: {},
    actions: ratifiedFloorActions(),
    states: {},
  },
  AWAITING_RATIFIED_REVIEW_FLOOR,
);

/**
 * The two relayed refusals (§XI). A refusal is the platform's own sentence, said
 * back — never softened, never re-worded, and never replaced by an act. So both
 * drivers assert the SAME WORDS the composer row carries, in the turn.
 */
function relayedRefusalDriver(surfaceId: string, sentence: RegExp): SurfaceDriver {
  return awaitingMount(
    surfaceId,
    {
      path: HARNESS_PATH,
      root: harnessRoot(surfaceId),
      present: async (_page, root) => {
        const turn = root.locator(`[data-conformance-id="${surfaceId}"]`);
        await expect(turn).toBeVisible();
        // The sentence, unchanged — one wording, not three readings of one
        // situation.
        await expect(turn).toContainText(sentence);
        // The message is answered, and nothing is lent: the turn carries no
        // control of its own.
        await expect(turn.getByRole("button")).toHaveCount(0);
      },
      fields: {},
      actions: {},
      states: {},
    },
    AWAITING_RELAYED_REFUSAL_TURN,
  );
}

/** relayed-refusal-ambiguous — more than one review is waiting, so nothing routes. */
const RELAYED_REFUSAL_AMBIGUOUS_DRIVER: SurfaceDriver = relayedRefusalDriver(
  "relayed-refusal-ambiguous",
  /More than one review is waiting/,
);

/** relayed-refusal-restricted — the reader may read the card but not decide it. */
const RELAYED_REFUSAL_RESTRICTED_DRIVER: SurfaceDriver = relayedRefusalDriver(
  "relayed-refusal-restricted",
  /needs approve access on the run/,
);

/**
 * toolless-said-in-turn — §XII: asked to act, the answer states the limit
 * plainly, and says the card's own control is live. Never a silent no-op.
 */
const TOOLLESS_SAID_IN_TURN_DRIVER: SurfaceDriver = awaitingMount(
  "toolless-said-in-turn",
  {
    path: HARNESS_PATH,
    root: harnessRoot("toolless-said-in-turn"),
    present: async (_page, root) => {
      const turn = root.locator('[data-conformance-id="toolless-said-in-turn"]');
      await expect(turn).toBeVisible();
      // The limit is the CONVERSATION'S MODEL, and the answer says so.
      await expect(turn).toContainText(/cannot use tools/);
      // And it says the card's own control still works, because it does.
      await expect(turn).toContainText(/Continue/);
      // The turn lends nothing: it states the limit, it does not act.
      await expect(turn.getByRole("button")).toHaveCount(0);
    },
    fields: {},
    actions: {},
    states: {},
  },
  AWAITING_TOOLLESS_IN_CONVERSATION,
);

/** Covered manifest surfaces → drivers. Everything else: allowlist or RED. */
export const SURFACE_DRIVERS: Record<string, SurfaceDriver> = {
  "extension-install-panel": INSTALL_PANEL_DRIVER,
  "connector-setup": CONNECTOR_SETUP_DRIVER,
  "connector-config-tab": CONNECTOR_CONFIG_TAB_DRIVER,
  "connector-multi-setup": CONNECTOR_MULTI_SETUP_DRIVER,
  "connector-connections": CONNECTOR_CONNECTIONS_DRIVER,
  "notifications-list": NOTIFICATIONS_LIST_DRIVER,
  "notifications-filters": NOTIFICATIONS_FILTERS_DRIVER,
  "notification-row": NOTIFICATION_ROW_DRIVER,
  "approval-row": APPROVAL_ROW_DRIVER,
  "notifications-filter-rail": NOTIFICATIONS_FILTER_RAIL_DRIVER,
  "notifications-bell": NOTIFICATIONS_BELL_DRIVER,
  "notifications-empty": NOTIFICATIONS_EMPTY_DRIVER,
  "notifications-vendor-gate": NOTIFICATIONS_VENDOR_GATE_DRIVER,
  "notifications-degraded": NOTIFICATIONS_DEGRADED_DRIVER,
  "status-pills": STATUS_PILLS_DRIVER,
  "button-variants": BUTTON_VARIANTS_DRIVER,
  "extension-listing-grid": EXTENSION_LISTING_GRID_DRIVER,
  "installed-extensions-list": INSTALLED_EXTENSIONS_LIST_DRIVER,
  "installed-extensions-filter": INSTALLED_EXTENSIONS_FILTER_DRIVER,
  "installed-extensions-status-views": INSTALLED_EXTENSIONS_STATUS_VIEWS_DRIVER,
  "install-config-needs-callout": INSTALL_CONFIG_NEEDS_CALLOUT_DRIVER,
  "connector-grid": CONNECTOR_GRID_DRIVER,
  "connector-connection-filter": CONNECTOR_CONNECTION_FILTER_DRIVER,
  "connector-install-cta": CONNECTOR_INSTALL_CTA_DRIVER,
  "connector-empty-panel": CONNECTOR_EMPTY_PANEL_DRIVER,
  "extension-detail-modal": EXTENSION_DETAIL_MODAL_DRIVER,
  "approvals-inbox": APPROVALS_INBOX_DRIVER,
  "approvals-your-requests": APPROVALS_YOUR_REQUESTS_DRIVER,
  "approvals-marketplace-states": APPROVALS_MARKETPLACE_STATES_DRIVER,
  "scheduling-step": SCHEDULING_STEP_DRIVER,
  "scheduling-step-configured": SCHEDULING_STEP_CONFIGURED_DRIVER,
  "sidebar-assistants-entry": SIDEBAR_ASSISTANTS_ENTRY_DRIVER,
  "breadcrumb-entity-resolution": BREADCRUMB_ENTITY_RESOLUTION_DRIVER,
  // The Workspace surfaces the ratified drawing adds (epic cinatra#2806). Their
  // manifest is not pinned yet, so these generate no test today; they are what
  // the recorded pin advance is waiting for, and they SKIP with a reason until
  // the harness mounts the real surface (cinatra#3152).
  "sidebar-workspace-entry": SIDEBAR_WORKSPACE_ENTRY_DRIVER,
  "workspace-scope-page": WORKSPACE_SCOPE_PAGE_DRIVER,
  "workspace-scope-empty-tab": WORKSPACE_SCOPE_EMPTY_TAB_DRIVER,
  // The entity-page tab the same ratification amended (section IX of the
  // artifacts drawing). Its manifest is STAGED, not pinned, so only the
  // aspects driven here generate a test; each SKIPS with a reason until the
  // harness mounts the surface (cinatra#3152).
  "scope-dashboards-tab": SCOPE_DASHBOARDS_TAB_DRIVER,
  ...Object.fromEntries(
    CONFORMANCE_CARD_FIXTURES.map((fixture) => [fixture.surfaceId, cardDriver(fixture)]),
  ),
  // The artifact-kind display surfaces of the artifact-review drawing, standalone
  // (cinatra#3158, epic #3155 W2). Built from ONE row list, so being listed is
  // being mapped; each SKIPS with the reason its display is waiting for until the
  // harness mounts it.
  ...ARTIFACT_KIND_DISPLAY_DRIVERS,
  // The run step-rail family of the artifact-review drawing (cinatra#3162, epic
  // #3155 W6). Built from ONE row list, so being listed is being mapped; the rail
  // itself is mounted and runs for real, and every other surface SKIPS with the
  // reason it is waiting for until the harness mounts it.
  ...RUN_STEP_RAIL_FAMILY_DRIVERS,
  // The in-conversation suggestion chips (cinatra#3156, epic #3155). One family
  // factory over one fixture list — the later waves add rows, not drivers.
  ...Object.fromEntries(
    LIFECYCLE_SUGGESTION_CHIP_FIXTURES.map((fixture) => [
      SUGGESTION_CHIP_MANIFEST_SURFACE[fixture.mount],
      suggestionChipDriver(fixture),
    ]),
  ),
  // The in-conversation artifact-kind cards (cinatra#3157, epic #3155 W1). One
  // family factory over one fixture list — the surfaces differ below §IV's
  // header and are identical on it, so the later waves add rows, not drivers.
  ...Object.fromEntries(
    LIFECYCLE_REVIEW_TARGET_HEADER_FIXTURES.map((fixture) => [
      fixture.surfaceId,
      reviewTargetHeaderDriver(fixture),
    ]),
  ),
  // The in-conversation review-composer row (cinatra#3159, epic #3155 W3). One
  // shipped row with three readings and one control, mounted once per reading.
  ...COMPOSER_FAMILY_DRIVERS,
  // The in-conversation schedule card (cinatra#3161, epic #3155 W5). Nine
  // manifest surfaces over the drawing's five readings — the card and the floor
  // beneath it are annotated separately — driven by one family factory over one
  // fixture list, which is why a row names its own manifest surface.
  ...Object.fromEntries(
    LIFECYCLE_SCHEDULE_CARD_FIXTURES.map((fixture) => [
      fixture.surfaceId,
      scheduleCardDriver(fixture),
    ]),
  ),
  // The review-target and decision-floor surfaces of the artifact-review drawing
  // (cinatra#3163, epic #3155 W7). Built from ONE row list, so being listed is
  // being mapped; the gate's loading and blocked readings run for real on the
  // harness mount this wave lands, and the other thirteen SKIP with the reason
  // each is waiting for.
  ...REVIEW_DECISION_FLOOR_DRIVERS,
  // §III's three renderer tiers (cinatra#3164, epic #3155 W8). The metadata
  // floor is mounted; the two loadable tiers are written in full and skip on the
  // missing mount — the harness admits no resolved renderer.
  "tier-metadata-floor": TIER_METADATA_FLOOR_DRIVER,
  "tier-build-time": TIER_BUILD_TIME_DRIVER,
  "tier-runtime": TIER_RUNTIME_DRIVER,
  // §VII's verification card, §IV's review-state ladder and §VIII's decision
  // floor — one factory per family over one fixture list, on the resolve seam.
  ...Object.fromEntries(
    LIFECYCLE_RESOLVE_FIXTURES.map((fixture: LifecycleResolveFixture) => [
      fixture.mount,
      fixture.kind === "verification_summary"
        ? verificationDriver(fixture)
        : reviewCardStateDriver(fixture),
    ]),
  ),
  // The drawing's ONE-OFF surfaces (cinatra#3165, epic #3155 W9). Five are
  // driven from the shipped components on the harness; seven are written in
  // full and SKIP with the reason on this wave's surface-readiness list until
  // the mount they name exists.
  "review-target-in-thread": REVIEW_TARGET_IN_THREAD_DRIVER,
  "run-progress-placeholder-in-thread": RUN_PROGRESS_PLACEHOLDER_IN_THREAD_DRIVER,
  "review-states-outside-chat": REVIEW_STATES_OUTSIDE_CHAT_DRIVER,
  "presence-matrix": awaitingMount(
    "presence-matrix",
    PRESENCE_MATRIX_DRIVER,
    AWAITING_HOST_AWARE_CARD_MOUNT,
  ),
  "reader-state-matrix": READER_STATE_MATRIX_DRIVER,
  "chat-thread": CHAT_THREAD_DRIVER,
  "chat-composer": CHAT_COMPOSER_DRIVER,
  "review-decision-floor-in-thread": REVIEW_DECISION_FLOOR_IN_THREAD_DRIVER,
  "decision-floor-live-under-limit": DECISION_FLOOR_LIVE_UNDER_LIMIT_DRIVER,
  "relayed-refusal-ambiguous": RELAYED_REFUSAL_AMBIGUOUS_DRIVER,
  "relayed-refusal-restricted": RELAYED_REFUSAL_RESTRICTED_DRIVER,
  "toolless-said-in-turn": TOOLLESS_SAID_IN_TURN_DRIVER,
};
