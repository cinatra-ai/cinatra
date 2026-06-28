"use client";

import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "lucide-react";
import type { RendererMode } from "../field-renderer-registry";

type CardListHint = {
  type: "card_list";
  title?: string;
  items: {
    title: string;
    description?: string;
    viewUrl?: string;
    fields?: Record<string, unknown>;
  }[];
};

export function CardListRenderer({ hint, mode = "view" }: { hint: CardListHint; mode?: RendererMode }) {
  void mode; // accepted but unused — edit-mode controls are not wired yet
  const title = hint.title ?? "Items";
  const items = hint.items ?? [];

  if (items.length === 0) {
    return (
      <section className="soft-panel rounded-card p-6 flex flex-col gap-4">
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        <p className="text-sm text-muted-foreground">No items to display.</p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {items.map((item, idx) => {
          const isExternal =
            typeof item.viewUrl === "string" && !item.viewUrl.startsWith("/");
          return (
            <Card key={idx} className="border-line bg-surface-strong">
              <CardHeader>
                <CardTitle className="text-sm font-semibold text-foreground">
                  {item.title}
                </CardTitle>
                {item.description ? (
                  <CardDescription className="text-sm text-muted-foreground">
                    {item.description}
                  </CardDescription>
                ) : null}
              </CardHeader>
              {item.viewUrl ? (
                <CardContent>
                  <Button asChild variant="link" size="sm" className="px-0">
                    <Link
                      href={item.viewUrl}
                      target={isExternal ? "_blank" : undefined}
                      rel={isExternal ? "noopener noreferrer" : undefined}
                    >
                      View
                      {isExternal ? (
                        <ExternalLink className="ml-1 h-3.5 w-3.5" />
                      ) : null}
                    </Link>
                  </Button>
                </CardContent>
              ) : null}
            </Card>
          );
        })}
      </div>
    </section>
  );
}
