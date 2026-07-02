"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Plus, Paperclip } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Label } from "./ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { cn } from "./lib/utils";
import { LoadingSpinner } from "./loading-spinner";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PromptFieldHandle = {
  /** Clears the current value and removes it from localStorage. */
  clear: () => void;
  /**
   * Seeds the editor with `text` programmatically (badge prefills, @-mention
   * seeds, workflow handoffs). This is a seed, not a saved draft, so it is
   * deliberately NOT persisted to localStorage — only genuine user input
   * (typed into the editor) is persisted. This keeps a fresh mount empty
   * unless the user actually authored a draft.
   */
  setValue: (text: string) => void;
  /** Focuses the editor. */
  focus: () => void;
};

export type PromptFieldAutosave = {
  /** Whether autosave is currently enabled for this field. */
  enabled: boolean;
  /** Whether the user can toggle it (vs. read-only indicator). */
  canToggle: boolean;
  /** Called when the user toggles the autosave switch. */
  onToggle?: (enabled: boolean) => void;
};

export type Mentionable = {
  id: string;
  /** ASCII handle used in @-mentions, e.g. "peer_hartleben" (GitLab/GitHub convention). */
  handle: string;
  /** Display name as stored in Better Auth, e.g. "Peer Hartleben". */
  displayName: string;
  type?: "assistant" | "user";
  image?: string | null;
};

export type PromptFieldProps = {
  /** Label text rendered above the editor. Omit to suppress the label row. */
  label?: string;
  placeholder?: string;
  /** Number of rows (minimum height). Ignored when `minHeight` is set. Default: 1. */
  rows?: number;
  /** CSS min-height value (e.g. "8rem"). When set, overrides `rows`. */
  minHeight?: string;
  /** Value seeded into the editor if nothing is stored under `storageKey`. */
  defaultValue?: string;
  /**
   * Optional predicate evaluated once at mount against the value stored under
   * `storageKey`. Return true to DISCARD that stored value (it is removed from
   * localStorage and the editor falls back to `defaultValue`) instead of
   * restoring it. Used to evict programmatic seeds that an older build
   * persisted. Keep it pure and exact-match so genuine drafts are preserved.
   */
  shouldDiscardStoredValue?: (stored: string) => boolean;
  /**
   * localStorage key. User-authored input typed into the editor is persisted
   * here so unsubmitted drafts survive navigation. Programmatic seeds applied
   * via the `setValue` handle are NOT persisted (see
   * `PromptFieldHandle.setValue`).
   */
  storageKey: string;
  /**
   * Optional data-testid placed on the contenteditable editor div. Used by
   * e2e tests to target the chat prompt deterministically. Omitted by
   * default — no DOM change in prod.
   */
  editorTestId?: string;

  /**
   * Called when the user submits. Receives the current text value
   * (mention chips are serialized as @handle).
   */
  onSubmit: (value: string) => void;
  submitAriaLabel?: string;
  /**
   * Called whenever the editor value changes.
   * Does NOT fire during the localStorage hydration effect.
   */
  onChange?: (value: string) => void;
  /**
   * When false, the submit button is disabled while the editor is empty.
   * Default: true.
   */
  canSubmitEmpty?: boolean;

  /** Called when the user clicks the stop button while `pending` is true. */
  onStop?: () => void;
  stopAriaLabel?: string;

  /** When true, shows the stop-square icon and disables the editor. */
  pending?: boolean;
  disabled?: boolean;

  /** Text rendered below the editor. */
  statusMessage?: string;
  /**
   * Controls whether the status message area below the editor can appear.
   * Default: true.
   */
  showStatusMessage?: boolean;

  /**
   * When provided, shows a Skill autosave row inside the Plus-icon flyout.
   * The flyout also surfaces if `onAttachmentsSelected` is set (the "Upload
   * files" row lives in the same menu).
   */
  autosave?: PromptFieldAutosave;

  /** Extra CSS classes appended to the field container (the bordered box). */
  fieldClassName?: string;

  /**
   * Entities that can be @-mentioned. When provided and non-empty,
   * typing '@' at a word boundary opens a flyout. Selecting an entry inserts
   * an inline chip showing the user's avatar and display name; the underlying
   * text value uses the ASCII handle (@handle).
   */
  mentionables?: ReadonlyArray<Mentionable>;
  /**
   * Prop-gated attachment picker. When this callback is provided, the
   * Plus-icon flyout renders an "Upload files" row that opens a native
   * file picker; selected File objects are forwarded to the consumer
   * (which uploads them via /api/artifacts/upload and tracks the
   * resulting refs in its own state). Consumers that do NOT pass this
   * prop see no upload row.
   *
   * The Plus flyout consolidates "things you can add to a prompt" behind
   * a single trigger.
   */
  onAttachmentsSelected?: (files: File[]) => void;
};

