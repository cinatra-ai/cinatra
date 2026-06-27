import type { Metadata } from "next";

import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { requireAdminSession } from "@/lib/auth-session";
import { isRegistrationClosed, isSingleOrgMode } from "@/lib/authz/instance-mode";
import { getAuditRetentionDays } from "@/lib/authz/audit";

import { AccessControlForm } from "./access-control-form";

export const metadata: Metadata = {
  title: "Access Control",
};

/**
 * platform Access Control admin surface. Hosts the
 * single-org compatibility toggle + the audit-log retention
 * knob. Platform-admin gated.
 */
export default async function AccessControlPage() {
  await requireAdminSession();
  const [singleOrg, registrationClosed, retentionDays] = await Promise.all([
    isSingleOrgMode().catch(() => false),
    isRegistrationClosed().catch(() => false),
    getAuditRetentionDays().catch(() => 365),
  ]);

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Access Control"
        description="Platform-wide authorization controls — organization mode, self-registration, and audit-log retention."
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <AccessControlForm
          initialSingleOrg={singleOrg}
          initialRegistrationClosed={registrationClosed}
          initialRetentionDays={retentionDays}
        />
      </PageContent>
    </Main>
  );
}
