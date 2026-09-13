"use client"

import { useTheme } from 'next-themes'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

type SonnerTheme = NonNullable<ToasterProps['theme']>

// next-themes is configured with the project palette name 'cinatra' (and 'dark').
// Sonner only knows 'light' | 'dark' | 'system' — passing 'cinatra' through emits
// data-sonner-theme="cinatra", which matches none of Sonner's bundled CSS rules
// and leaves --info-bg / --normal-bg undefined (transparent).
function resolveSonnerTheme(theme: string | undefined): SonnerTheme {
  if (theme === 'dark') return 'dark'
  if (theme === 'system') return 'system'
  return 'light'
}

// THE TOAST IS NOT DRAWN ON THE APPLICATION HEADER (cinatra#3358).
//
// THE MEASURED DEFECT. The toast island opens at the top-right on the library's
// own 24px offset, and the application header is a 64px sticky band across that
// same corner — so a raised toast and the header's own controls occupied the
// same pixels. Read on a magnified crop of a real boot: the header's wrench, its
// add control, the palette control and the bell read THROUGH the toast body, the
// message text was overprinted by them, and the toast's Close came to rest on
// top of the bell and its unread badge. Neither surface is legible in that
// overlap, and the drawing gives the toast an OPAQUE POPOVER GROUND
// (Components § Toast/Sonner — "popover bg, status-coloured text + border"),
// which is a ground with nothing of another surface in it.
//
// THE FIX IS GEOMETRY, NOT A Z-INDEX RACE. Lifting the island over the header
// would have covered the header's controls instead of being covered by them —
// the same illegible pair, the other way round. The island is therefore opened
// BELOW the header band, where its ground is its own; the offset is the header's
// own height plus the island's ordinary gutter, so a header that changes height
// moves this with it.
//
// AND THE GROUND IS PINNED, not merely routed. The variants below hand the
// library `var(--popover)` for every ground, but the library paints those
// through its own unlayered stylesheet, which a variant rule can reach past.
// The ground is therefore also asserted on the toast itself, so "popover bg" is
// what the toast carries rather than what it asks for.

/** The application header's own height — `h-16` on the sticky topbar. */
const APP_HEADER_HEIGHT = '4rem'
/** The island's ordinary gutter beneath it. */
const TOAST_GUTTER = '1rem'

export const TOASTER_OFFSET = {
  top: `calc(${APP_HEADER_HEIGHT} + ${TOAST_GUTTER})`,
  right: TOAST_GUTTER,
  bottom: TOAST_GUTTER,
  left: TOAST_GUTTER,
} as const

// AND THE NARROW VIEWPORT IS THE SAME BAND. The library keeps a SECOND offset
// for narrow viewports: it writes `--offset-*` and `--mobile-offset-*` from two
// separate props, and under 600px its own stylesheet positions the island from
// `--mobile-offset-top` alone, which defaults to the library's small gutter. So
// an island moved below the header on a wide viewport opened right back inside
// the header band on a narrow one. The header band is the same height there, so
// the narrow offset is the same offset.
export const TOASTER_MOBILE_OFFSET = TOASTER_OFFSET

/** The drawn ground, carried by the toast and by the close control on it. */
export const TOAST_OPAQUE_GROUND_CLASS = '!bg-popover'

export function Toaster({ ...props }: ToasterProps) {
  const { theme = 'system' } = useTheme()

  return (
    <Sonner
      theme={resolveSonnerTheme(theme)}
      offset={TOASTER_OFFSET}
      mobileOffset={TOASTER_MOBILE_OFFSET}
      toastOptions={{
        classNames: {
          toast: TOAST_OPAQUE_GROUND_CLASS,
          closeButton: TOAST_OPAQUE_GROUND_CLASS,
        },
      }}
      className='toaster group [&_div[data-content]]:w-full'
      style={
        {
          // Five toast variants use the popover surface with status-coloured
          // text, borders, and icons. The CSS vars below route Sonner's built-in
          // variant slots to design tokens so palette changes cascade through
          // automatically. Success, warning, and info currently map to
          // sea-green, mustard, and indigo respectively.
          //
          // Copy and Close controls are injected by the `cinatraToast(...)`
          // wrapper through Sonner `action` and `cancel` slots; this primitive
          // owns the CSS chrome only.

          // WHERE COPY AND CLOSE ARE DRAWN IS A RULE, NOT A VARIABLE.
          // The drawing puts Copy and Close together on the right, inside the
          // toast. The toast library pins its close control outside a corner
          // with position: absolute and a transform, and the custom properties
          // it exposes only choose WHICH corner — a badge on the left corner
          // and a badge on the right corner are the same drawing, and the right
          // one measured overlapping the application header's own notification
          // badge. The placement therefore lives in src/app/globals.css, where a
          // rule can answer the library's own; this component keeps the toast's
          // colours, which is all a custom property can carry.

          // Default toast — popover surface, foreground text.
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',

          // Info — indigo text on popover surface.
          '--info-bg': 'var(--popover)',
          '--info-text': 'var(--info)',
          '--info-border': 'var(--info)',

          // Error — brand red text on popover surface.
          '--error-bg': 'var(--popover)',
          '--error-text': 'var(--destructive)',
          '--error-border': 'var(--destructive)',

          // Success — sea-green text on popover surface.
          '--success-bg': 'var(--popover)',
          '--success-text': 'var(--success)',
          '--success-border': 'var(--success)',

          // Warning — mustard text on popover surface.
          '--warning-bg': 'var(--popover)',
          '--warning-text': 'var(--warning)',
          '--warning-border': 'var(--warning)',
        } as React.CSSProperties
      }
      {...props}
    />
  )
}
