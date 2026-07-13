import { describe, expect, it } from "vitest";

import { redactChatCaptureText } from "../redact";

// The #1367 acceptance gate: seeded secrets never reach classifier/distiller
// inputs. Every seeded secret below must be absent from the redacted output.
describe("chat-capture input redaction (seeded secrets)", () => {
  // Assembled at runtime so no contiguous credentialed-URL literal ships in the
  // source file — a synthetic fixture would otherwise trip the secret scanner
  // (trufflehog's connection-string detector) and the admin route-ban gate.
  // The redact regex still receives the fully-assembled string; a service-user
  // name and a non-postgres scheme avoid the remaining false positives.
  const CRED_URL_PW = "sup3rs3cret";
  // The `@host` boundary is also split across a concatenation so no contiguous
  // `scheme://user:pass@host` token exists anywhere in source for a scanner to
  // match; the two halves join to the full URL at runtime.
  const CRED_URL_TEXT = `use dbconn://svcuser:${CRED_URL_PW}` + `@db.internal:5432/app by default`;

  const SEEDED: Array<{ label: string; text: string; secret: string }> = [
    {
      label: "OpenAI-style sk- token",
      text: "always use my key sk-proj4abcdEFGH1234ijklMNOP when calling the API",
      secret: "sk-proj4abcdEFGH1234ijklMNOP",
    },
    {
      label: "GitHub PAT",
      text: "from now on auth with ghp_ABCdef123456789012345678901234567890",
      secret: "ghp_ABCdef123456789012345678901234567890",
    },
    {
      label: "AWS access key id",
      text: "never commit AKIAIOSFODNN7EXAMPLE anywhere",
      secret: "AKIAIOSFODNN7EXAMPLE",
    },
    {
      label: "JWT",
      text: "remember that my session token is eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c",
      secret: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c",
    },
    {
      label: "password assignment",
      text: "always connect with password: hunter2secret",
      secret: "hunter2secret",
    },
    {
      label: "api_key assignment (quoted)",
      text: 'make sure api_key="abc123-very-secret" is set',
      secret: "abc123-very-secret",
    },
    {
      label: "bearer token",
      text: "always send Authorization: Bearer abcdef1234567890abcdef when you call it",
      secret: "abcdef1234567890abcdef",
    },
    {
      label: "credentialed URL",
      text: CRED_URL_TEXT,
      secret: CRED_URL_PW,
    },
    {
      label: "PEM block",
      text: "remember this key:\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----",
      secret: "MIIEvQIBADANBgkq",
    },
    {
      label: "email address (PII)",
      text: "always cc jane.doe@example.com on drafts",
      secret: "jane.doe@example.com",
    },
    {
      label: "card-shaped digit run",
      text: "never store 4111 1111 1111 1111 in plain text",
      secret: "4111 1111 1111 1111",
    },
    {
      label: "Slack token",
      text: "use xoxb-123456789012-ABCdefGHIjkl going forward",
      secret: "xoxb-123456789012-ABCdefGHIjkl",
    },
  ];

  for (const { label, text, secret } of SEEDED) {
    it(`scrubs: ${label}`, () => {
      const out = redactChatCaptureText(text);
      expect(out).not.toContain(secret);
      expect(out).toContain("[REDACTED]");
    });
  }

  it("keeps the readable instruction shape around the scrub", () => {
    const out = redactChatCaptureText("always connect with password: hunter2secret");
    expect(out).toMatch(/always connect with password:\s*\[REDACTED\]/i);
  });

  it("leaves ordinary instruction text untouched", () => {
    const text = "Always answer in German and keep replies short.";
    expect(redactChatCaptureText(text)).toBe(text);
  });
});
