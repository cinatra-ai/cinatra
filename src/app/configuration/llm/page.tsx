// `/configuration/llm` — the LLM APIs page. The route file owns the gate
// (cinatra#2700, epic #2699): `/configuration` is the platform-admin area
// throughout, and the gate has to sit on the page entry point because a
// segment layout is not re-rendered on a soft navigation.
import APIsPage from "@/app/configuration/llm/apis-page";
import { requireAdminSession } from "@/lib/auth-session";

export { metadata } from "@/app/configuration/llm/apis-page";

export default async function SettingsLlmPage(props: Parameters<typeof APIsPage>[0]) {
  await requireAdminSession();
  return <APIsPage {...props} />;
}
