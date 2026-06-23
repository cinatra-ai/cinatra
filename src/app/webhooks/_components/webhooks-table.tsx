import {
  GENERATED_WEBHOOK_REGISTRY_META,
  type GeneratedWebhookRegistryMeta,
} from "@/lib/generated/webhook-registry-meta";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * Derive the public inbound-webhook path prefix for a registry row. Mirrors the
 * GENERATED_WEBHOOK_PUBLIC_PREFIXES shape (`/webhook/<vendor>/<slug>/<hook>`)
 * but is derived from the meta row so this component imports ONLY the
 * import-free pure-data meta module (no second generated import, no loaders).
 */
export function webhookPublicPath(row: GeneratedWebhookRegistryMeta): string {
  return `/webhook/${row.vendor}/${row.slug}/${row.hook}`;
}

export function WebhooksTable({
  rows = GENERATED_WEBHOOK_REGISTRY_META,
}: {
  rows?: readonly GeneratedWebhookRegistryMeta[];
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-card border border-line bg-surface px-6 py-12 text-center">
        <p className="text-sm font-medium text-foreground">No webhooks registered yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Inbound webhooks declared by extensions (via <code>cinatra.webhooks</code>) appear
          here once an extension registers a hook.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-card border border-line bg-surface">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Vendor</TableHead>
            <TableHead>Package / Scope</TableHead>
            <TableHead>Hook</TableHead>
            <TableHead>URL</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={`${row.vendor}/${row.slug}/${row.hook}`}>
              <TableCell className="font-medium">{row.vendor}</TableCell>
              <TableCell className="text-muted-foreground">{row.scope}</TableCell>
              <TableCell>
                <span className="font-medium">{row.hook}</span>
                {row.label ? (
                  <span className="ml-2 text-muted-foreground">{row.label}</span>
                ) : null}
              </TableCell>
              <TableCell>
                <code className="text-xs text-muted-foreground">{webhookPublicPath(row)}</code>
              </TableCell>
              <TableCell className="text-muted-foreground">registered</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
