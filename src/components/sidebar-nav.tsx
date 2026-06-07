"use client";

import type { JSX } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type SidebarNavItem = {
  href: string;
  title: string;
  icon?: JSX.Element;
};

type SidebarNavProps = React.HTMLAttributes<HTMLElement> & {
  items: SidebarNavItem[];
};

export function SidebarNav({ className, items, ...props }: SidebarNavProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [val, setVal] = useState(pathname ?? items[0]?.href ?? "");

  const handleSelect = (href: string) => {
    setVal(href);
    router.push(href);
  };

  return (
    <>
      <div className="p-1 md:hidden">
        <Select value={val} onValueChange={handleSelect}>
          <SelectTrigger className="h-12 sm:w-48">
            <SelectValue placeholder="Section" />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.href} value={item.href}>
                <div className="flex gap-x-4 px-2 py-1">
                  {item.icon && <span className="scale-125">{item.icon}</span>}
                  <span className="text-md">{item.title}</span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <ScrollArea
        className="hidden w-full min-w-40 bg-background px-1 py-2 md:block"
      >
        <nav
          className={cn("flex gap-2 py-1 lg:flex-col lg:gap-1", className)}
          {...props}
        >
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                buttonVariants({ variant: "ghost" }),
                pathname === item.href ? "bg-muted hover:bg-accent" : "hover:bg-accent hover:underline",
                "justify-start",
              )}
            >
              {item.icon && <span className="me-2">{item.icon}</span>}
              {item.title}
            </Link>
          ))}
        </nav>
      </ScrollArea>
    </>
  );
}
