"use client"

import * as React from "react"
import { ChevronDownIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

// The ratified drawing, of the Combobox — "A Select crossed with the
// Command menu: an Input-chrome trigger opens a type-to-filter list. The current
// value carries an indigo check; the highlighted row uses the indigo soft-tint.
// Reach for it over Select whenever the option count passes ~8."
//
// The generic single-select combobox the spec names at `@/components/ui/combobox`.
// AccessCombobox stays what it is — the access-picker, with its scope algebra,
// grouped rows and per-row reasons; this is the plain one every long flat list
// reaches for.
//
// The trigger's chrome is the INPUT's, which is what the drawing names for it —
// down to the fill, `bg-surface-strong`, the pure white the surfaces section
// reserves for "Card bodies, input fields, popovers. Only place pure white
// lives in the system." A transparent fill borrowed from SelectTrigger let the
// card behind show through instead, so the control read a half-step darker than
// the Input beside it; the rest of the chrome (border, radius, focus ring,
// placeholder ink, dark control fill) is unchanged and still matches the select
// family, so a list crossing the ~8 threshold changes its BEHAVIOUR without
// changing how the row reads beside its neighbours.

export interface ComboboxOption {
  value: string
  /** What the row and the trigger draw. Defaults to `value`. */
  label?: string
  /** Extra terms the type-to-filter search should match on. */
  keywords?: string[]
}

function Combobox({
  id,
  value,
  onValueChange,
  options,
  placeholder = "Select an option",
  searchPlaceholder = "Search…",
  emptyText = "No matches.",
  disabled = false,
  className,
  contentClassName,
  "aria-labelledby": ariaLabelledBy,
  "aria-label": ariaLabel,
}: {
  id?: string
  value?: string
  onValueChange?: (value: string) => void
  options: ComboboxOption[]
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  disabled?: boolean
  className?: string
  contentClassName?: string
  "aria-labelledby"?: string
  "aria-label"?: string
}) {
  const [open, setOpen] = React.useState(false)
  const listId = React.useId()
  const selected = options.find((option) => option.value === value)
  const label = selected ? (selected.label ?? selected.value) : undefined

  return (
    <Popover open={open} onOpenChange={disabled ? undefined : setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          // THE POPUP IS A DIALOG, AND `aria-haspopup` NAMES WHAT IT IS.
          //
          // `aria-controls` can only reference the popover container: cmdk owns
          // the element that carries `role="listbox"` and stamps its OWN id on
          // it last, so an id passed to CommandList is overwritten and the
          // listbox is unaddressable from here. The container it CAN reference
          // is Radix's PopoverContent, whose role is `dialog` — a dialog that
          // holds the search field and the list together, which is also what
          // the drawing describes ("an Input-chrome trigger opens a
          // type-to-filter list"). Advertising `listbox` therefore pointed a
          // reader's assistive technology at a role the referenced element does
          // not have. Naming `dialog` makes the pair agree, which is what the
          // combobox pattern asks for: `aria-haspopup` describes the popup that
          // `aria-controls` resolves to.
          aria-haspopup="dialog"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          disabled={disabled}
          // ARROW KEYS OPEN THE CLOSED CONTROL.
          //
          // The trigger is a button, so Radix gives it Enter and Space and
          // nothing else — but the element announces itself as a combobox, and
          // for a combobox ArrowDown/ArrowUp opening the popup is the behaviour
          // a keyboard reader arrives with. Without it the only way into a
          // list the drawing reaches for precisely because it is LONG
          // ("whenever the option count passes ~8") was to know that Enter also
          // works. Opening on the arrows costs nothing to a pointer user and
          // makes the keyboard road the expected one; once open, focus is in
          // the search field and cmdk owns every subsequent key.
          onKeyDown={(event) => {
            if (disabled || open) return
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
            // Otherwise the same keypress scrolls the page behind the popover.
            event.preventDefault()
            setOpen(true)
          }}
          data-slot="combobox-trigger"
          // A trigger with nothing bound is marked, so it takes the muted
          // placeholder ink the select family already uses for that state.
          data-placeholder={label === undefined ? "" : undefined}
          className={cn(
            "flex h-9 w-fit items-center justify-between gap-2 rounded-md border border-input bg-surface-strong px-3 py-2 text-sm font-normal whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted-foreground dark:bg-input-fill/30 dark:hover:bg-input-fill/50",
            className,
          )}
        >
          <span
            data-slot="combobox-value"
            className="line-clamp-1 flex items-center gap-2 text-left"
          >
            {label ?? placeholder}
          </span>
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        id={listId}
        align="start"
        data-slot="combobox-content"
        className={cn(
          "w-(--radix-popover-trigger-width) min-w-[12rem] p-0",
          contentClassName,
        )}
      >
        {/* cmdk highlights its FIRST row on mount unless it is told otherwise,
            which on a list long enough to want this control (the drawing:
            "whenever the option count passes ~8") opens the popover scrolled
            past the current value — and a check nobody can see is no check.
            Seeding cmdk with the bound value opens the list where the drawing's
            own picture opens it: on the current value's row, highlighted and
            checked at once. The popover unmounts when it closes, so each open
            re-seeds from the value bound at that moment.

            cmdk reads that seed ONCE, when the list mounts, so a value that
            changes from OUTSIDE while the list is open would leave the check on
            the new row and the highlight on the old one — and the keyboard
            commit then takes the row the reader is no longer looking at. Keying
            the list on the bound value re-seeds it on exactly that transition,
            which is also the moment an in-progress search has stopped being
            about the value in the field. Typing, arrow navigation and the
            filter are untouched: the key only moves when the bound value
            does. */}
        <Command key={value ?? ""} defaultValue={value}>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            {options.map((option) => {
              const text = option.label ?? option.value
              const isSelected = option.value === value
              return (
                <CommandItem
                  key={option.value}
                  // cmdk identifies a row BY ITS `value`, so the row takes the
                  // option's own unique value and never its label: two options
                  // may legitimately share a label (only `value` is contracted
                  // unique above), and two rows sharing a cmdk value collide —
                  // the highlight and the keyboard selection then address the
                  // wrong row. The label stays SEARCHABLE by riding in the
                  // keywords cmdk matches on beside the value.
                  value={option.value}
                  keywords={
                    text === option.value
                      ? option.keywords
                      : [text, ...(option.keywords ?? [])]
                  }
                  // CommandItem appends the trailing check and reveals it on
                  // `data-checked`; the tint below makes it the indigo check the
                  // spec names, without a second check of our own.
                  data-checked={isSelected ? "true" : "false"}
                  // cmdk stamps `data-selected` on EVERY row — "true" on the one
                  // it has highlighted and "false" on all the others — so the
                  // shared CommandItem base, which matches on the attribute's
                  // PRESENCE, paints the indigo soft-tint across the whole list.
                  // A tint on every row marks nothing, and the ground a reader
                  // then sees is the tint rather than the popover's own white.
                  // Redeclaring the same background group drops the base's
                  // variant (tailwind-merge) and restores the drawing: the list
                  // opens onto the popover surface, and THE highlighted row —
                  // the one stamped "true" — is the only one tinted. Same idiom
                  // the access-picker already uses for the same reason.
                  className={cn(
                    "data-selected:bg-transparent data-[selected=true]:bg-primary/[0.08]!",
                    "data-[checked=true]:[&_svg]:text-primary!",
                  )}
                  onSelect={() => {
                    onValueChange?.(option.value)
                    setOpen(false)
                  }}
                >
                  {text}
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export { Combobox }
