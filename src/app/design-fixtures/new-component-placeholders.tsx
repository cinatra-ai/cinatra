import { BotIcon, MailIcon, FileTextIcon } from "lucide-react";

import { StatusPill } from "@/components/ui/status-pill";
import { BrandMark } from "@/components/brand-mark";
import { ExtensionCard } from "@/components/extension-card";

import { PrimitiveRow } from "./primitive-row";

// Real components live in `src/components/`.
// The row shape is preserved so reviewers can diff against the committed
// baseline.

export function NewComponentPlaceholders() {
  return (
    <div className="flex flex-col">
      <PrimitiveRow
        name="StatusPill (§VI)"
        spec="@/components/ui/status-pill"
        conformance="10 states; running=indigo (R1); icon-led; never bare dot. Central adapter in src/lib/status-adapter.ts maps every run/approval/lifecycle/connection enum."
      >
        <StatusPill status="running" />
        <StatusPill status="approved" />
        <StatusPill status="hold" />
        <StatusPill status="needs-review" />
        <StatusPill status="scheduled" />
        <StatusPill status="queued" />
        <StatusPill status="idle" />
        <StatusPill status="archived" />
        <StatusPill status="failed" />
        <StatusPill status="declined" />
      </PrimitiveRow>
      <PrimitiveRow
        name="BrandMark (§I)"
        spec="@/components/brand-mark"
        conformance="Fedora + italic Archivo 800 wordmark; tones mustard (default) / ink / paper / black; variants animated (sparkles, prefers-reduced-motion compliant) / static."
      >
        <BrandMark variant="static" tone="mustard" size={28} />
        <BrandMark variant="static" tone="ink" size={28} />
        <BrandMark variant="animated" tone="mustard" size={28} />
      </PrimitiveRow>
      <PrimitiveRow
        name="ExtensionCard (§V)"
        spec="@/components/extension-card"
        conformance="Emblem on white-pill (left), live indicator (right), random ACCENT palette ground (red / burgundy / indigo / green / mustard / slate). accentColor persisted at creation time."
      >
        <div className="w-72">
          <ExtensionCard
            name="Email Outreach Agent"
            accentColor="indigo"
            emblem={<BotIcon className="size-5" />}
            indicator={{ label: "Daily 9am", dotColour: "var(--success)" }}
          />
        </div>
        <div className="w-72">
          <ExtensionCard
            name="Gmail Connector"
            accentColor="red"
            emblem={<MailIcon className="size-5" />}
            indicator={{ label: "Connected" }}
          />
        </div>
        <div className="w-72">
          <ExtensionCard
            name="Blog Pipeline"
            accentColor="green"
            emblem={<FileTextIcon className="size-5" />}
            indicator={{ label: "Updating", spinning: true }}
          />
        </div>
      </PrimitiveRow>
    </div>
  );
}
