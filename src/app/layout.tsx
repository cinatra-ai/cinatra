import type { Metadata } from "next";
import { Inter, Manrope, Geist, Archivo, JetBrains_Mono } from "next/font/google";
import { getGoogleOAuthSettings } from "@cinatra-ai/google-oauth-connection";
import { AppShell } from "@/components/app-shell";
import { buildCanDoOptsFromSession, getAuthSession, isPlatformAdmin } from "@/lib/auth-session";
import { canDo } from "@/lib/authz";
import { hasAnyBetterAuthUsers } from "@/lib/auth";
import { isRegistrationClosed, isSingleOrgMode } from "@/lib/authz/instance-mode";
import { userCanCreateTeams } from "@/lib/better-auth-db";
import { isSetupWizardComplete } from "@/lib/setup-wizard";
import { getUserAccentColor } from "@/lib/accent-color-store";
import type { ExtensionAccent } from "@/lib/extension-accent";
import { Providers } from "@/app/providers";
import "./globals.css";
// drizzle-cube styles + Cinatra --dc-* overrides live inside
// `@cinatra-ai/dashboards` (the only package that declares drizzle-cube as
// a direct dep). The DashboardsClientShell loads them so they only paint when
// a dashboard route mounts.

// Cinatra is an auth-gated app where every page renders per-user DB-backed
// content — there's nothing to prerender statically. Forcing dynamic at the
// root layout skips Next's static-prerender pass (which would otherwise try
// to hit Postgres during `next build` with no DB available, e.g. inside the
// Docker image build). Pages that legitimately want static rendering can
// still override this locally with `export const dynamic = "force-static"`.
export const dynamic = "force-dynamic";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-manrope",
  display: "swap",
});

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
  display: "swap",
});

const archivo = Archivo({
  subsets: ["latin"],
  variable: "--font-archivo",
  display: "swap",
});

