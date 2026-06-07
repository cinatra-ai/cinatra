"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { SkillForChip } from "./server-actions";

// ---------------------------------------------------------------------------
// HitlSkillChipsProps
// ---------------------------------------------------------------------------
type HitlSkillChipsProps = {
  skills: SkillForChip[];
};

// ---------------------------------------------------------------------------
// HitlSkillChips — chip row rendered inside HITL panels.
//
// Renders one Badge-like Button per skill. Clicking a chip sets
// `selectedSkill` state which opens a single Sheet at component root.
//
// CHIP-03: returns null when skills is empty — no empty containers.
// ---------------------------------------------------------------------------
export function HitlSkillChips({ skills }: HitlSkillChipsProps) {
  const [selectedSkill, setSelectedSkill] = useState<SkillForChip | null>(null);
  const [open, setOpen] = useState(false);

  if (skills.length === 0) return null;

  return (
    <>
      <Collapsible defaultOpen>
        <div className="flex items-center gap-2">
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1 text-muted-foreground hover:text-foreground rounded-chip"
            >
              <span className="text-xs font-medium">Skills ({skills.length})</span>
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <div className="flex flex-wrap gap-2 pt-2">
            {skills.map((skill) => (
              <Button
                key={skill.id}
                variant="outline"
                size="sm"
                className="rounded-chip text-xs gap-1.5"
                title={skill.description}
                onClick={() => {
                  setSelectedSkill(skill);
                  setOpen(true);
                }}
              >
                {skill.name}
              </Button>
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Single Sheet at component root — driven by selectedSkill state.
          By design: NOT Sheet-per-chip in the map above. */}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-[480px] sm:max-w-[480px] overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="text-foreground">
              {selectedSkill?.name ?? ""}
            </SheetTitle>
            <SheetDescription className="text-muted-foreground">
              {selectedSkill?.description ?? ""}
            </SheetDescription>
          </SheetHeader>
          {selectedSkill && (
            <div className="mt-4">
              <pre className="text-xs text-foreground whitespace-pre-wrap break-words font-mono bg-surface-muted rounded-panel p-4 max-h-[calc(100vh-12rem)] overflow-y-auto border border-line">
                {selectedSkill.content}
              </pre>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
