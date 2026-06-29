import Link from "next/link";
import { WebhookIcon } from "lucide-react";

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
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Button } from "@/components/ui/button";

/**
 * Where the webhook-authoring guide lives. Inbound webhooks are
 * EXTENSION-AUTHORED (declared via `cinatra.webhooks` in an extension's
 * package.json) — there is no built-in form to register one from this page,
 * so the empty state points authors at the guide + the marketplace.
 */
const WEBHOOK_AUTHORING_DOCS_HREF =
  "https://github.com/cinatra-ai/cinatra/blob/main/docs/webhooks/authoring-inbound-webhooks.md";
const MARKETPLACE_HREF = "/configuration/marketplace";

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
      <Empty
        className="rounded-card border border-line bg-surface py-12"
        data-testid="webhooks-empty-state"
      >
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <WebhookIcon />
          </EmptyMedia>
          <EmptyTitle>No webhooks registered yet</EmptyTitle>
          <EmptyDescription>
            Inbound webhooks are <strong>provided by installed extensions</strong> that
            declare <code>cinatra.webhooks</code> in their <code>package.json</code> — you
            can&apos;t register one from this page. A hook appears here once such an
            extension is installed and the registry is regenerated. For example, an
            extension declaring a <code>post-published</code> hook is served at{" "}
            <code>/webhook/&lt;vendor&gt;/&lt;slug&gt;/post-published/&lt;bindingId&gt;</code>.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild>
            <Link
              href={WEBHOOK_AUTHORING_DOCS_HREF}
              target="_blank"
              rel="noopener noreferrer"
            >
              Learn how to author a webhook
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={MARKETPLACE_HREF}>Browse extensions</Link>
          </Button>
        </EmptyContent>
      </Empty>
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
