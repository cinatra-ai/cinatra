"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { toast } from "@/lib/cinatra-toast";

export type SearchParamToastConfig = {
  /** URL search-param name to watch (e.g. "deleted"). */
  param: string;
  /**
   * Required exact value for the param to fire (e.g. "1"). Omit to fire on any
   * non-empty value.
   */
  value?: string;
  /**
   * The toast text. MUST be a server-trusted static string — never the URL
   * param value itself — so attacker-controlled query text can't be reflected
   * into a toast.
   */
  message: string;
  /** Toast variant (defaults to "success"). */
  variant?: "success" | "error" | "info" | "warning";
};

// One-shot URL flash-message island. A mutating Server Action redirects to a
// destination with an outcome param (e.g. ?deleted=1); this reads it once,
// shows a STATIC toast, then strips the consumed param so a refresh / back-nav
// doesn't replay it.
//
// Why redirect + param instead of toasting in the form's own effect: a
// detail/edit page that calls notFound() after its row is deleted unmounts the
// form before a client useEffect can fire (the F1 race). The action redirects
// here instead, and this island owns the confirmation toast. See
// deletePersonalSkillAction in packages/skills.
//
// Modeled on src/app/setup/setup-toast.tsx: a handledKey ref guard makes
// StrictMode's double effect invocation toast once, and a stable toast id
// dedupes a re-fire if the component remounts before router.replace lands.
export function SearchParamToast({ toasts }: { toasts: SearchParamToastConfig[] }) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  // Reset to null when no configured param is present so the same outcome can
  // fire again on a later navigation.
  const handledKey = useRef<string | null>(null);

  useEffect(() => {
    const matched = toasts.filter((entry) => {
      const raw = searchParams.get(entry.param);
      if (raw === null) return false;
      return entry.value === undefined ? raw.length > 0 : raw === entry.value;
    });

    if (matched.length === 0) {
      handledKey.current = null;
      return;
    }

    const key = searchParams.toString();
    if (handledKey.current === key) return;
    handledKey.current = key;

    for (const entry of matched) {
      const variant = entry.variant ?? "success";
      toast[variant](entry.message, {
        id: `search-param-toast:${entry.param}:${entry.value ?? "*"}`,
      });
    }

    // Strip ONLY the consumed params; preserve anything else on the URL.
    const next = new URLSearchParams(searchParams.toString());
    for (const entry of matched) next.delete(entry.param);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [toasts, searchParams, pathname, router]);

  return null;
}
