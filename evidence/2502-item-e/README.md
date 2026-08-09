# cinatra#2502 item E — one primary Continue on `/setup/model`, rendered proof

Captured on the REAL running wizard with `CINATRA_E2E_SETUP_BYPASS` unset, at
the setup-acceptance suite's two widths (`--medium` 1440×1100, `--narrow` 600).
The contract is `specs/app-setup.html` revision 0.3.0 §I ("one primary action
per step") at design commit `052bfb5f5ec7545124e50d2adf656d9adc80eca1` — the
same pin the merged rail work (#2559) used.

Only the outbound HTTP boundary to `api.openai.com` / `api.anthropic.com` is
stubbed (`tests/e2e/setup/support/provider-boundary-stub.mjs`); the wizard, the
server actions, the S5 writer, the consent transaction, the S3 commit machine
and Postgres are all real. No live provider key exists on a lane host.

## The fold and its four refusals — `06-model-step-single-continue.spec.ts`

| Capture | What it shows |
| --- | --- |
| `2502e-01-one-primary-continue` | §I — the step's ONE action. The key field sits inside the Continue form (containment measured on the live DOM), Continue is the only submit on the step, right-aligned with the forward arrow. There is no Save. |
| `2502e-02-key-refused-inline` | **key refused** — the connector rejected the key. The sanitized reason renders inline on the field (§I) as well as in the toast, the URL is still exactly `/setup/model?stay=1`, nothing is committed, and the operator's typed key is still in the field. |
| `2502e-03-consent-declined` | **consent declined** — submitted with the form's client-side validation disabled, so the refusal is the SERVER's. No credential row, no workspace opt-in, no commitment: the consent is an operator act and a key never implies it. |
| `2502e-04-commit-refused-fence` | **commit refused** — a claim taken after the page rendered (the stale-tab case). The fold reads the fence BEFORE touching the credential, so the in-flight run's key is not changed underneath it; the step re-renders identifier-free and read-only. |
| `2502e-05-saved-but-unconfirmed` | **saved but unconfirmed** — a key that stores and validates on an account with no model entitlements. The credential IS stored (saved alert) and the provider is NOT committed (standing failure alert); the wizard does not advance. Neither half is rounded off. |

## The happy path and the rest of the step — specs 01, 02, 03

| Capture | What it shows |
| --- | --- |
| `04-openai-key-form` | The OpenAI step before the single press: key field, helper link, one Continue. |
| `05-openai-key-saved` | After that one press — the credential the same submission stored. |
| `06-openai-committed-locked` | …and the provider committed by the same press: the other card is de-emphasized and non-interactive. |
| `07-anthropic-form-consent` | The Anthropic step: key + the explicit skills-upload consent, both inside the Continue form. |
| `08-anthropic-key-save-failure-toast` | A consented Continue whose key the connection service rejects — typed channel, nothing in the URL, nothing committed. |
| `09-anthropic-connection-stored` | A ready stored connection: no key field, the Administration pointer, and Continue as the step's only action. |
| `10-anthropic-committed-locked` | The Anthropic commit through the same single press (native MCP set at commit). |
| `12-key-save-error-toast` | The S5 error channel, unchanged by the fold: sanitized toast, `/setup/model?stay=1` exactly. |

## Negative control

The §I arm was re-run against a deliberately reintroduced two-button layout (the
key field in its own form behind a `Save`, Continue in another). It FAILED on
the submit-label list — `["Save", "Continue"]` against the expected
`["Continue"]` — and passed again once the fold was restored. The arm detects
the shape it exists to forbid.
