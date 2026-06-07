import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

type DevelopmentLoggingSettingsPanelProps = {
  providers: Array<{
    id: "openai" | "anthropic" | "apollo" | "gemini" | "wordpress" | "linkedin" | "mcpServer" | "mcpClient";
    label: string;
    description: string;
    enabled: boolean;
    directory: string;
  }>;
  action: (formData: FormData) => void | Promise<void>;
  clearAction: (formData: FormData) => void | Promise<void>;
};

export function DevelopmentLoggingSettingsPanel({
  providers,
  action,
  clearAction,
}: DevelopmentLoggingSettingsPanelProps) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">API Logging</h2>
        </div>
        <p className="max-w-[64ch] text-sm leading-[1.55] text-pretty text-muted-foreground">
          Choose which provider request and response payloads Cinatra should persist locally for debugging.
        </p>
      </div>

      <form action={action} className="mt-6 flex flex-col gap-4">
        {providers.map((provider) => (
          <Label key={provider.id} className="flex items-start gap-3 rounded-control border border-line bg-surface-strong px-4 py-4">
            <input
              type="checkbox"
              name={`${provider.id}LoggingEnabled`}
              defaultChecked={provider.enabled}
              className="mt-1 h-4 w-4 rounded border-line text-foreground"
            />
            <span className="flex flex-col gap-1">
              <span className="text-sm font-semibold text-foreground">{provider.label}</span>
              <span className="text-sm leading-6 text-muted-foreground">{provider.description}</span>
              <code className="mt-1 rounded-control border border-line bg-surface-muted px-3 py-2 text-sm text-foreground">
                {provider.directory}
              </code>
            </span>
          </Label>
        ))}

        <div className="flex flex-wrap gap-3">
          <Button type="submit">Save logging administration</Button>
          <Button
            variant="destructive"
            formAction={clearAction}
            formNoValidate
          >
            Delete all log entries
          </Button>
        </div>
      </form>
    </section>
  );
}
