"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Check, Pencil } from "lucide-react";
import { Button } from "./ui/button";

export type InlinePageTitleProps = {
  /** Current saved value. Empty string falls back to `placeholder`. */
  value: string;
  /** Shown when value is empty. Also used as the initial edit value when no custom name is set. */
  placeholder: string;
  /** Called when the user commits an edit (Enter, blur, or save icon click). */
  onCommit: (newValue: string) => void;
};

export type InlinePageTitleHandle = {
  /** Programmatically enter edit mode (e.g. after a duplicate-name validation error). */
  enterEdit: () => void;
};

/**
 * An h1 page title that can be edited inline.
 *
 * - Click the pencil icon or double-click the title to enter edit mode.
 * - In edit mode a card appears around the text at the same position and font size.
 *   The card grows with the text; when it would exceed the available width it caps
 *   and the input scrolls the overflow without a visible scrollbar.
 * - Pencil icon becomes a save (check) icon while editing.
 * - Enter or blur commits; Escape cancels.
 */
export const InlinePageTitle = forwardRef<InlinePageTitleHandle, InlinePageTitleProps>(
  function InlinePageTitle({ value, placeholder, onCommit }, ref) {
    const [isEditing, setIsEditing] = useState(false);
    const [editValue, setEditValue] = useState(value);
    const inputRef = useRef<HTMLInputElement>(null);

    useImperativeHandle(ref, () => ({
      enterEdit() {
        setEditValue(value || placeholder);
        setIsEditing(true);
      },
    }));

    useEffect(() => {
      if (!isEditing) {
        setEditValue(value);
      }
    }, [value, isEditing]);

    function enterEdit() {
      setEditValue(value || placeholder);
      setIsEditing(true);
    }

    function commit() {
      const trimmed = editValue.trim();
      setIsEditing(false);
      onCommit(trimmed);
    }

    function cancel() {
      setEditValue(value);
      setIsEditing(false);
    }

    useEffect(() => {
      if (isEditing && inputRef.current) {
        const el = inputRef.current;
        el.focus();
        const len = el.value.length;
        el.setSelectionRange(len, len);
      }
    }, [isEditing]);

    const displayValue = value || placeholder;
    // Non-breaking space keeps the sizer span at minimum height when empty
    const sizerText = editValue || " ";

    if (isEditing) {
      return (
        <div className="flex items-center gap-2 min-w-0 max-w-full">
          {/*
            Card auto-sizes to the title text via a hidden sizer span.
            The span (same font) drives the card's width.
            max-w-full caps the card at the available line width;
            overflow-hidden clips the span when at max, and the input
            (filling the card via absolute inset-0) scrolls text natively.
          */}
          <div className="relative inline-block max-w-full overflow-hidden rounded-lg border border-line bg-surface">
            {/* Invisible sizer — identical font styles drive card width */}
            <span
              aria-hidden
              className="block invisible whitespace-pre select-none pointer-events-none px-3 py-1 text-[2rem] font-semibold tracking-[-0.03em]"
            >
              {sizerText}
            </span>
            {/* Input absolutely fills the card; browser handles text scroll without a visible scrollbar */}
            {/* audit-allow: inline-typography-input — typography-styled inline editor; shadcn Input would override every default style */}
            <input
              ref={inputRef}
              className="absolute inset-0 w-full px-3 py-1 bg-transparent text-[2rem] font-semibold tracking-[-0.03em] text-foreground outline-none overflow-x-hidden"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); commit(); }
                else if (e.key === "Escape") { e.preventDefault(); cancel(); }
              }}
              onBlur={commit}
              suppressHydrationWarning
            />
          </div>
          {/* Save icon — onMouseDown prevents input blur before click fires */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Save name"
            className="shrink-0 cursor-pointer h-auto w-auto p-0 hover:bg-transparent"
            onMouseDown={(e) => e.preventDefault()}
            onClick={commit}
          >
            <Check className="h-4 w-4 text-muted-foreground" />
          </Button>
        </div>
      );
    }

    return (
      <div
        className="flex items-center gap-2 min-w-0 cursor-text"
        onDoubleClick={enterEdit}
      >
        <h1 className="text-[2rem] font-semibold tracking-[-0.03em] text-foreground truncate">
          {displayValue}
        </h1>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Edit name"
          className="shrink-0 cursor-pointer h-auto w-auto p-0 hover:bg-transparent"
          onClick={(e) => {
            e.stopPropagation();
            enterEdit();
          }}
        >
          <Pencil className="h-4 w-4 text-muted-foreground" />
        </Button>
      </div>
    );
  }
);
