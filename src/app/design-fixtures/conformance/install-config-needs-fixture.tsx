// ---------------------------------------------------------------------------
// Post-install "needs configuration" callout — conformance harness fixture
// (cinatra#985 functional-acceptance; surface `install-config-needs-callout`,
// design#71 specs/app-extensions.html §VI). Mounts the REAL
// `InstalledExtensionCard` (the §III installed-extension card) with a
// non-empty `configurationNeeds` list, so the card renders its greyed
// needs-review treatment and the REAL `NeedsReviewStrip` — the "Set up
// connections first:" callout the spec depicts — on a production-equivalent
// standalone build, with no session, DB, or connector-readiness round-trip.
//
// Two variants keyed by the harness `data-variant` instrumentation:
//   - populated: one unconfigured required connector → the strip renders, its
//     displayName links to the connector's own setup page;
//   - empty:     every required connector configured → NO strip, card active.
//
// Kept OFF the pixel-diffed /design-fixtures index page (same convention as the
// sibling conformance fixtures): coverage here is assertion-based —
// tests/e2e/design/conformance/functional-acceptance.spec.ts.
// ---------------------------------------------------------------------------

import {
  InstalledExtensionCard,
  InstalledStatusIndicator,
} from "@/components/extensions/installed-extension-card";
import { extensionKindEmblem } from "@/components/extension-kind-emblem";
import { deriveExtensionAccent } from "@/lib/extension-accent";
import { resolveVendorPresentation } from "@/lib/vendor-presentation";
import type { ConfigurationNeed } from "@/lib/extension-dependency-ux";
import { Button } from "@/components/ui/button";

import { CONFORMANCE_INSTALL_CONFIG_CALLOUT as CALLOUT } from "./fixture-data";

const ACCENT = deriveExtensionAccent(CALLOUT.agent.packageName);
// Resolve the byline vendor through the SAME single resolver the real §III card
// caller uses (never a forged literal — the presentation is a branded type).
const VENDOR = resolveVendorPresentation(
  { name: CALLOUT.agent.vendorName },
  {
    surface: "install-config-needs-conformance-fixture",
    ref: CALLOUT.agent.packageName,
  },
);

const REQUIRED_CONNECTOR: ConfigurationNeed = {
  packageName: CALLOUT.connector.packageName,
  displayName: CALLOUT.connector.displayName,
  slug: CALLOUT.connector.slug,
  settingsHref: CALLOUT.connector.settingsHref,
};

function HostCard({ configured }: { configured: boolean }) {
  return (
    <InstalledExtensionCard
      name={CALLOUT.agent.displayName}
      accentColor={ACCENT}
      emblem={extensionKindEmblem("agent")}
      kindIcon={extensionKindEmblem("agent", "size-3.5")}
      kindLabel={CALLOUT.agent.kindLabel}
      vendor={VENDOR}
      description={CALLOUT.agent.description}
      version={CALLOUT.agent.version}
      status={<InstalledStatusIndicator status="active" />}
      actions={
        <>
          <Button size="sm" variant="secondary">
            Settings
          </Button>
          <Button type="button" variant="ghost" size="sm">
            More details
          </Button>
        </>
      }
      // Non-empty → the greyed needs-review card + the strip (the conformance
      // surface). Empty → the active card with no strip (the `empty` variant).
      configurationNeeds={configured ? [] : [REQUIRED_CONNECTOR]}
    />
  );
}

export function InstallConfigNeedsConformanceFixture() {
  return (
    <div className="flex flex-col gap-4">
      <div data-surface-id="install-config-needs-callout" data-variant="populated">
        <HostCard configured={false} />
      </div>
      <div data-surface-id="install-config-needs-callout" data-variant="empty">
        <HostCard configured />
      </div>
    </div>
  );
}
