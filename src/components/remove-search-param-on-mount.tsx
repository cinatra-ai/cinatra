"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export function RemoveSearchParamOnMount({ param }: { param: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!searchParams.has(param)) {
      return;
    }

    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.delete(param);
    const nextQuery = nextParams.toString();
    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, { scroll: false });
  }, [param, pathname, router, searchParams]);

  return null;
}
