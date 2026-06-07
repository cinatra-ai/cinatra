"use client";

import { useEffect } from "react";

export function PageTitleSync({ title }: { title: string }) {
  useEffect(() => {
    document.title = `${title} | Cinatra`;
  }, [title]);

  return null;
}
