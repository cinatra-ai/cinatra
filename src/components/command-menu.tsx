"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Laptop, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useSearch } from "@/context/search-provider";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useViewerIsAdmin } from "@/components/crumb-epoch-context";
import { isConfigurationHref } from "@/lib/configuration-href";

/** Exported for tests: titles must be unique within each group (React keys). */
export const navGroups = [
  {
    heading: "Navigate",
    items: [
      { title: "Chat", href: "/chat" },
      { title: "Personal", href: "/personal" },
      { title: "Agents", href: "/agents" },
      // Same destination + mode flag the app-shell "Create agent" action uses.
      { title: "New agent", href: "/chat?mode=create-agent" },
      { title: "Skills", href: "/skills" },
      { title: "Connectors", href: "/connectors" },
      { title: "Artifacts — Restore objects", href: "/configuration/artifacts?tab=restore" },
      // Artifact change review lives on the shared artifact-review surface
      // (cinatra#1795); pending reviews are federated in Notifications.
      { title: "Artifacts — Change review", href: "/notifications" },
    ],
  },
  {
    heading: "Configuration",
    items: [
      { title: "AI Providers (LLM / API keys)", href: "/configuration/llm" },
      { title: "MCP Server", href: "/configuration/mcp" },
      { title: "Permissions", href: "/configuration/permissions" },
      { title: "Skills administration", href: "/configuration/skills" },
      { title: "Environment", href: "/configuration/environment" },
      { title: "Development", href: "/configuration/development" },
    ],
  },
];

/**
 * The nav groups this viewer may actually be offered (cinatra#2701, epic #2699).
 *
 * `/configuration` is admin-only end to end, so every command-menu entry that
 * points there is dropped for a non-admin — including the "Artifacts — Restore
 * objects" entry in the Navigate group, which the issue text's two examples
 * (`/configuration/llm`, `/configuration/development`) predate. A group left
 * with no items is dropped with them rather than rendering an empty heading.
 *
 * Pure and exported so the per-producer fixture can assert both directions
 * without mounting the dialog.
 */
export function navGroupsForViewer(viewerIsAdmin: boolean): typeof navGroups {
  if (viewerIsAdmin) return navGroups;
  return navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !isConfigurationHref(item.href)),
    }))
    .filter((group) => group.items.length > 0);
}

export function CommandMenu() {
  const router = useRouter();
  const { setTheme } = useTheme();
  const { open, setOpen } = useSearch();
  // Discoverability gate only — `/configuration` stays server-side admin-gated.
  const viewerIsAdmin = useViewerIsAdmin();
  const groups = React.useMemo(() => navGroupsForViewer(viewerIsAdmin), [viewerIsAdmin]);

  const runCommand = React.useCallback(
    (command: () => unknown) => {
      setOpen(false);
      command();
    },
    [setOpen],
  );

  return (
    <CommandDialog modal open={open} onOpenChange={setOpen}>
      <Command>
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <ScrollArea type="hover" className="h-72 pe-1">
          <CommandEmpty>No results found.</CommandEmpty>
          {groups.map((group) => (
            <CommandGroup key={group.heading} heading={group.heading}>
              {group.items.map((item) => (
                <CommandItem
                  key={item.title}
                  value={item.title}
                  onSelect={() => runCommand(() => router.push(item.href))}
                >
                  <div className="flex size-4 items-center justify-center">
                    <ArrowRight className="size-2 text-muted-foreground/80" />
                  </div>
                  {item.title}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
          <CommandSeparator />
          <CommandGroup heading="Theme">
            <CommandItem onSelect={() => runCommand(() => setTheme("light"))}>
              <Sun className="mr-2 h-4 w-4" />
              Light
            </CommandItem>
            <CommandItem onSelect={() => runCommand(() => setTheme("dark"))}>
              <Moon className="mr-2 h-4 w-4 scale-90" />
              Dark
            </CommandItem>
            <CommandItem onSelect={() => runCommand(() => setTheme("system"))}>
              <Laptop className="mr-2 h-4 w-4" />
              System
            </CommandItem>
          </CommandGroup>
        </ScrollArea>
      </CommandList>
      </Command>
    </CommandDialog>
  );
}
