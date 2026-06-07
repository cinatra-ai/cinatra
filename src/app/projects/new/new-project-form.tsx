"use client";

import { useEffect, useTransition } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Form, FormField, FormItem, FormLabel, FormControl, FormMessage,
} from "@/components/ui/form";
import { toast } from "@/lib/cinatra-toast";

// Discriminated-union zod schema. The error strings are user-facing copy.
const formSchema = z.discriminatedUnion("ownerLevel", [
  z.object({
    ownerLevel: z.literal("user"),
    name: z.string().trim().min(1, "Enter a project name to continue.").max(255, "Project name must be 255 characters or fewer."),
    description: z.string().optional(),
    visibility: z.enum(["private", "discoverable"]),
  }),
  z.object({
    ownerLevel: z.literal("team"),
    name: z.string().trim().min(1, "Enter a project name to continue.").max(255, "Project name must be 255 characters or fewer."),
    description: z.string().optional(),
    teamId: z.string().min(1, "Pick a team to own this project, or change the ownership level."),
    visibility: z.enum(["private", "discoverable"]),
  }),
  z.object({
    ownerLevel: z.literal("organization"),
    name: z.string().trim().min(1, "Enter a project name to continue.").max(255, "Project name must be 255 characters or fewer."),
    description: z.string().optional(),
    organizationId: z.string().min(1, "Pick an organization to own this project, or change the ownership level."),
    visibility: z.enum(["private", "discoverable"]),
  }),
]);

type FormValues = z.infer<typeof formSchema>;

export type TeamOption = { id: string; name: string; orgName: string };
export type OrganizationOption = { id: string; name: string };

export type NewProjectFormProps = {
  teams: TeamOption[];
  organizations: OrganizationOption[];
  action: (fd: FormData) => Promise<void>;
  /** Error message from a previous server-action redirect (e.g. ?error=name-required). */
  initialError?: string;
};

