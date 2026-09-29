import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-[7px] border border-transparent bg-clip-padding text-sm/4 font-medium whitespace-nowrap transition-all outline-none select-none data-[variant=link]:px-[4px] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    // Every class below is one of the components drawing's own `.btn`
    // sentences. The corner and the box live on the base recipe because the
    // drawing states them once, for the whole roster:
    //
    //   .btn { … padding: 7px 14px; … border-radius: 7px; }
    //
    // The corner is a LITERAL and not `rounded-lg`, because `rounded-lg`
    // resolves through `--radius`, which the app's two palettes set to
    // different values — the same button drew a 6px corner in light and an 8px
    // corner in dark, and a drawn constant cannot be a variable.
    //
    // The box is padding, not a fixed height. The recipe used to state `h-8`
    // with horizontal padding only, so the button measured `0px 10px` against
    // the drawing's `7px 14px`. The height the drawing's own numbers produce —
    // 7 + 7, two 1px edges and a 16px line box — is the 32px the button already
    // stood at, so what the eye sees is unchanged while the padding becomes the
    // thing that makes it. `text-sm/4` pins that line box; without it the box
    // would grow by 4px across every consumer.
    variants: {
      variant: {
        // ".btn.primary { background: var(--blue); color: var(--surface-strong);
        //   border-color: var(--blue); }" — the edge goes on the BLUE. The navy
        // edge this recipe used to draw is the one the drawing gives the
        // unfilled `.btn`; it is not a stroke the drawing ever puts around an
        // indigo fill.
        default:
          "border-primary bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        // The drawing's Button section names SEVEN variants — "Primary,
        // default, outline, secondary, destructive, ghost, link" — and pins the
        // indigo fill to the first word ("Indigo primary"). `primary` and
        // `default` are one recipe under two names, so the 200-plus call sites
        // that ask for `default` keep drawing exactly what `primary` draws.
        primary:
          "border-primary bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        // ".btn.outline { background: var(--surface); color: var(--ink);
        //   border-color: var(--line-strong); }" — the warm cream, the ink
        // label and the STRONG line, not the 0.14-alpha hairline `--border`
        // carries. `--line-strong-control` is that strong line resolved per
        // palette: the drawing's navy in light, and on the dark ramp a
        // navy-FAMILY stroke at low alpha, because rule 6 ("All hairlines use
        // navy at low alpha … Never use a neutral grey on a divider") outlaws
        // the neutral white edge this variant drew there.
        outline:
          "border-line-strong-control bg-surface text-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
        // ".btn.secondary { background: var(--surface-muted); color: var(--ink);
        //   border-color: transparent; }" — the transparent edge comes from the
        // base recipe.
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80 aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        // ".btn.ghost { background: transparent; border-color: transparent; }"
        // — stated, not inherited from whatever the surface happens to be, so
        // the rest state is the drawing's rather than the page's.
        ghost:
          "bg-transparent text-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        // ".btn.destructive { background: rgba(166,56,79,0.10);
        //   color: var(--red); border-color: rgba(166,56,79,0.24); }" — rule 4,
        // red on a tint, never a solid red fill. The tinted EDGE was missing.
        destructive:
          "border-destructive/24 bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        // ".btn.link { background: transparent; border-color: transparent;
        //   color: var(--blue); text-decoration: underline;
        //   text-underline-offset: 3px; padding: 7px 4px; }" — drawn underlined
        // at rest, not on hover. Its narrower gutter rides the base recipe's
        // `data-[variant=link]:px-[4px]`, which outranks the size recipe's own
        // horizontal padding. The label takes indigo in its INK role
        // (`--accent-ink`): identical to the fill's #364E81 on the cream
        // palette, and the same hue's light end on the dark ramp, where the
        // fill colour drawn as text would sit at about 2.2:1 on the ground.
        link: "text-accent-ink underline underline-offset-[3px]",
      },
      size: {
        default:
          "gap-[7px] px-[14px] py-[7px] has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 px-2 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 px-2.5 text-[0.8rem] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        "icon-xs":
          "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
