import type { Metadata } from "next";
import { ObjectsBrowserScreen } from "@cinatra-ai/objects";

export const metadata: Metadata = { title: "Data" };

type PageProps = {
  searchParams?: Promise<{
    type?: string;
    category?: string;
    confidence?: "high" | "low" | "dynamic";
    q?: string;
    selected?: string;
    family?: "assets" | "entities";
  }>;
};

export default async function ObjectsPage({ searchParams }: PageProps) {
  return (
    <ObjectsBrowserScreen searchParams={searchParams ?? Promise.resolve({})} />
  );
}
