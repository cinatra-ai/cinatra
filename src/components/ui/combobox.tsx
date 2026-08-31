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
// reaches for. The trigger repeats SelectTrigger's chrome verbatim so a list
// that crosses the ~8 threshold changes its BEHAVIOUR without changing how the
// row reads beside the selects next to it.

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
          aria-haspopup="listbox"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          disabled={disabled}
          data-slot="combobox-trigger"
          // A trigger with nothing bound is marked, so it takes the muted
          // placeholder ink the select family already uses for that state.
          data-placeholder={label === undefined ? "" : undefined}
          className={cn(
            "flex h-9 w-fit items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-sm font-normal whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted-foreground dark:bg-input-fill/30 dark:hover:bg-input-fill/50",
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
        <Command>
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
                  className="data-[checked=true]:[&_svg]:text-primary!"
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
