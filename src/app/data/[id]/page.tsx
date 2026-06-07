import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ObjectDetailPage } from "@cinatra-ai/objects";

export const metadata: Metadata = { title: "Data item" };

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ focus?: string }>;
};

// Reserved slugs that must not be interpreted as an object id. There is no
// "New data item" type-chooser route; without this guard the dynamic [id]
// segment would catch the "new" slug and render a soft "Data not found" page
// instead of 404ing.
const RESERVED_DATA_SLUGS = new Set(["new"]);

export default async function ObjectDetailRoute({
  params,
  searchParams,
}: PageProps) {
  const { id } = await params;
  if (RESERVED_DATA_SLUGS.has(id)) notFound();
  const sp = (await searchParams) ?? {};
  const focus = sp?.focus === "history" ? "history" : undefined;
  return <ObjectDetailPage id={id} focus={focus} />;
}
