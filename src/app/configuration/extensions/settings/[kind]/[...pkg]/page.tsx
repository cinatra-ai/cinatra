import { ExtensionSettingsScreen } from "@cinatra-ai/extensions/screens";

// Per-extension Settings page (design §V), opened from an installed card's
// Settings action. `[kind]` is the extension kind; `[...pkg]` is the package
// name split on its own `/` (a scoped `@vendor/name` arrives as two segments),
// re-joined here.
export default async function ExtensionSettingsPage({
  params,
}: {
  params: Promise<{ kind: string; pkg: string[] }>;
}) {
  const { kind, pkg } = await params;
  const packageName = (pkg ?? []).map((s) => decodeURIComponent(s)).join("/");
  return <ExtensionSettingsScreen kind={kind} packageName={packageName} />;
}
