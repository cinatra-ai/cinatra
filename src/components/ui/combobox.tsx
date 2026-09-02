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
  // THE SEAM IS WHICHEVER EDGE THE TWO HALVES MEET ON.
  //
  // The drawing draws the joined pair once, opening downward, and squares only
  // the seam. Which side the list takes is not the trigger's to choose — the
  // popover layer flips it above the trigger whenever there is no room
  // beneath — so a trigger that squares its BOTTOM corners on "open" alone
  // squares the wrong edge for half the placements that layer can produce, and
  // the pair then reads as two controls with a notch between them. The layer
  // publishes its choice as `data-side` on the content; it is read from there
  // and carried back here, so the trigger squares the edge it actually meets.
  const [side, setSide] = React.useState<string | null>(null)
  const observer = React.useRef<MutationObserver | null>(null)
  const watchSide = React.useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (!node) {
      setSide(null)
      return
    }
    const read = () => setSide(node.getAttribute("data-side"))
    read()
    // The layer re-places the list on scroll and resize, so the side can change
    // while the list is open; the seam follows it rather than the first answer.
    const watch = new MutationObserver(read)
    watch.observe(node, { attributes: true, attributeFilter: ["data-side"] })
    observer.current = watch
  }, [])
  React.useEffect(() => () => observer.current?.disconnect(), [])
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
          // The side the open list took, or nothing at all while it is closed:
          // a closed trigger meets no list and draws no seam.
          data-join={open && side ? side : undefined}
          // `h-8` and `rounded-[7px]`: the Input's own, because the drawing
          // says so twice — "Trigger mirrors Input chrome" over the family, and
          // its own Combobox picture writing the trigger out at
          // `height: 32px` with `border-radius: 7px 7px 0 0`. The shared
          // `rounded-md` token this used to take is derived from a `--radius`
          // the two palettes set differently, so the pair rounded 6px in one
          // and 8px in the other where the drawing draws one number.
          className={cn(
            "flex h-8 w-fit items-center justify-between gap-2 rounded-[7px] border border-input bg-surface-strong px-3 py-1 text-sm font-normal whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted-foreground data-[join=bottom]:rounded-b-none data-[join=top]:rounded-t-none dark:bg-input-fill/30 dark:hover:bg-input-fill/50",
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
        // THE OPEN LIST IS JOINED TO ITS TRIGGER.
        //
        // The drawing draws the pair as ONE control: the trigger takes
        // `border-radius: 7px 7px 0 0` over a list taking
        // `border-radius: 0 0 7px 7px` with `border-top: 0`, both carrying the
        // same 1px outline, and nothing at all between them — the seam IS the
        // trigger's own bottom edge. The shared popover floats its content 4px
        // clear on the section hairline, which is right for a popover belonging
        // to nothing in particular and wrong for this one, whose whole reading
        // is the trigger continuing downward. So the offset and the joined edge
        // are set HERE, per call site: tooltips, dialogs and every other
        // popover keep the detached default they are drawn with.
        //
        // The outline is `border-input` — the boundary this palette hands its
        // CONTROLS, which the light palette resolves to the very
        // `var(--line-strong)` the drawing names. The dark palette hands
        // controls a different one on purpose (full navy is invisible on a dark
        // ground; cinatra#3107 measured the replacement and
        // control-border-contrast pins it), so taking the control boundary
        // rather than the literal token is what keeps the pair reading as one
        // control in BOTH palettes. Either way it is no longer the divider
        // hairline, which is what made the list read as a separate object.
        sideOffset={0}
        ref={watchSide}
        data-slot="combobox-content"
        className={cn(
          // `ring-0`: the shared popover layer rings its content in a
          // low-alpha hairline OUTSIDE its border box, on all four sides.
          // Around a popover that belongs to nothing in particular that is
          // an elevation cue; around this one it is a second outline where
          // the drawing draws exactly one, and it runs straight along the
          // seam the border-top is dropped to open — putting back the very
          // low-alpha line that made the list read as a separate object.
          "w-(--radix-popover-trigger-width) min-w-[12rem] border-input p-0 ring-0",
          // The outer radius and the drop shadow the drawing declares on this
          // list in full — `border-radius: 0 0 7px 7px` and
          // `box-shadow: 0 10px 26px -10px rgba(21,33,58,0.22)`, the "slightly
          // higher shadow" the Select family's prose gives an open popover.
          // Both are literals in the drawing, so both are literals here rather
          // than the shared popover layer's palette-varying token and its
          // ordinary `shadow-md`.
          "rounded-[7px] shadow-[0_10px_26px_-10px_rgba(21,33,58,0.22)]",
          // THE SEAM, ON WHICHEVER EDGE THE PAIR ACTUALLY MEETS ON.
          //
          // The drawing writes one join, the downward one, and writes no second
          // block for a list that has no room beneath its trigger. What it does
          // state is what the pair IS — one control, one continuous outline,
          // `border-top: 0` on the half that meets the other, and nothing at
          // all between them. A flipped list still meets its trigger on an
          // edge, so that sentence is applied to the edge it actually meets:
          // the join is MIRRORED rather than dropped, which is the reading the
          // drawing's own picture asks for in the placement it does draw.
          "data-[side=bottom]:rounded-t-none data-[side=bottom]:border-t-0",
          "data-[side=top]:rounded-b-none data-[side=top]:border-b-0",
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
        <Command
          key={value ?? ""}
          defaultValue={value}
          // The list IS the popover's body here, so it draws no ground, no
          // radius and no inset of its own — the popover already draws all
          // three, and a second ground inside it would be a second surface. The
          // drawing's own `padding: 5px` around the rows moves onto the list
          // below, which is what lets the search row's rule run edge to edge
          // above them.
          className="rounded-none! bg-transparent p-0"
        >
          <CommandInput chrome="flush" placeholder={searchPlaceholder} />
          <CommandList className="p-[5px]">
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
