import type { Metadata } from "next";
import { ObjectTypesScreen } from "@cinatra-ai/objects";

export const metadata: Metadata = { title: "Data types" };

export default function ObjectTypesPage() {
  return <ObjectTypesScreen />;
}
