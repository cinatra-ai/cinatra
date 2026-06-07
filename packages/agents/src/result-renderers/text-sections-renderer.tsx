"use client";

import { Separator } from "@/components/ui/separator";
import type { RendererMode } from "../field-renderer-registry";

type TextSectionsHint = {
  type: "text_sections";
  title?: string;
  sections: { heading: string; body: string }[];
};

export function TextSectionsRenderer({ hint, mode = "view" }: { hint: TextSectionsHint; mode?: RendererMode }) {
  void mode; // accepted but unused — edit-mode controls are not wired yet
  const title = hint.title ?? "Summary";
  const sections = hint.sections ?? [];

  if (sections.length === 0) {
    return (
      <section className="soft-panel rounded-panel p-6 flex flex-col gap-4">
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        <p className="text-sm text-muted-foreground">No sections to display.</p>
      </section>
    );
  }

  return (
    <section className="soft-panel rounded-panel p-6 flex flex-col gap-2">
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      {sections.map((section, idx) => (
        <div key={idx} className="flex flex-col gap-2 py-4">
          <h4 className="text-base font-semibold text-foreground">
            {section.heading}
          </h4>
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">
            {section.body}
          </p>
          {idx < sections.length - 1 ? <Separator /> : null}
        </div>
      ))}
    </section>
  );
}
