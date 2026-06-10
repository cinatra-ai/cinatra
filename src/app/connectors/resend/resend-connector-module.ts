// The host↔connector data contract for the Resend mount: the export shape the
// legacy /connectors/resend surfaces consume from the connector's
// manifest-resolved server module.
export type ResendConnectorModule = {
  getResendConfig: () => {
    enabled: boolean;
    fromEmail: string;
    fromName: string;
    replyTo: string;
    hasApiKeyOverride: boolean;
  };
  getResendStatus: () => {
    status: "connected" | "incomplete" | "not_connected";
    accountEmail?: string;
    detail?: string;
  };
  saveResendConfig: (input: {
    enabled?: boolean;
    fromEmail?: string;
    fromName?: string;
    replyTo?: string;
    apiKey?: string;
    clearApiKey?: boolean;
  }) => void;
  buildResendFrom: (fromName: string, fromEmail: string) => string;
  sendViaResend: (input: {
    from: string;
    to: string[];
    subject: string;
    text: string;
    replyTo?: string;
  }) => Promise<{ id: string }>;
};
