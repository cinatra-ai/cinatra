// Minimal stand-ins for the host UI card primitives.
//
// `budget-alert.tsx` is rendered for real in the honesty tests (cinatra#2669):
// the claim under test is what an operator READS off the alert, which a source
// assertion cannot check. Rendering it pulls the host UI barrel, which this
// package's test sandbox cannot resolve, so the two wrappers it uses are stood
// in with plain elements. Nothing about the alert's own markup is stubbed.

import type { ReactNode } from "react";

type Props = { children?: ReactNode; className?: string };

export const Card = ({ children, className }: Props) => (
  <div className={className}>{children}</div>
);
export const CardContent = ({ children, className }: Props) => (
  <div className={className}>{children}</div>
);
export const CardHeader = CardContent;
export const CardTitle = CardContent;
export const CardDescription = CardContent;
export const CardFooter = CardContent;
