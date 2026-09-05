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
import { artifactKindLabelFor } from "../../../../src/lib/artifacts/artifact-kind-label";
import {
  reviewRevisionMarker,
  reviewTargetRowFacts,
} from "../../../../src/lib/artifacts/review-surface-model";
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
};

export function suggestionChipDriver(fixture: LifecycleSuggestionChipFixture): SurfaceDriver {
  const rootSel = `[data-surface-id="${fixture.mount}"]`;

  return {
    path: HARNESS_PATH,
    root: (page) => page.locator(rootSel),
    present: async (_page, root) => {
      const row = chipRow(root);
      await expect(row).toBeVisible();
      // LIVE, not the recorded or the read-only partition: this reader may mark.
      await expect(row).toHaveAttribute("data-suggestion-chips-mode", "live");
      // A suggestion ARRIVES accepted — there is no unmarked state to return to.
      const accepted = row.locator('[data-conformance-id="suggestion-accepted"]');
      await expect(accepted).toBeVisible();
      await expect(accepted).toHaveAttribute("data-suggestion-state", "accepted");
      await expect(accepted).toContainText(fixture.suggestion.label);
    },
    fields: {},
    actions: {
      // The chip's one control on an accepted suggestion. The press is the REAL
      // chip button and every drawn consequence — the state it moves to, the
      // control it then offers, the name of that control — is computed by the
      // shipped component from the reader's local marks.
      "dismiss-suggestion": {
        outcome: "dismissed",
        run: async (_page, root) => {
          const row = chipRow(root);
          const dismissedChip = row.locator('[data-conformance-id="suggestion-dismissed"]');
          await pressChipUntil(chipOffering(root, "dismiss-suggestion", "dismissed"), async () => {
            await expect(dismissedChip).toBeVisible({ timeout: 5_000 });
          });
          await expect(dismissedChip).toHaveAttribute("data-suggestion-state", "dismissed");
          // ONE control per suggestion, and the toggle is its own inverse: the
          // accepted reading is gone and the same chip now offers the way back.
          await expect(row.locator('[data-conformance-id="suggestion-accepted"]')).toHaveCount(0);
          await expect(chipOffering(root, "accept-suggestion", "accepted")).toHaveCount(1);
          // A dismissal is a MARK, not a submit — the row stays live and the
          // suggestion stays on screen (§VIII: the chips carry no submit).
          await expect(row).toHaveAttribute("data-suggestion-chips-mode", "live");
          await expect(dismissedChip).toContainText(fixture.suggestion.label);
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
//     `artifactKindLabelFor` from the row's type id), the type id on the meta line,
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
        // PRODUCT's own `artifactKindLabelFor` from the row's type id — the call the
        // server-side composer makes — so a harness that ever worded a label of
        // its own is red here, and the tag is asserted on BOTH readings: the
        // attribute value and the text a reader actually sees.
        const tag = header.locator("[data-review-target-type]");
        await expect(tag).toHaveCount(1);
        await expect(tag).toHaveAttribute(
          "data-review-target-type",
          artifactKindLabelFor(seed.objectType),
        );
        await expect(tag).toHaveText(artifactKindLabelFor(seed.objectType));
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

function awaitingMount(surfaceId: string, driver: SurfaceDriver): SurfaceDriver {
  const guard = async (page: Page): Promise<void> => {
    await expect(
      page.locator(`[data-surface-id="${HARNESS_ANCHOR_SURFACE_ID}"]`).first(),
      `the conformance harness itself did not render — this is a real failure, never a surface awaiting cinatra#3152`,
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
    test.skip(!mounted, `${surfaceId}: ${AWAITING_PER_SCOPE_SURFACES}`);
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
};