// JetBrains Mono backs --font-mono for microcopy, IDs, and table headers.
// The shared `archivo` font is also bound to `--font-display` in globals.css;
// Inter stays on --font-sans.
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Cinatra",
    template: "%s | Cinatra",
  },
  description:
    "Open source enterprise intelligence platform for orchestrating agents, workflows, data, content, connectors, and analytics from one shared workspace.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Wrap in try/catch so a transient Postgres timeout or Nango API error does
  // NOT propagate as an unhandled root-layout exception (which produces a blank
  // white page when there is no global-error.tsx to catch it). Fall back to
  // safe defaults so the app stays visible — the next navigation will retry.
  let setupComplete = false;
  let googleOAuthSettings: { clientId?: string; clientSecret?: string } = {};
  let canCreateProjects = false;
  let canCreateTeams = false;
  let canCreateOrganizations = false;
  let isAdmin = false;
  let userAccentColor: ExtensionAccent | null = null;
  // Server-resolved nav gating.
  let singleOrg = false;
  // D7 — suppress the sign-up surface in the root AuthUIProvider when
  // registration is closed AND the instance is past bootstrap (≥1 human user).
  // Defaults to true (sign-up shown) on any resolution error so an open
  // instance never wrongly hides sign-up.
  let signUpEnabled = true;
  const hiddenNavTitles: string[] = [];
  // The notifications bell badge's approvals contribution (E8 cutover,
  // cinatra#1558, spec §IV): the viewer's Inbox-actionable approval count across
  // the ApprovalSource registry. The standalone sidebar "Approvals" nav item was
  // removed (§VII); this SAME count now rides the bell badge (combined with the
  // E6 store's unread notifications) so "what needs the viewer" — including a
  // pending approval that needs their decision — is never signal-less. Defaults
  // to 0 on any resolution error.
  let pendingApprovalsTotal = 0;
  try {
    const [
      setupCompleteResult,
      googleOAuthSettingsResult,
      session,
      singleOrgResult,
      registrationClosedResult,
      hasUsersResult,
    ] = await Promise.all([
      isSetupWizardComplete(),
      // Per-call .catch so one DB-dependent read failing does NOT reject the
      // whole Promise.all and discard the others. Critically, a failing
      // getGoogleOAuthSettings()/getAuthSession() must NOT wipe out the
      // CINATRA_E2E_SETUP_BYPASS-driven isSetupWizardComplete()===true — otherwise
      // setupComplete falls back to false and the app renders the first-run setup
      // wizard instead of the requested route (this is exactly what broke the
      // prod-standalone /design-fixtures pixel-diff: no DB → both reads threw →
      // Promise.all rejected → setup wizard rendered). Mirrors the existing
      // isSingleOrgMode().catch(); the post-Promise.all session reads are already
      // individually .catch-guarded below.
      getGoogleOAuthSettings().catch(() => ({})),
      getAuthSession().catch(() => null),
      isSingleOrgMode().catch(() => false),
      // D7 — both reads fail-soft so an error keeps sign-up shown (open).
      isRegistrationClosed().catch(() => false),
      hasAnyBetterAuthUsers().catch(() => false),
    ]);
    setupComplete = setupCompleteResult;
    googleOAuthSettings = googleOAuthSettingsResult;
    singleOrg = singleOrgResult;
    // Hide sign-up only when the instance is past bootstrap (a human exists)
    // AND registration is closed. Zero humans → always show sign-up (bootstrap).
    signUpEnabled = !(registrationClosedResult && hasUsersResult);
    if (session) {
      const canDoOpts = await buildCanDoOptsFromSession(session).catch(() => ({}));
      canCreateProjects = canDo(session, "project.create", undefined, canDoOpts);
      canCreateTeams = await userCanCreateTeams(session.user.id, session.user.role).catch(() => false);
      // Single-org mode blocks org creation for everyone (the underlying
      // scope model is untouched; create paths only).
      canCreateOrganizations = !singleOrg && canDo(session, "organization.create", undefined, canDoOpts);
      // Persisted Avatar accent falls back to null (muted-ground Avatar) when
      // the column is absent or unset.
      userAccentColor = await getUserAccentColor(session.user.id).catch(() => null);
      // Hide nav targets the actor can't read. Analytics (cost/usage metrics)
      // is admin-tier; hide for non-admins rather than relying on a 403 at
      // the page.
      if (!canDo(session, "metric.read", undefined, canDoOpts)) {
        hiddenNavTitles.push("Analytics");
      }
    } else {
      // No session — hide the admin-tier nav target.
      hiddenNavTitles.push("Analytics");
    }
    isAdmin = isPlatformAdmin(session);
    // The inbound-webhook registry moved under Configuration (cinatra#696) — it
    // no longer has its own sidebar nav title to hide. The page itself
    // (/configuration/webhooks) re-enforces with requireAdminSession().
    const orgId = session?.session?.activeOrganizationId ?? null;
    if (session && orgId) {
      try {
        // IMPORT-LIGHT nav registry ONLY (cinatra#1283) — never the heavy
        // `sources/registry`, whose decide/render graph (→
        // `@cinatra-ai/agents/mcp-handlers` + the client decision-action
        // components) would be compiled into EVERY route via this root layout
        // and OOM `next build`. The nav registry enumerates the same source
        // list, so the count still reflects a new source with no edit here.
        // Post-#1558 the resolved `total` feeds the BELL badge (spec §IV), not
        // a sidebar pill; `visible` is unused (the bell always renders).
        //
        // EXACTNESS BOUND (carried over verbatim from the retired sidebar pill —
        // NOT introduced here): `summary.total` is the import-light sum of each
        // available source's `counts().inbox`. For the v1 local sources the inbox
        // applies only to viewers who can decide, so total == the §IV
        // viewer-eligibility ("Needs action") count. It CAN diverge only if a
        // source begins emitting PER-ROW eligibility (a marketplace row a viewer
        // may see but not decide): the /notifications feed row-filters those out
        // of "Needs action" (`feed-view-model.ts` — both `can_approve` and
        // `can_reject` false), whereas this light inbox count cannot without
        // pulling per-row eligibility into the root-layout graph (the exact thing
        // the import-light split forbids). No source emits per-row eligibility
        // today, so the counts match now; reconciling the bell badge with the
        // feed's row-level "Needs action" once one does is E11 conformance
        // (#1561 — badge⇔feed parity), not resolvable in this layout pass.
        const [{ availableNavSources }, { summarizeApprovalsNav }] = await Promise.all([
          import("@/app/configuration/approvals/sources/nav-registry"),
          import("@/app/configuration/approvals/nav-summary"),
        ]);
        const viewer = { userId: session.user.id, orgId, isAdmin };
        const summary = await summarizeApprovalsNav(await availableNavSources(viewer), viewer);
        pendingApprovalsTotal = summary.total;
      } catch {
        // Soft-fail — the bell's approvals contribution stays 0.
      }
    }
  } catch (err) {
    console.error("[layout] Failed to evaluate setup or OAuth state — using defaults:", err);
    // setupComplete=false will show the setup wizard as a fallback; this is
    // safe because the setup pages do not depend on connectionReady.
  }
  const connectionReady = setupComplete;
  const googleEnabled = Boolean(googleOAuthSettings.clientId && googleOAuthSettings.clientSecret);

  return (
    <html lang="en" className={`${inter.variable} ${manrope.variable} ${geist.variable} ${archivo.variable} ${jetbrainsMono.variable}`} suppressHydrationWarning>
      <body>
        <Providers googleEnabled={googleEnabled} signUpEnabled={signUpEnabled}>
          <AppShell
            connectionReady={connectionReady}
            canCreateProjects={canCreateProjects}
            canCreateTeams={canCreateTeams}
            canCreateOrganizations={canCreateOrganizations}
            isAdmin={isAdmin}
            userAccentColor={userAccentColor}
            singleOrg={singleOrg}
            hiddenNavTitles={hiddenNavTitles}
            pendingApprovalsTotal={pendingApprovalsTotal}
          >
            {children}
          </AppShell>
        </Providers>
      </body>
    </html>
  );
}
