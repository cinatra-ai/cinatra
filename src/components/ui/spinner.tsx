import { cn } from "@/lib/utils"
import { Loader2Icon } from "lucide-react"

// The `--primary` token drives the stroke colour; `animate-spin` is the
// Tailwind default 1s linear infinite rotation. Call sites can override colour
// via className when the spinner sits inside a coloured ground (button label,
// etc.).
function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon role="status" aria-label="Loading" className={cn("size-4 animate-spin text-primary", className)} {...props} />
  )
}

export { Spinner }
