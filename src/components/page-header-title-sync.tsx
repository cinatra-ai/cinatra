"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * Broadcasts the current page's <PageHeader> title to the AppShell so the
 * breadcrumb's leaf crumb can read the exact page title (e.g. "Upload
 * Extension") instead of a humanized path segment ("Upload"). Mounted by
 * PageHeader; the AppShell listens for `cinatra:page:title`.
 *
 * The dispatch is deferred to the next animation frame: React runs child
 * effects BEFORE parent effects, so a synchronous dispatch here would fire
 * before the AppShell's listener attaches and get missed. The rAF lands
 * after the parent's mount effect. Mirrors the chat-thread / agent-name
 * title-broadcast pattern.
 */
export function PageHeaderTitleSync({ title }: { title: string }) {
  const pathname = usePathname();
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      window.dispatchEvent(
        new CustomEvent("cinatra:page:title", { detail: { title, pathname } }),
      );
    });
    return () => {
      cancelAnimationFrame(id);
      window.dispatchEvent(
        new CustomEvent("cinatra:page:title", { detail: { title: null, pathname } }),
      );
    };
  }, [title, pathname]);
  return null;
}