export function NewProjectForm({ teams, organizations, action, initialError }: NewProjectFormProps) {
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { ownerLevel: "user", name: "", description: "", visibility: "private" },
  });
  const ownerLevel = form.watch("ownerLevel");
  const [isPending, startTransition] = useTransition();

  // Surface server-action errors that arrived via ?error= redirect.
  useEffect(() => {
    if (initialError) {
      toast.error(initialError);
    }
  // Run only once on mount (initialError is stable — it comes from server props).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSubmit = (values: FormValues) => {
    startTransition(async () => {
      const fd = new FormData();
      fd.set("name", values.name);
      if (values.description) fd.set("description", values.description);
      fd.set("ownerLevel", values.ownerLevel);
      fd.set("visibility", values.visibility);
      if (values.ownerLevel === "team") fd.set("teamId", values.teamId);
      if (values.ownerLevel === "organization") fd.set("organizationId", values.organizationId);

      try {
        await action(fd);
      } catch (err) {
        // redirect() in a server action throws NEXT_REDIRECT — re-throw so Next.js
        // can handle the navigation.
        if ((err as { digest?: string })?.digest?.startsWith("NEXT_REDIRECT")) throw err;
        const statusCode = (err as { statusCode?: number })?.statusCode;
        if (statusCode === 403) {
          toast.error("You don't have permission to create a project at this ownership level.");
        } else {
          toast.error("Could not create project. Try again — if it keeps failing, the database may be unreachable.");
        }
      }
    });
  };

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="soft-panel rounded-panel p-6 flex flex-col gap-4"
      >
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Project name</FormLabel>
              <FormControl>
                <Input
                  placeholder="e.g. Q3 outbound campaign"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Description</FormLabel>
              <FormControl>
                <Textarea
                  rows={3}
                  placeholder="What is this project for? (optional)"
                  {...field}
                  value={field.value ?? ""}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="ownerLevel"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Ownership level</FormLabel>
              <p className="text-xs text-muted-foreground">
                Who owns this project. Pick the smallest scope it needs — ratchet upward later, never down.
              </p>
              <FormControl>
                <RadioGroup
                  value={field.value}
                  onValueChange={(v) => {
                    field.onChange(v);
                    // Reset secondary picker when ownership changes.
                    // Use unregister to drop the secondary field from the form state cleanly
                    // when the discriminated-union branch changes — this avoids the `as never`
                    // typing workaround required by setValue across union branches.
                    if (v !== "team") form.unregister("teamId");
                    if (v !== "organization") form.unregister("organizationId");
                  }}
                  className="grid sm:grid-cols-3 gap-3"
                >
                  <Label className="soft-panel rounded-control p-3 flex items-start gap-2 cursor-pointer">
                    <RadioGroupItem value="user" />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium text-foreground">Just me</span>
                      <span className="text-xs text-muted-foreground">User-level ownership.</span>
                    </span>
                  </Label>
                  <Label className="soft-panel rounded-control p-3 flex items-start gap-2 cursor-pointer">
                    <RadioGroupItem value="team" />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium text-foreground">A team</span>
                      <span className="text-xs text-muted-foreground">Team-level ownership.</span>
                    </span>
                  </Label>
                  <Label className="soft-panel rounded-control p-3 flex items-start gap-2 cursor-pointer">
                    <RadioGroupItem value="organization" />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium text-foreground">The organization</span>
                      <span className="text-xs text-muted-foreground">Org-level ownership.</span>
                    </span>
                  </Label>
                </RadioGroup>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {ownerLevel === "team" && (
          <FormField
            control={form.control}
            name={"teamId" as const}
            render={({ field }) => (
              <FormItem>
                <FormLabel>Team</FormLabel>
                <FormControl>
                  <Select value={field.value ?? ""} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a team" />
                    </SelectTrigger>
                    <SelectContent>
                      {teams.length === 0 ? (
                        <div className="text-xs text-muted-foreground px-2 py-1.5">
                          You&apos;re not a member of any team yet. Pick &quot;Just me&quot; or &quot;The organization&quot; instead.
                        </div>
                      ) : (
                        teams.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name} — {t.orgName}
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        {ownerLevel === "organization" && (
          <FormField
            control={form.control}
            name={"organizationId" as const}
            render={({ field }) => (
              <FormItem>
                <FormLabel>Organization</FormLabel>
                <FormControl>
                  <Select value={field.value ?? ""} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select an organization" />
                    </SelectTrigger>
                    <SelectContent>
                      {organizations.length === 0 ? (
                        <div className="text-xs text-muted-foreground px-2 py-1.5">
                          You&apos;re not a member of any organization yet. Pick &quot;Just me&quot; or &quot;A team&quot; instead.
                        </div>
                      ) : (
                        organizations.map((o) => (
                          <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        <FormField
          control={form.control}
          name="visibility"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Visibility</FormLabel>
              <FormControl>
                <RadioGroup
                  value={field.value}
                  onValueChange={field.onChange}
                  className="grid sm:grid-cols-2 gap-3"
                >
                  <Label className="soft-panel rounded-control p-3 flex items-start gap-2 cursor-pointer">
                    <RadioGroupItem value="private" />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium text-foreground">Private</span>
                      <span className="text-xs text-muted-foreground">Only you and explicit collaborators can see it.</span>
                    </span>
                  </Label>
                  <Label className="soft-panel rounded-control p-3 flex items-start gap-2 cursor-pointer">
                    <RadioGroupItem value="discoverable" />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium text-foreground">Discoverable</span>
                      <span className="text-xs text-muted-foreground">Members of the owning scope can find and view it.</span>
                    </span>
                  </Label>
                </RadioGroup>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="ghost" asChild>
            <Link href="/projects">Cancel</Link>
          </Button>
          <Button type="submit" disabled={isPending}>
            {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Create project
          </Button>
        </div>
      </form>
    </Form>
  );
}