const MAX_AUTO_HEIGHT_PX = 240;
const LINE_HEIGHT_PX = 24; // leading-6 = 1.5rem = 24px
const PADDING_Y_PX = 24;   // py-3 = 0.75rem top + 0.75rem bottom

// ---------------------------------------------------------------------------
// Contenteditable DOM helpers (imperative — React does not manage content)
// ---------------------------------------------------------------------------

/** Serialize editor DOM → plain text. Mention chip spans → @handle. */
function serializeEditor(el: HTMLElement): string {
  let text = "";
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? "";
    } else if (node instanceof HTMLElement) {
      const handle = node.dataset.mentionHandle;
      if (handle) {
        text += `@${handle}`;
      } else if (node.tagName === "BR") {
        text += "\n";
      } else if (node.tagName === "DIV" || node.tagName === "P") {
        // Browsers wrap new lines in block elements in some contenteditable modes
        text += "\n" + serializeEditor(node);
      } else {
        text += serializeEditor(node);
      }
    }
  }
  return text;
}

/** Get serialized text before the caret inside a contenteditable element. */
function getTextBeforeCaret(el: HTMLElement): string {
  if (typeof window === "undefined") return "";
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return "";
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return "";
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString();
}

/**
 * Find an active @-mention token at the end of `textBefore`.
 * Returns the query string (text after @, may contain spaces for multi-word names) or null.
 * @ must be preceded by whitespace, comma, or start of string.
 */
function detectMentionToken(textBefore: string): string | null {
  // Normalize NBSP → regular space (contenteditable inserts NBSP to prevent whitespace collapsing).
  const normalized = textBefore.replace(/\u00a0/g, " ");
  const match = normalized.match(/(?:^|[\s,])@([a-zA-Z0-9_.][a-zA-Z0-9_. -]*)?$/);
  if (!match) return null;
  return match[1] ?? "";
}

/** Create a mention chip span (contenteditable=false). */
function createChipElement(m: Mentionable): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.mentionHandle = m.handle;
  chip.className =
    "mention-chip inline-flex items-center gap-1 " +
    "bg-surface-muted border border-line rounded-full pl-0.5 pr-1.5 py-0.5 " +
    "text-xs leading-none select-none cursor-default mx-1";
  // Explicit style keeps the chip vertically centered without inflating the line height.
  chip.style.cssText = "vertical-align: middle; line-height: 0;";

  // Avatar circle
  const av = document.createElement("span");
  av.className =
    "size-[1.1rem] rounded-full overflow-hidden inline-flex shrink-0 " +
    "items-center justify-center bg-muted text-muted-foreground text-[8px] font-semibold";
  if (m.image) {
    const img = document.createElement("img");
    img.src = m.image;
    img.alt = "";
    img.className = "size-full object-cover";
    av.appendChild(img);
  } else {
    av.textContent = m.displayName.charAt(0).toUpperCase();
  }
  chip.appendChild(av);

  const label = document.createElement("span");
  label.textContent = m.displayName;
  chip.appendChild(label);

  return chip;
}

/**
 * Set editor DOM from plain text.
 * Known @handle patterns are replaced with chip elements.
 * Called imperatively — not via React rendering.
 */
function setEditorContent(
  el: HTMLDivElement,
  text: string,
  mentionables: ReadonlyArray<Mentionable>,
): void {
  el.innerHTML = "";
  if (!text) return;

  const handleMap = new Map(mentionables.map((m) => [m.handle, m]));
  const parts = text.split(/(@[a-zA-Z0-9_.\-]+)/g);

  for (const part of parts) {
    if (part.startsWith("@")) {
      const handle = part.slice(1);
      const m = handleMap.get(handle);
      if (m) {
        el.appendChild(createChipElement(m));
        continue;
      }
    }
    if (part) {
      const lines = part.split("\n");
      lines.forEach((line, i) => {
        if (i > 0) el.appendChild(document.createElement("br"));
        if (line) el.appendChild(document.createTextNode(line));
      });
    }
  }
}

