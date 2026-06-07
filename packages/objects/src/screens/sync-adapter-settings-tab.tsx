import "server-only";
import { Badge } from "@/components/ui/badge";
import { objectSyncAdapterRegistry } from "../sync-adapters/registry";
import { readAllObjectSyncAdapterConfigs } from "../sync-adapters/config-store";

// Object-sync adapters are distinct from transport "connector" packages.
// They provide outbound mirrors to external CRMs/CMSs for a given object type.
export async function SyncAdapterSettingsTab({ objectType }: { objectType: string }) {
  const registered = objectSyncAdapterRegistry.getAdaptersForType(objectType);
  const configs = await readAllObjectSyncAdapterConfigs(objectType);

  if (registered.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-8 text-center">
        <p className="text-base font-semibold text-foreground">No sync adapters registered for this type.</p>
        <p className="text-sm text-muted-foreground">
          Sync-adapter packages register adapters at startup. No package has registered an adapter for {objectType}.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {registered.map((adapter) => {
        const cfg = configs.find((c) => c.adapterId === adapter.id);
        return (
          <div key={adapter.id} className="soft-panel rounded-control px-4 py-3 flex items-center justify-between">
            <div className="flex flex-col gap-1">
              <p className="text-sm font-semibold text-foreground">{adapter.displayName}</p>
              <p className="text-xs text-muted-foreground">{adapter.targetSystem}</p>
            </div>
            {cfg?.isActive ? (
              <Badge variant="secondary" className="border-success/30 bg-success/10 text-success">Enabled</Badge>
            ) : (
              <Badge variant="secondary">Disabled</Badge>
            )}
          </div>
        );
      })}
    </div>
  );
}
