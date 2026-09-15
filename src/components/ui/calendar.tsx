"use client"

import * as React from "react"
import { CalendarIcon, ChevronLeft, ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

/**
 * THE APP'S OWN CALENDAR, ON THE APP'S OWN TOKENS (cinatra#3182 item 6).
 *
 * Application Design — Components, "Calendar / Date picker": "Month grid on the
 * white popover surface. Weekday heads are mono uppercase; the selected day is
 * an indigo-filled disc; today carries an indigo ring; a date range fills the
 * in-between days with the indigo soft-tint. DatePicker is the calendar inside
 * a Popover triggered from an Input-styled button."
 *
 * The roster names `@/components/ui/calendar` as its home and the repository
 * carried no such module, so a surface that needed a date had only the
 * browser's native `datetime-local` chrome to reach for — which is the one
 * thing the drawing never draws. This is that module, written against the
 * repository's own primitives: no new dependency, the `Popover` the design
 * system already ships, and the same tokens every other control resolves.
 *
 * SINGLE SELECTION ONLY, for now. The roster also describes a range reading
 * ("a date range fills the in-between days"); no surface in the product asks a
 * range yet, and a mode nothing mounts is a mode nothing proves, so it is left
 * for the surface that first needs it rather than shipped unread.
 *
 * VALUES ARE LOCAL CALENDAR DAYS, never instants: `YYYY-MM-DD`, the same shape
 * the date half of an ISO local date-time carries. A `Date` would drag a
 * timezone into a control whose whole job is to name a day.
 */

/** Monday-first, as the drawing's own month grid heads it: M T W T F S S. */
const WEEKDAY_HEADS = ["M", "T", "W", "T", "F", "S", "S"] as const

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const

function pad(n: number): string {
  return String(n).padStart(2, "0")
}

/** A local calendar day as `YYYY-MM-DD`. */
export function toDayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * `YYYY-MM-DD` back to the local day it names; `null` for anything else.
 *
 * THE KEY IS VERIFIED, NOT NORMALISED (cinatra#3182, convergence round). A bare
 * `new Date(2027, 1, 30)` does not fail — it rolls forward to 2 March — so an
 * impossible day would have been DRAWN as one date while the field still held
 * the other. The pattern is anchored at both ends and the constructed day is
 * read back: a key that does not name itself names nothing.
 */
export function fromDayKey(key: string | null | undefined): Date | null {
  if (typeof key !== "string") return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (m === null) return null
  const year = Number(m[1])
  const month = Number(m[2]) - 1
  const day = Number(m[3])
  const date = new Date(year, month, day)
  if (Number.isNaN(date.getTime())) return null
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month ||
    date.getDate() !== day
  ) {
    return null
  }
  return date
}

/** The day, written the way a reader reads it. */
export function formatDayKey(key: string): string {
  const date = fromDayKey(key)
  if (date === null) return key
  return `${MONTH_NAMES[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`
}

/** Monday-first offset of the 1st of the month, 0–6. */
function leadingBlanks(year: number, month: number): number {
  return (new Date(year, month, 1).getDay() + 6) % 7
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

export type CalendarProps = {
  /** The selected day, `YYYY-MM-DD`. */
  value?: string | null
  onValueChange?: (day: string) => void
  /** Today, injectable so a test can pin the ring without pinning the clock. */
  today?: string
  className?: string
}

export function Calendar({
  value,
  onValueChange,
  today,
  className,
}: CalendarProps) {
  const todayKey = today ?? toDayKey(new Date())
  const anchor = fromDayKey(value ?? null) ?? fromDayKey(todayKey) ?? new Date()
  const [month, setMonth] = React.useState(
    () => new Date(anchor.getFullYear(), anchor.getMonth(), 1),
  )

  const year = month.getFullYear()
  const monthIndex = month.getMonth()
  const blanks = leadingBlanks(year, monthIndex)
  const total = daysInMonth(year, monthIndex)
  const days = Array.from({ length: total }, (_, i) => i + 1)

  function step(by: number) {
    setMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() + by, 1))
  }

  /**
   * ONE TAB STOP, AND THE ARROWS DO THE WALKING (cinatra#3182, convergence
   * round). A month of independently tabbable buttons puts up to 31 stops
   * between a keyboard and the next field, and the grid role the first draft
   * declared was not the grid ARIA asks for — its children are days, not rows
   * of cells. So the month is a named group, exactly one day is in the tab
   * order, and Arrow / Home / End / PageUp / PageDown move the focus, crossing
   * a month boundary by turning the page under it.
   */
  const gridRef = React.useRef<HTMLDivElement>(null)
  const [focusKey, setFocusKey] = React.useState<string | null>(null)

  const inMonth = (key: string | null | undefined): boolean => {
    const d = fromDayKey(key ?? null)
    return d !== null && d.getFullYear() === year && d.getMonth() === monthIndex
  }
  const firstKey = `${year}-${pad(monthIndex + 1)}-01`
  const tabbableKey = inMonth(focusKey)
    ? (focusKey as string)
    : inMonth(value)
      ? (value as string)
      : inMonth(todayKey)
        ? todayKey
        : firstKey

  React.useEffect(() => {
    if (focusKey === null) return
    gridRef.current
      ?.querySelector<HTMLButtonElement>(`[data-day="${focusKey}"]`)
      ?.focus()
  }, [focusKey, year, monthIndex])

  function moveFocusTo(target: Date) {
    if (
      target.getFullYear() !== year ||
      target.getMonth() !== monthIndex
    ) {
      setMonth(new Date(target.getFullYear(), target.getMonth(), 1))
    }
    setFocusKey(toDayKey(target))
  }

  function onGridKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const cell = (event.target as HTMLElement).closest?.("[data-day]")
    const current = fromDayKey(cell?.getAttribute("data-day") ?? null)
    if (current === null) return
    const y = current.getFullYear()
    const m = current.getMonth()
    const d = current.getDate()
    const byArrow: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    }
    if (event.key in byArrow) {
      event.preventDefault()
      moveFocusTo(new Date(y, m, d + byArrow[event.key]))
      return
    }
    if (event.key === "Home") {
      event.preventDefault()
      moveFocusTo(new Date(year, monthIndex, 1))
      return
    }
    if (event.key === "End") {
      event.preventDefault()
      moveFocusTo(new Date(year, monthIndex, daysInMonth(year, monthIndex)))
      return
    }
    if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault()
      const nextMonth = m + (event.key === "PageUp" ? -1 : 1)
      const anchored = new Date(y, nextMonth, 1)
      const clamped = Math.min(
        d,
        daysInMonth(anchored.getFullYear(), anchored.getMonth()),
      )
      moveFocusTo(new Date(anchored.getFullYear(), anchored.getMonth(), clamped))
    }
  }

  return (
    <div data-slot="calendar" className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center justify-between">
        <button
          type="button"
          data-slot="calendar-previous-month"
          aria-label="Previous month"
          onClick={() => step(-1)}
          className="inline-flex size-6 items-center justify-center rounded-[7px] text-muted-foreground hover:bg-surface-muted hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
        </button>
        <span
          data-slot="calendar-month"
          className="text-sm font-medium text-foreground"
        >
          {MONTH_NAMES[monthIndex]} {year}
        </span>
        <button
          type="button"
          data-slot="calendar-next-month"
          aria-label="Next month"
          onClick={() => step(1)}
          className="inline-flex size-6 items-center justify-center rounded-[7px] text-muted-foreground hover:bg-surface-muted hover:text-foreground"
        >
          <ChevronRight className="size-3.5" />
        </button>
      </div>

      <div
        ref={gridRef}
        role="group"
        aria-label={`${MONTH_NAMES[monthIndex]} ${year}`}
        onKeyDown={onGridKeyDown}
        className="grid grid-cols-7 gap-0.5"
      >
        {WEEKDAY_HEADS.map((head, i) => (
          <span
            key={`head-${i}`}
            aria-hidden="true"
            data-slot="calendar-weekday"
            className="flex h-6 items-center justify-center font-mono text-[10px] uppercase text-muted-foreground"
          >
            {head}
          </span>
        ))}
        {Array.from({ length: blanks }, (_, i) => (
          <span key={`blank-${i}`} aria-hidden="true" className="size-7" />
        ))}
        {days.map((day) => {
          const key = `${year}-${pad(monthIndex + 1)}-${pad(day)}`
          const selected = key === value
          const isToday = key === todayKey
          return (
            <button
              key={key}
              type="button"
              data-slot="calendar-day"
              data-day={key}
              data-selected={selected ? "" : undefined}
              aria-pressed={selected}
              aria-label={formatDayKey(key)}
              tabIndex={key === tabbableKey ? 0 : -1}
              onClick={() => onValueChange?.(key)}
              className={cn(
                "flex size-7 items-center justify-center rounded-full text-xs transition-colors",
                selected
                  ? "bg-primary font-semibold text-primary-foreground"
                  : "text-foreground hover:bg-surface-muted",
                !selected && isToday && "ring-1 ring-primary",
              )}
            >
              {day}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export type DatePickerProps = {
  id?: string
  value?: string | null
  onValueChange?: (day: string) => void
  placeholder?: string
  disabled?: boolean
  today?: string
  className?: string
}

/**
 * "DatePicker is the calendar inside a Popover triggered from an Input-styled
 * button." The trigger carries the `Input` primitive's own chrome — the same
 * height, radius, boundary and fill — so the field reads as a field and never
 * as the browser's own picker.
 */
export function DatePicker({
  id,
  value,
  onValueChange,
  placeholder = "Pick a date",
  disabled,
  today,
  className,
}: DatePickerProps) {
  const [open, setOpen] = React.useState(false)
  const chosen = typeof value === "string" && value.length > 0 ? value : null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          disabled={disabled}
          data-slot="date-picker-trigger"
          className={cn(
            "flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-[7px] border border-input bg-surface-strong px-2.5 py-1 text-left text-base font-normal shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input-fill/50 disabled:opacity-50 md:text-sm dark:bg-input-fill/30 dark:disabled:bg-input-fill/80",
            className,
          )}
        >
          <span className={chosen === null ? "text-muted-foreground" : undefined}>
            {chosen === null ? placeholder : formatDayKey(chosen)}
          </span>
          <CalendarIcon className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto">
        <Calendar
          value={chosen}
          today={today}
          onValueChange={(day) => {
            onValueChange?.(day)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