// ---------------------------------------------------------------------------
// AttachmentMenu sub-component
// ---------------------------------------------------------------------------

type AttachmentMenuProps = {
  autosave?: PromptFieldAutosave;
  /** When provided, renders an "Upload files" row that calls this on click. */
  onUploadClick?: () => void;
  /** Disables the upload row (e.g. while a submission is pending). */
  uploadDisabled?: boolean;
};

function AttachmentMenu({ autosave, onUploadClick, uploadDisabled = false }: AttachmentMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* The prompt field intentionally omits the ghost-button background;
            the leading reset block strips the <Button> ghost/icon chrome
            (rounding, border, the ghost hover AND aria-expanded background +
            foreground recolor) so the trigger stays chrome-less and flush.
            State color uses semantic tokens: hover/focus/open all resolve to
            text-primary (data-[state=open] + aria-expanded both come from the
            radix trigger). */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Prompt options"
          className={cn(
            "rounded-none border-0 shadow-none hover:bg-transparent aria-expanded:bg-transparent",
            "flex items-center justify-center bg-transparent outline-none transition",
            "text-muted-foreground hover:text-primary focus-visible:text-primary aria-expanded:text-primary data-[state=open]:text-primary",
          )}
        >
          <Plus className="size-4" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent side="top" align="start" alignOffset={-8} sideOffset={12} className="w-56">
        <DropdownMenuGroup>
          {onUploadClick && (
            <DropdownMenuItem onSelect={() => onUploadClick()} disabled={uploadDisabled}>
              <Paperclip />
              Upload files
            </DropdownMenuItem>
          )}
          {autosave && (
            <DropdownMenuCheckboxItem
              checked={autosave.enabled}
              onCheckedChange={(checked) => autosave.onToggle?.(checked === true)}
              onSelect={(e) => e.preventDefault()}
              disabled={!autosave.canToggle || !autosave.onToggle}
              className="pr-1.5 [&_[data-slot='dropdown-menu-checkbox-item-indicator']]:hidden"
            >
              <Checkbox
                checked={autosave.enabled}
                tabIndex={-1}
                aria-hidden="true"
                className="size-4 shrink-0 rounded-[4px] border-line bg-surface shadow-none data-[state=checked]:border-primary data-[state=checked]:bg-primary [&_svg]:text-primary-foreground!"
              />
              Skills autosave
            </DropdownMenuCheckboxItem>
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// PromptField
// ---------------------------------------------------------------------------

export const PromptField = forwardRef<PromptFieldHandle, PromptFieldProps>(function PromptField(
  {
    label,
    placeholder,
    rows = 1,
    minHeight,
    defaultValue = "",
    shouldDiscardStoredValue,
    storageKey,
    editorTestId,
    onSubmit,
    onChange,
    submitAriaLabel = "Submit prompt",
    canSubmitEmpty = false,
    onStop,
    stopAriaLabel = "Stop",
    pending = false,
    disabled = false,
    statusMessage,
    showStatusMessage = true,
    autosave,
    fieldClassName,
    mentionables,
    onAttachmentsSelected,
  },
  ref,
) {
  const editorRef = useRef<HTMLDivElement>(null);
  const mentionListRef = useRef<HTMLUListElement>(null);
  // Hidden file input ref for the prop-gated attachment picker.
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Uncontrolled: valueRef is the source of truth; no React state for content.
  const valueRef = useRef<string>(defaultValue);
  const [isEmpty, setIsEmpty] = useState(defaultValue.trim().length === 0);
  const [mounted, setMounted] = useState(false);

  // ---------------------------------------------------------------------------
  // @-mention state
  // ---------------------------------------------------------------------------
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionHighlight, setMentionHighlight] = useState(0);

  // ---------------------------------------------------------------------------
  // Hydrate from localStorage on mount
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const stored = window.localStorage.getItem(storageKey);
    // Evict a stored value the consumer rejects (e.g. a programmatic seed that
    // an older build persisted) before it can hydrate the editor.
    const discardStored = stored !== null && (shouldDiscardStoredValue?.(stored) ?? false);
    if (discardStored) window.localStorage.removeItem(storageKey);
    const text = stored !== null && !discardStored ? stored : defaultValue;
    valueRef.current = text;
    setEditorContent(el, text, mentionables ?? []);
    setIsEmpty(text.trim().length === 0);
    setMounted(true);
    // intentionally excludes mentionables (may not be loaded yet) and
    // shouldDiscardStoredValue (a pure predicate read once on mount)
  }, [storageKey]);

  // When mentionables first become available, re-render stored @handle text as chips.
  const mentionablesRenderedRef = useRef(false);
  useEffect(() => {
    if (!mentionables || mentionables.length === 0) return;
    if (!mounted) return;
    if (mentionablesRenderedRef.current) return;
    mentionablesRenderedRef.current = true;
    const el = editorRef.current;
    if (!el || !valueRef.current.includes("@")) return;
    const hadFocus = el === document.activeElement;
    setEditorContent(el, valueRef.current, mentionables);
    if (hadFocus) {
      el.focus();
      // Re-rendering chips replaces text nodes — place caret at end so it
      // lands after the chip(s) rather than at the start of the element.
      requestAnimationFrame(() => {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      });
    }
  }, [mentionables, mounted]);

  // Persist to localStorage after hydration
  const persistValue = useCallback(
    (text: string) => {
      if (!mounted) return;
      window.localStorage.setItem(storageKey, text);
    },
    [storageKey, mounted],
  );

  // ---------------------------------------------------------------------------
  // Imperative handle
  // ---------------------------------------------------------------------------
  useImperativeHandle(
    ref,
    () => ({
      clear() {
        const el = editorRef.current;
        if (el) el.innerHTML = "";
        valueRef.current = "";
        setIsEmpty(true);
        onChange?.("");
        if (typeof window !== "undefined") window.localStorage.removeItem(storageKey);
      },
      setValue(text: string) {
        const el = editorRef.current;
        if (el) {
          setEditorContent(el, text, mentionables ?? []);
          // Focus first so the element owns the selection, then defer caret
          // placement to the next animation frame — calling focus() after
          // addRange() would reset the browser's selection.
          el.focus();
          requestAnimationFrame(() => {
            const range = document.createRange();
            range.selectNodeContents(el);
            range.collapse(false);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
          });
        }
        valueRef.current = text;
        setIsEmpty(text.trim().length === 0);
        onChange?.(text);
        // Intentionally NOT persisted: setValue seeds the editor (badge
        // prefill, @-mention, workflow handoff). Persisting a seed makes it
        // survive reloads and reappear on a fresh mount. Only user-typed
        // input (handleInput) is persisted as a draft.
      },
      focus() {
        editorRef.current?.focus();
      },
    }),
    [storageKey, onChange, mentionables],
  );

  // ---------------------------------------------------------------------------
  // Filtered mentionables
  // ---------------------------------------------------------------------------
  const filteredMentionables = useMemo(() => {
    if (!mentionables || mentionables.length === 0) return [];
    if (!mentionOpen) return [];
    const q = mentionQuery.toLowerCase().trim();
    if (!q) return mentionables as Mentionable[];
    return (mentionables as Mentionable[])
      .filter(
        (m) =>
          m.handle.toLowerCase().includes(q) ||
          m.displayName.toLowerCase().includes(q),
      )
      .sort((a, b) => {
        const aPrefix =
          a.handle.toLowerCase().startsWith(q) || a.displayName.toLowerCase().startsWith(q) ? 0 : 1;
        const bPrefix =
          b.handle.toLowerCase().startsWith(q) || b.displayName.toLowerCase().startsWith(q) ? 0 : 1;
        if (aPrefix !== bPrefix) return aPrefix - bPrefix;
        return a.displayName.localeCompare(b.displayName);
      });
  }, [mentionables, mentionOpen, mentionQuery]);

  useEffect(() => {
    if (filteredMentionables.length > 0) {
      setMentionHighlight((h) => Math.min(h, filteredMentionables.length - 1));
    }
  }, [filteredMentionables.length]);

  // Scroll highlighted item into view whenever the selection moves.
  useEffect(() => {
    const list = mentionListRef.current;
    if (!list) return;
    const item = list.children[mentionHighlight] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [mentionHighlight]);

  // ---------------------------------------------------------------------------
  // Recompute mention state from caret position
  // ---------------------------------------------------------------------------
  const recomputeMentionState = useCallback(() => {
    const el = editorRef.current;
    if (!el || !mentionables || mentionables.length === 0) return;
    const textBefore = getTextBeforeCaret(el);
    const query = detectMentionToken(textBefore);
    if (query !== null) {
      setMentionQuery(query);
      setMentionHighlight(0);
      setMentionOpen(true);
    } else {
      setMentionOpen(false);
    }
  }, [mentionables]);

  // ---------------------------------------------------------------------------
  // Insert mention chip at caret
  // ---------------------------------------------------------------------------
  const insertMention = useCallback(
    (m: Mentionable) => {
      const el = editorRef.current;
      if (!el) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);

      if (range.startContainer.nodeType === Node.TEXT_NODE) {
        const textNode = range.startContainer as Text;
        const caretOffset = range.startOffset;
        // atOffset: position of the @ character in this text node
        const atOffset = caretOffset - mentionQuery.length - 1;
        if (atOffset >= 0) {
          const replaceRange = document.createRange();
          replaceRange.setStart(textNode, atOffset);
          replaceRange.setEnd(textNode, caretOffset);
          replaceRange.deleteContents();

          const chip = createChipElement(m);
          const space = document.createTextNode(" ");
          const frag = document.createDocumentFragment();
          frag.appendChild(chip);
          frag.appendChild(space);
          replaceRange.insertNode(frag);

          // Move caret after the space
          const finalRange = document.createRange();
          finalRange.setStartAfter(space);
          finalRange.collapse(true);
          sel.removeAllRanges();
          sel.addRange(finalRange);
        }
      } else {
        // Fallback: append chip at end (shouldn't happen in normal flow)
        el.appendChild(createChipElement(m));
        el.appendChild(document.createTextNode(" "));
      }

      const newText = serializeEditor(el);
      valueRef.current = newText;
      persistValue(newText);
      onChange?.(newText);
      setIsEmpty(newText.trim().length === 0);
      setMentionOpen(false);
      setMentionQuery("");
    },
    [mentionQuery, onChange, persistValue],
  );

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------
  const isDisabled = disabled || pending;
  const canSubmit = canSubmitEmpty || !isEmpty;

  function handleSubmit() {
    if (pending) {
      onStop?.();
    } else if (canSubmit) {
      onSubmit(valueRef.current);
    }
  }

  function handleInput() {
    const el = editorRef.current;
    if (!el) return;
    const text = serializeEditor(el);
    valueRef.current = text;
    persistValue(text);
    onChange?.(text);
    setIsEmpty(text.trim().length === 0);
    recomputeMentionState();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    // @-mention flyout keyboard navigation — intercept before submit logic
    if (mentionOpen && filteredMentionables.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionHighlight((h) => (h + 1) % filteredMentionables.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionHighlight((h) => (h - 1 + filteredMentionables.length) % filteredMentionables.length);
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        insertMention(filteredMentionables[mentionHighlight]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionOpen(false);
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey && !pending) {
      event.preventDefault();
      if (canSubmit) onSubmit(valueRef.current);
    }
  }

  function handlePaste(event: React.ClipboardEvent<HTMLDivElement>) {
    // Strip HTML — insert as plain text only
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain");
    if (!text) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    handleInput();
  }

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------
  const minHeightValue = minHeight ?? `${rows * LINE_HEIGHT_PX + PADDING_Y_PX}px`;
  const editorStyle: React.CSSProperties = {
    minHeight: minHeightValue,
    maxHeight: `${MAX_AUTO_HEIGHT_PX}px`,
  };

  const hasLeftMenu = Boolean(autosave?.canToggle) || Boolean(onAttachmentsSelected);

  const field = (
    <div
      className={`relative flex items-end gap-1 rounded-control border border-line bg-surface-strong shadow-sm transition-shadow focus-within:border-border focus-within:shadow-md ${fieldClassName ?? ""}`}
    >
      {/* @-mention flyout — anchored inside the field container */}
      <Popover open={mentionOpen && filteredMentionables.length > 0} onOpenChange={setMentionOpen}>
        <PopoverTrigger asChild>
          <span aria-hidden="true" className="pointer-events-none absolute left-4 top-0 h-0 w-0" />
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-64 max-w-[calc(100vw-2rem)] rounded-control border border-line bg-surface-strong p-1 shadow-xl"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <ul ref={mentionListRef} role="listbox" className="max-h-64 overflow-y-auto">
            {filteredMentionables.map((m, idx) => (
              <li
                key={m.id}
                role="option"
                aria-selected={idx === mentionHighlight}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMention(m);
                }}
                onMouseEnter={() => setMentionHighlight(idx)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-[calc(theme(borderRadius.control)-2px)] px-3 py-2 text-sm text-foreground",
                  idx === mentionHighlight ? "bg-surface-muted" : "hover:bg-surface-muted",
                )}
              >
                <Avatar data-size="sm" className="shrink-0">
                  {m.image && <AvatarImage src={m.image} alt={m.displayName} />}
                  <AvatarFallback>{m.displayName.charAt(0).toUpperCase()}</AvatarFallback>
                </Avatar>
                <span className="truncate">{m.displayName}</span>
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>

      {hasLeftMenu && (
        <div className="shrink-0 self-end pb-2 pl-2">
          <AttachmentMenu
            autosave={autosave}
            onUploadClick={onAttachmentsSelected ? () => fileInputRef.current?.click() : undefined}
            uploadDisabled={disabled || pending}
          />
        </div>
      )}

      {/* Editor area: contenteditable div with floating placeholder */}
      <div className="relative min-w-0 flex-1">
        {isEmpty && placeholder && (
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute top-0 py-3 text-sm leading-6 text-muted-foreground select-none",
              hasLeftMenu ? "left-1" : "left-4",
            )}
          >
            {placeholder}
          </span>
        )}
        <div
          ref={editorRef}
          {...(editorTestId ? { "data-testid": editorTestId } : {})}
          contentEditable={isDisabled ? "false" : "true"}
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="false"
          aria-label={submitAriaLabel}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onKeyUp={(e) => {
            // Skip recompute for navigation keys — they don't change the @-query,
            // and recomputeMentionState resets mentionHighlight to 0, undoing arrow navigation.
            if (mentionOpen && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === "Tab" || e.key === "Escape")) return;
            recomputeMentionState();
          }}
          onClick={recomputeMentionState}
          onPaste={handlePaste}
          style={editorStyle}
          className={cn(
            "block w-full overflow-y-auto py-3 pr-14 text-sm leading-6 text-foreground outline-none transition",
            hasLeftMenu ? "pl-1" : "pl-4",
            isDisabled && "cursor-not-allowed opacity-50",
          )}
        />
      </div>

      {/* Prop-gated attachment picker. The hidden <input> is opened by
          the "Upload files" row inside the Plus flyout (AttachmentMenu);
          selected files are forwarded to the consumer callback. */}
      {/* Visually hidden native file picker driven programmatically via ref.
          className="hidden" (display:none) out-specifies every default chrome
          class the <Input> wrapper carries, so the wrapped control renders
          identically to the prior raw <input> — no shadcn chrome reaches a
          display:none element. */}
      {onAttachmentsSelected && (
        <Input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          aria-hidden="true"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length > 0) onAttachmentsSelected(files);
            // Reset so re-picking the SAME file still fires onChange.
            e.target.value = "";
          }}
        />
      )}

      <Button
        type="button"
        variant="default"
        size="icon"
        onClick={handleSubmit}
        disabled={pending ? !onStop : !canSubmit || disabled}
        aria-label={pending ? stopAriaLabel : submitAriaLabel}
        className={cn(
          "absolute bottom-2 right-2 flex h-8 w-8 items-center justify-center rounded-full transition",
          (pending ? !!onStop : canSubmit && !disabled)
            ? "bg-primary text-primary-foreground hover:bg-primary/80 cursor-pointer"
            : "cursor-not-allowed bg-surface-muted text-muted-foreground",
        )}
      >
        {pending ? (
          <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5">
            <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
          </svg>
        ) : (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-3.5 w-3.5"
          >
            <path d="M12 19V5" />
            <path d="m5 12 7-7 7 7" />
          </svg>
        )}
      </Button>
    </div>
  );

  return (
    <div>
      {label ? (
        <Label className="grid gap-2 text-sm font-medium leading-normal">
          <span>{label}</span>
          {field}
        </Label>
      ) : (
        field
      )}
      {showStatusMessage && statusMessage ? (
        <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
          {pending ? <LoadingSpinner className="h-4 w-4 shrink-0 text-muted-foreground" /> : null}
          <p>{statusMessage}</p>
        </div>
      ) : null}
    </div>
  );
});
