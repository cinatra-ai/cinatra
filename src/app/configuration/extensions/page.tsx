import { RegistryCatalogScreen } from "@cinatra-ai/extensions/screens";

export default async function ExtensionsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <RegistryCatalogScreen searchParams={searchParams} />;
}
