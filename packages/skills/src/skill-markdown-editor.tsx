"use client";

import { useId, useState } from "react";
import { Label } from "@/components/ui/label";

function escapeHtml(input: string) {
  return input.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function highlightMarkdown(input: string) {
  return escapeHtml(input)
    .replace(/(^#{1,6}\s.*$)/gm, '<span class="text-info font-semibold">$1</span>')
    .replace(/(^```.*$)/gm, '<span class="text-primary">$1</span>')
    .replace(/(`[^`\n]+`)/g, '<span class="text-warning">$1</span>')
    .replace(/(\[[^\]]+\]\([^)]+\))/g, '<span class="text-success">$1</span>')
    .replace(/(^-\s.*$)/gm, '<span class="text-foreground">$1</span>')
    .replace(/(^\d+\.\s.*$)/gm, '<span class="text-foreground">$1</span>')
    .replace(/(\*\*[^*\n]+\*\*)/g, '<span class="font-semibold text-foreground">$1</span>');
}

type SkillMarkdownEditorProps = {
  name: string;
  defaultValue: string;
  label?: string;
  rows?: number;
};

export function SkillMarkdownEditor({ name, defaultValue, label = "Skill markdown", rows = 24 }: SkillMarkdownEditorProps) {
  const id = useId();
  const [value, setValue] = useState(defaultValue);

  return (
    <div className="grid gap-3">
      <Label htmlFor={id} className="text-sm font-semibold text-foreground">
        {label}
      </Label>
      <div className="relative overflow-hidden rounded-panel border border-line bg-surface-strong shadow-[0_20px_60px_rgba(15,23,42,0.08)]">
        <pre
          aria-hidden="true"
          className="pointer-events-none min-h-[32rem] whitespace-pre-wrap break-words px-5 py-4 font-mono text-sm leading-6 text-foreground"
          dangerouslySetInnerHTML={{ __html: highlightMarkdown(value || "") + "\n" }}
        />
        {/* audit-allow: inline-typography-input — overlay textarea paired with backdrop highlighter; shadcn Textarea defaults (border/rounded/shadow) would clash with the absolute-positioned overlay */}
        <textarea
          id={id}
          name={name}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          rows={rows}
          spellCheck={false}
          // The overlay must stay transparent so the highlighted <pre> backdrop
          // shows through. The global `.cinatra textarea:not(...)` rule
          // (globals.css) forces an opaque var(--surface-strong) background and
          // out-specifies Tailwind's `bg-transparent`, blanking the field (#497).
          // An inline background-color beats any stylesheet selector — smallest
          // blast radius — so keep the overlay see-through.
          style={{ backgroundColor: "transparent" }}
          className="absolute inset-0 min-h-[32rem] w-full resize-y bg-transparent px-5 py-4 font-mono text-sm leading-6 text-transparent caret-foreground outline-none selection:bg-accent-soft"
        />
      </div>
      <p className="text-xs text-muted-foreground">Markdown syntax highlighting is shown in the editor backdrop while you edit.</p>
    </div>
  );
}
