import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import type { ObjectRendererSlotProps } from "@cinatra-ai/objects/renderer-types";
import type { AgentTemplateRecord } from "@cinatra-ai/agents/store";

export function AgentTemplateListRow({
  value,
  compact,
}: ObjectRendererSlotProps<AgentTemplateRecord>) {
  return (
    <div className="flex items-center gap-3 py-2">
      <Link
        href={`/agents/builder/${encodeURIComponent(value.id)}`}
        className="font-medium underline-offset-4 hover:underline"
      >
        {value.name}
      </Link>
      {value.status ? (
        <Badge className="rounded-full px-2 py-0.5 text-xs uppercase">{value.status}</Badge>
      ) : null}
      {!compact && value.description ? (
        <span className="text-xs text-muted-foreground line-clamp-1">{value.description}</span>
      ) : null}
    </div>
  );
}

export function AgentTemplateCard({ value }: ObjectRendererSlotProps<AgentTemplateRecord>) {
  return (
    <article className="soft-panel rounded-card p-4">
      <header className="flex items-center gap-2">
        <Link
          href={`/agents/builder/${encodeURIComponent(value.id)}`}
          className="text-base font-semibold underline-offset-4 hover:underline"
        >
          {value.name}
        </Link>
        {value.status ? <Badge>{value.status}</Badge> : null}
      </header>
      {value.description ? (
        <p className="mt-1 text-sm text-muted-foreground">{value.description}</p>
      ) : null}
    </article>
  );
}

export function AgentTemplateDetail({ value }: ObjectRendererSlotProps<AgentTemplateRecord>) {
  return (
    <section className="soft-panel rounded-card flex flex-col gap-3 p-6">
      <header className="flex items-center gap-3">
        <h2 className="text-2xl font-semibold">{value.name}</h2>
        {value.status ? <Badge>{value.status}</Badge> : null}
      </header>
      {value.description ? (
        <p className="text-sm text-muted-foreground">{value.description}</p>
      ) : null}
      {value.packageVersion || value.packageName ? (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          {value.packageName ? (
            <>
              <dt className="text-muted-foreground">Package</dt>
              <dd>{value.packageName}</dd>
            </>
          ) : null}
          {value.packageVersion ? (
            <>
              <dt className="text-muted-foreground">Version</dt>
              <dd>{value.packageVersion}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </section>
  );
}
