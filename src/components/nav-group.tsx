"use client";

import { type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";
import { type NavCollapsible, type NavItem, type NavLink, type NavGroup as NavGroupProps } from "@/components/layout-types";

export type { NavItem, NavLink, NavCollapsible, NavGroupProps };

function NavBadge({ children }: { children: ReactNode }) {
  return <Badge className="rounded-full px-1 py-0 text-xs">{children}</Badge>;
}

// A url is a "prefix match" of path when path equals it or is a sub-path of it
// at a path boundary. The trailing "/" anchors the boundary so "/agents" never
// matches "/agent...", and the root guard ("/" !== url) stops a root item from
// matching every route.
function isPrefixMatch(path: string, url: string | undefined): url is string {
  if (!url || url === "/") return path === url;
  return path === url || path.startsWith(url + "/");
}

/**
 * Whether `item` should render as the active sidebar entry for `href`.
 *
 * A top-level link is active when the current path is its section OR a sub-path
 * of it (prefix match at a path boundary) — this fixes parent highlighting on
 * nested routes (cinatra#581). `siblingUrls` carries the urls of the item's
 * peers so that, among OVERLAPPING links (e.g. "/data" and "/data/types", or
 * "/configuration" and "/configuration/approvals"), only the MOST SPECIFIC
 * (longest) matching url lights up — the parent no longer over-highlights when
 * a deeper sibling owns the route. An exact match always wins.
 */
export function checkIsActive(
  href: string,
  item: NavItem,
  mainNav = false,
  siblingUrls: string[] = [],
) {
  const path = href.split("?")[0];

  if (href === item.url || path === item.url) return true;

  // Group/collapsible: active when any of its children own the route — by url
  // prefix OR by an extra owned route a child claims via activePaths (#617), so
  // a collapsible parent (e.g. Analytics) opens + highlights on a child's
  // sibling tab routes too (e.g. /analytics/llm-usage, /analytics/api).
  if (
    item?.items?.some(
      (i) =>
        i.url === path ||
        path.startsWith(i.url + "/") ||
        i.activePaths?.some((p) => isPrefixMatch(path, p)),
    )
  ) {
    return true;
  }

  // Nested-route prefix match, suppressed when a more-specific sibling exists.
  if (isPrefixMatch(path, item.url)) {
    const url = item.url;
    const hasMoreSpecificSibling = siblingUrls.some(
      (sib) => sib.length > url.length && isPrefixMatch(path, sib),
    );
    if (!hasMoreSpecificSibling) return true;
  }

  // Extra owned routes (cinatra#617): an entry can claim sibling routes it owns
  // but that don't share its url prefix — e.g. the Analytics → LLM category
  // stays active on /analytics/llm-usage and /analytics/api. Matched at a path
  // boundary so nested sub-routes count too.
  if (
    "activePaths" in item &&
    item.activePaths?.some((p) => isPrefixMatch(path, p))
  ) {
    return true;
  }

  return (
    mainNav &&
    href.split("/")[1] !== "" &&
    href.split("/")[1] === item?.url?.split("/")[1]
  );
}

function SidebarMenuLink({
  item,
  href,
  siblingUrls,
}: {
  item: NavLink;
  href: string;
  siblingUrls: string[];
}) {
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={checkIsActive(href, item, false, siblingUrls)}
        tooltip={item.title}
      >
        <Link href={item.url} onClick={() => setOpenMobile(false)}>
          {item.icon && <item.icon />}
          <span>{item.title}</span>
          {item.badge && <NavBadge>{item.badge}</NavBadge>}
          {item.extra}
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function SidebarMenuCollapsible({ item, href }: { item: NavCollapsible; href: string }) {
  const { setOpenMobile } = useSidebar();
  const subUrls = item.items.map((i) => i.url);
  return (
    <Collapsible
      asChild
      defaultOpen={checkIsActive(href, item, true)}
      className="group/collapsible"
    >
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton tooltip={item.title}>
            {item.icon && <item.icon />}
            <span>{item.title}</span>
            {item.badge && <NavBadge>{item.badge}</NavBadge>}
            <ChevronRight className="ms-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90 rtl:rotate-180" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent className="CollapsibleContent">
          <SidebarMenuSub>
            {item.items.map((subItem) => (
              <SidebarMenuSubItem key={subItem.title}>
                <SidebarMenuSubButton
                  asChild
                  isActive={checkIsActive(href, subItem, false, subUrls)}
                >
                  <Link href={subItem.url} onClick={() => setOpenMobile(false)}>
                    {subItem.icon && <subItem.icon />}
                    <span>{subItem.title}</span>
                    {subItem.badge && <NavBadge>{subItem.badge}</NavBadge>}
                  </Link>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

function SidebarMenuCollapsedDropdown({ item, href }: { item: NavCollapsible; href: string }) {
  const subUrls = item.items.map((i) => i.url);
  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            tooltip={item.title}
            isActive={checkIsActive(href, item)}
          >
            {item.icon && <item.icon />}
            <span>{item.title}</span>
            {item.badge && <NavBadge>{item.badge}</NavBadge>}
            <ChevronRight className="ms-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" sideOffset={4}>
          <DropdownMenuLabel>
            {item.title} {item.badge ? `(${item.badge})` : ""}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {item.items.map((sub) => (
            <DropdownMenuItem key={`${sub.title}-${sub.url}`} asChild>
              <Link
                href={sub.url}
                className={checkIsActive(href, sub, false, subUrls) ? "bg-secondary" : ""}
              >
                {sub.icon && <sub.icon />}
                <span className="max-w-52 text-wrap">{sub.title}</span>
                {sub.badge && <span className="ms-auto text-xs">{sub.badge}</span>}
              </Link>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

export function NavGroup({ title, items, className }: NavGroupProps & { className?: string }) {
  const { state, isMobile } = useSidebar();
  const pathname = usePathname();

  // Urls of every leaf link in this group, so an overlapping pair (e.g.
  // "/configuration" + "/configuration/approvals") resolves to the most
  // specific match rather than lighting up both (cinatra#581).
  const leafUrls = items
    .filter((i): i is NavLink => !i.items && !!i.url)
    .map((i) => i.url);

  return (
    <SidebarGroup className={className}>
      {title && <SidebarGroupLabel>{title}</SidebarGroupLabel>}
      <SidebarMenu>
        {items.map((item) => {
          const key = `${item.title}-${item.url ?? ""}`;

          if (!item.items)
            return (
              <SidebarMenuLink
                key={key}
                item={item as NavLink}
                href={pathname}
                siblingUrls={leafUrls}
              />
            );

          if (state === "collapsed" && !isMobile)
            return <SidebarMenuCollapsedDropdown key={key} item={item as NavCollapsible} href={pathname} />;

          return <SidebarMenuCollapsible key={key} item={item as NavCollapsible} href={pathname} />;
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
}
