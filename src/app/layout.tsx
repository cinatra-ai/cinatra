import type { Metadata } from "next";
import { Inter, Manrope, Geist, Archivo, JetBrains_Mono } from "next/font/google";
import { getGoogleOAuthSettings } from "@cinatra-ai/google-oauth-connection";
import { AppShell } from "@/components/app-shell";
import { buildCanDoOptsFromSession, getAuthSession, isPlatformAdmin } from "@/lib/auth-session";
import { canDo } from "@/lib/authz";
import { isSingleOrgMode } from "@/lib/authz/instance-mode";
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
  const hiddenNavTitles: string[] = [];
  // Aggregate of pending workflow approvals + admin-only agent creation
  // requests, resolved server-side and consumed by AppSidebar to drive the
  // Admin → Approvals pill. Defaults to 0 on any resolution error.
  let pendingApprovalsTotal = 0;
  try {
    const [setupCompleteResult, googleOAuthSettingsResult, session, singleOrgResult] = await Promise.all([
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
    ]);
    setupComplete = setupCompleteResult;
    googleOAuthSettings = googleOAuthSettingsResult;
    singleOrg = singleOrgResult;
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
    // The inbound-webhook registry (Tools → Webhooks, cinatra#342) is an
    // admin-tier surface — hide it for any non-admin actor (covers the
    // no-session and the non-admin-member cases). The page itself re-enforces
    // with requireAdminSession(); this hide is cosmetic-but-correct, mirroring
    // the admin-group gate rather than the member-granted settings.read.
    if (!isAdmin) {
      hiddenNavTitles.push("Webhooks");
    }
    if (session) {
      try {
        const { pendingApprovalsCount } = await import("@/lib/pending-approvals-count");
        const counts = await pendingApprovalsCount();
        pendingApprovalsTotal = counts.total;
      } catch {
        // Soft-fail — the pill just stays hidden.
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
        <Providers googleEnabled={googleEnabled}>
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
