import "server-only";
import Link from "next/link";
import { History } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SyncAdapterSettingsTab } from "./sync-adapter-settings-tab";

export type ObjectDrawerRow = {
  id: string;
  type: string;
  name: string;
  data: Record<string, unknown>;
  classificationConfidence: number | null;
  actor: { agentId: string | null; runId: string | null; source: string | null; userId: string | null };
};

export async function ObjectDetailDrawer({ object, onCloseHref }: { object: ObjectDrawerRow; onCloseHref: string }) {
  return (
    <Sheet open>
      <SheetContent side="right" className="w-full max-w-xl sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <span className="truncate">{object.name}</span>
          </SheetTitle>
          <SheetDescription>
            <span className="font-mono text-xs text-muted-foreground">{object.type}</span>
          </SheetDescription>
        </SheetHeader>

        <Tabs defaultValue="details" className="mt-6">
          <TabsList>
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="connectors">Connectors</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>

          <TabsContent value="details" className="mt-4 flex flex-col gap-4">
            <section>
              <h3 className="text-sm font-semibold text-foreground">Classification</h3>
              <p className="text-sm text-muted-foreground">
                Confidence:{" "}
                {object.classificationConfidence == null
                  ? "dynamic"
                  : `${Math.round(object.classificationConfidence * 100)}%`}
              </p>
            </section>
            <Separator />
            <section>
              <h3 className="text-sm font-semibold text-foreground">Actor context</h3>
              <dl className="grid grid-cols-2 gap-y-2 text-sm text-muted-foreground">
                <dt className="font-semibold text-foreground">Agent</dt>
                <dd>{object.actor.agentId ?? "—"}</dd>
                <dt className="font-semibold text-foreground">Run</dt>
                <dd>{object.actor.runId ?? "—"}</dd>
                <dt className="font-semibold text-foreground">Source</dt>
                <dd>{object.actor.source ?? "—"}</dd>
                <dt className="font-semibold text-foreground">User</dt>
                <dd>{object.actor.userId ?? "—"}</dd>
              </dl>
            </section>
            <Separator />
            <section>
              <h3 className="text-sm font-semibold text-foreground">Raw data</h3>
              <pre className="soft-panel rounded-control px-4 py-3 text-xs text-foreground overflow-auto max-h-80">
                {JSON.stringify(object.data, null, 2)}
              </pre>
            </section>
          </TabsContent>

          <TabsContent value="connectors" className="mt-4">
            <SyncAdapterSettingsTab objectType={object.type} />
          </TabsContent>

          <TabsContent value="history" className="mt-4">
            <div className="flex flex-col items-start gap-3 py-2">
              <p className="text-sm text-muted-foreground">
                History lives on the canonical data detail page. Open it to see
                every captured change-set, restore prior versions, and undo
                recent actions.
              </p>
              <Button asChild variant="outline" size="sm">
                <Link href={`/data/${object.id}?focus=history`}>
                  <History data-icon="inline-start" />
                  Open full history
                </Link>
              </Button>
            </div>
          </TabsContent>
        </Tabs>

        <div className="mt-6">
          <Button asChild variant="ghost" size="sm">
            <Link href={onCloseHref}>Close</Link>
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
