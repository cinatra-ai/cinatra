"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { toast } from "@/lib/cinatra-toast";

// Surfaces setup-wizard server-action outcomes as toasts. Wizard steps report
// failures by redirecting to `/setup/<step>?error=<msg>` (and successes via
// `?notice=<msg>`); the previous inline alert was easy to miss. This reads the
// param once per navigation, toasts it, then strips only the consumed params
// from the URL (preserving e.g. `stay=1`) so a refresh or back-nav doesn't
// replay a stale message. Mounted once in the setup layout so it covers every
// step.
export function SetupToast() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  // Tracks the last param snapshot we handled so React StrictMode's double
  // effect invocation toasts once. Reset to null when params clear so an
  // identical error on a subsequent submit fires again.
  const handledKey = useRef<string | null>(null);

  useEffect(() => {
    const error = searchParams.get("error");
    const notice = searchParams.get("notice");

    if (!error && !notice) {
      handledKey.current = null;
      return;
    }

    const key = searchParams.toString();
    if (handledKey.current === key) return;
    handledKey.current = key;

    // Stable id keyed on the message dedupes a double-fire if the component
    // remounts before the URL is cleaned (the ref guard resets on remount).
    if (error) toast.error(error, { id: `setup-error:${error}` });
    if (notice) toast.success(notice, { id: `setup-notice:${notice}` });

    // Strip ONLY the consumed params; preserve anything else on the URL.
    const next = new URLSearchParams(searchParams.toString());
    next.delete("error");
    next.delete("notice");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [searchParams, pathname, router]);

  return null;
}
