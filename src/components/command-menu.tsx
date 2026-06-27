"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, ChevronRight, Laptop, Moon, Sun } from "lucide-react";
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

const navGroups = [
  {
    heading: "Navigate",
    items: [
      { title: "Chat", href: "/chat" },
      { title: "Personal", href: "/personal" },
      { title: "Agents", href: "/agents" },
      { title: "New agent", href: "/chat" },
      { title: "Skills", href: "/skills" },
      { title: "Connectors", href: "/connectors" },
      { title: "Data — History", href: "/data-safety/change-sets" },
      { title: "Data — Merge", href: "/data-safety/merge-proposals" },
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

export function CommandMenu() {
  const router = useRouter();
  const { setTheme } = useTheme();
  const { open, setOpen } = useSearch();

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
          {navGroups.map((group) => (
            <CommandGroup key={group.heading} heading={group.heading}>
              {group.items.map((item) => (
                <CommandItem
                  key={item.href}
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
