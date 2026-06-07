"use client";

import { QueueDashApp } from "@queuedash/ui";
import { createRoot, type Root } from "react-dom/client";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";

type QueueDashClientProps = {
  embedded?: boolean;
  basename?: string;
};

export function QueueDashClient({
  embedded = false,
  basename = "/configuration/environment",
}: QueueDashClientProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<Root | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const shadowRoot = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    shadowRoot.replaceChildren();

    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = "/api/admin/operations/jobs/styles";
    shadowRoot.appendChild(stylesheet);

    const viewport = document.createElement("div");
    viewport.style.minHeight = "720px";
    viewport.style.width = "100%";
    viewport.style.overflow = "visible";
    viewport.style.boxSizing = "border-box";
    shadowRoot.appendChild(viewport);

    const root = createRoot(viewport);
    rootRef.current = root;
    root.render(<QueueDashApp apiUrl="/api/admin/operations/jobs" basename={basename} />);
    setMounted(true);

    return () => {
      rootRef.current = null;
      window.setTimeout(() => {
        root.unmount();
      }, 0);
    };
  }, [basename]);

  const content = (
    <>
      {!mounted && !embedded ? (
        <>
          <PageHeader
            label="Operations"
            title="Loading jobs"
            description="Preparing the standalone QueueDash window."
          />
          <PageContent className="flex flex-col gap-6 pb-8">
            <div aria-hidden className="min-h-[1px]" />
          </PageContent>
        </>
      ) : null}
      <div
        ref={hostRef}
        className={cn(mounted ? "block" : "hidden", embedded ? "min-h-[720px] w-full overflow-visible" : "h-screen w-full")}
      />
    </>
  );

  if (embedded) {
    return content;
  }

  return (
    <Main className="min-h-screen">
      {content}
    </Main>
  );
}
