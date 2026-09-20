// The HOST-SHARED DESIGN-PRIMITIVES MODULE — the host's single instance of the
// primitives it shares with extension bundles at run time (cinatra#3471 slice 2,
// epic #2926 — decision 407 of 2026-09-13: "the host shares its primitives with
// extension bundles at run time like React does").
//
// THIS IS THE IMPLEMENTATION the bare specifier `@cinatra-ai/design-primitives`
// resolves to. A self-rendering connector/artifact bundle leaves that id
// EXTERNAL (the externals allowlist admits it); the host module-registry shim
// registers THIS object under the id and the ESM façade the host serves
// re-exports it, so the package's `import { Button } from
// "@cinatra-ai/design-primitives"` gets the HOST's component — never a second
// copy. That is the road React and the host design-token module already take;
// nothing is forked for the primitives.
//
// BUILT FROM THE PRODUCT'S OWN COMPONENTS: every export below re-exports a
// component from `src/components/ui/` — the same files
// `scripts/extensions/vendor-extension-primitives.mjs` copies from — so the
// shared module can never drift from the design registry it serves.
//
// THE FROZEN LIST is owned by the SDK leaf
// (`HOST_DESIGN_PRIMITIVES_EXPORTS` in
// `@cinatra-ai/sdk-extensions/artifact-client-bundle`): the `satisfies` below
// makes a removed or renamed export a HOST BUILD failure rather than a run-time
// `undefined` inside somebody else's package.

import {
  HOST_DESIGN_PRIMITIVES_CONTRACT_VERSION,
  type HostDesignPrimitivesModule,
} from "@cinatra-ai/sdk-extensions/design-primitives-contract";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { PaginatedTable } from "@/components/ui/paginated-table";
import {
  Pagination,
  PaginationCaption,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

/**
 * The host's ONE instance of the shared primitives module. Frozen so a renderer
 * that received it through the shim cannot mutate the host's surface.
 */
export const HOST_DESIGN_PRIMITIVES = Object.freeze({
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  badgeVariants,
  Button,
  buttonVariants,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
  InputGroupTextarea,
  Label,
  PaginatedTable,
  Pagination,
  PaginationCaption,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Separator,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
}) satisfies HostDesignPrimitivesModule;

/** The contract version THIS host serves — what the load-time check compares a
 * bundle's `builtAgainst` against. Re-exported here so the host runtime reads
 * one place. */
export const HOST_DESIGN_PRIMITIVES_SERVED_VERSION = HOST_DESIGN_PRIMITIVES_CONTRACT_VERSION;

/**
 * THE BUILD-TIME SURFACE (cinatra#3512, slice 2b of #3471): the frozen list
 * re-exported under the contract's OWN names. A SOURCE-COMPILED package — a
 * connector's setup page, an artifact package's server parts, compiled into the
 * host's own build through the `@cinatra-ai/design-primitives` tsconfig path —
 * writes `import { Alert } from "@cinatra-ai/design-primitives"` and gets the
 * HOST's binding. Each name below is the SAME binding the frozen object above
 * carries, so the build-time road and the run-time road can never serve two
 * different components.
 *
 * EXACTLY the frozen export list and nothing else: the surface is pinned
 * against `HOST_DESIGN_PRIMITIVES_EXPORTS` in
 * `__tests__/design-primitives-build-time-road.test.ts`, so a name added here
 * without the contract, or the other way round, is a red.
 */
export {
  // alert
  Alert,
  AlertDescription,
  AlertTitle,
  // badge
  Badge,
  badgeVariants,
  // button
  Button,
  buttonVariants,
  // card
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  // checkbox
  Checkbox,
  // dialog
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  // field
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
  // input
  Input,
  // input-group
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
  InputGroupTextarea,
  // label
  Label,
  // paginated-table
  PaginatedTable,
  // pagination
  Pagination,
  PaginationCaption,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
  // select
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  // separator
  Separator,
  // table
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  // textarea
  Textarea,
};
