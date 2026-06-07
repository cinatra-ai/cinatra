import { forwardRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type IconButtonProps = React.ComponentPropsWithoutRef<"button">;

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, ...props }, ref) => (
    <Button
      ref={ref}
      variant="ghost"
      size="icon"
      className={cn("rounded-full", className)}
      {...(props as React.ComponentPropsWithoutRef<typeof Button>)}
    />
  ),
);
IconButton.displayName = "IconButton";
