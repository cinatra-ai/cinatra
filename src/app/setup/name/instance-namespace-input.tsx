"use client";

// -----------------------------------------------------------------------------
// Setup wizard instance namespace input client island.
//
// Live validation as the user types. After first blur, every onChange runs the
// shared validator and updates inline error / canonical preview /
// submit-disabled state. Coexists with the locked warning Alert above the
// Input — see ../setup/name/page.tsx for the surrounding stacking order.
//
// The native HTML `pattern` attribute on <Input> is kept as defense-in-depth.
// The server-side validation gate is the real security boundary.
//
// Submit-button state sharing: the Continue button lives outside this island
// in page.tsx. We expose it via NamespaceValidationContext and a small
// NamespaceValidationProvider so a sibling client wrapper around the button
// can read isValid without prop-drilling through the server component.
// -----------------------------------------------------------------------------

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useFormStatus } from "react-dom";

import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  validateInstanceNamespace,
  NAMESPACE_FORMAT_REGEX_SOURCE,
  type NamespaceValidationError,
} from "@/lib/instance-namespace";

// -----------------------------------------------------------------------------
// Context — published validity for the sibling Continue button (page.tsx).
// -----------------------------------------------------------------------------

type NamespaceValidationContextValue = {
  isValid: boolean;
};

const NamespaceValidationContext = createContext<NamespaceValidationContextValue>({
  // SSR default: block submit until the provider supplies a real validation
  // result. The provider's first render computes
  // validateInstanceNamespace(initialValue), so an empty initialValue yields
  // { ok: false } and the SubmitButtonGate renders the Continue button
  // disabled in the SSR HTML — matching the client-side hydration result
  // (no enabled→disabled flash). This createContext fallback is only used
  // when there is no Provider in the tree; flipping it to false is
  // defense-in-depth against rogue renders outside the provider.
  isValid: false,
});

export function NamespaceValidationProvider({
  initialValue,
  approvedExactNames = [],
  children,
}: {
  initialValue: string;
  // Config-file-driven approved namespaces, read server-side in page.tsx and
  // passed down so the client validator matches the server's authoritative gate.
  approvedExactNames?: readonly string[];
  children: ReactNode;
}) {
  // The provider also owns the input value so onChange can update both the
  // shared isValid state AND the visible Input. The Input is rendered by the
  // child <InstanceNamespaceInput /> which reads/writes via this provider.
  const [value, setValue] = useState(initialValue);
  const [hasBlurred, setHasBlurred] = useState(false);

  const result = useMemo(
    () => validateInstanceNamespace(value, { approvedExactNames }),
    [value, approvedExactNames],
  );
  const isValid = result.ok;

  const contextValue = useMemo<NamespaceValidationContextValue>(
    () => ({ isValid }),
    [isValid],
  );

  // Expose the imperative slots needed by InstanceNamespaceInput via a second
  // (private) context. Children components read these.
  return (
    <NamespaceValidationContext.Provider value={contextValue}>
      <NamespaceInternalContext.Provider
        value={{
          value,
          setValue,
          hasBlurred,
          setHasBlurred,
          result,
        }}
      >
        {children}
      </NamespaceInternalContext.Provider>
    </NamespaceValidationContext.Provider>
  );
}

export function useNamespaceValidation(): NamespaceValidationContextValue {
  return useContext(NamespaceValidationContext);
}

// -----------------------------------------------------------------------------
// Private context — internal state shared between provider and Input.
// -----------------------------------------------------------------------------

type InternalState = {
  value: string;
  setValue: (next: string) => void;
  hasBlurred: boolean;
  setHasBlurred: (next: boolean) => void;
  result: ReturnType<typeof validateInstanceNamespace>;
};

const NamespaceInternalContext = createContext<InternalState | null>(null);

function useInternal(): InternalState {
  const ctx = useContext(NamespaceInternalContext);
  if (!ctx) {
    throw new Error(
      "InstanceNamespaceInput must be rendered inside NamespaceValidationProvider",
    );
  }
  return ctx;
}

// -----------------------------------------------------------------------------
// InstanceNamespaceInput — the visible Input + inline error / canonical preview
// -----------------------------------------------------------------------------

// defaultValue is forwarded via NamespaceValidationProvider's initialValue — the island
// reads shared state from context and does not use the prop directly.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function InstanceNamespaceInput({ defaultValue: _ }: { defaultValue: string }) {
  const { value, setValue, hasBlurred, setHasBlurred, result } = useInternal();

  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setValue(e.target.value);
    },
    [setValue],
  );

  const onBlur = useCallback(() => {
    setHasBlurred(true);
  }, [setHasBlurred]);

  // UX gate: pre-blur quiet state. Show neither error nor preview until first blur.
  const showError = hasBlurred && !result.ok;
  const showPreview =
    hasBlurred && result.ok && result.canonical !== value && result.canonical !== "";

  return (
    <>
      <Input
        name="instanceNamespace"
        value={value}
        onChange={onChange}
        onBlur={onBlur}
        // Native HTML pattern stays as defense-in-depth.
        pattern={NAMESPACE_FORMAT_REGEX_SOURCE}
        aria-invalid={showError}
        minLength={2}
        maxLength={39}
        required
        autoComplete="off"
        placeholder="e.g. acme-group"
      />
      {showError ? (
        <NamespaceErrorMessage
          error={(result as { ok: false; canonical: string; error: NamespaceValidationError }).error}
        />
      ) : null}
      {showPreview ? (
        <span className="mt-1 text-xs font-normal text-muted-foreground">
          Will be saved as: <code>{result.canonical}</code>
        </span>
      ) : null}
    </>
  );
}

// -----------------------------------------------------------------------------
// NamespaceErrorMessage — renders the structured payload as user-facing copy
// -----------------------------------------------------------------------------

function NamespaceErrorMessage({ error }: { error: NamespaceValidationError }) {
  if (error.code === "required") {
    return (
      <span role="alert" className="mt-1 text-xs font-normal text-destructive">
        Instance namespace is required.
      </span>
    );
  }
  if (error.code === "format") {
    return (
      <span role="alert" className="mt-1 text-xs font-normal text-destructive">
        Use only lowercase letters (a–z), digits (0–9), and hyphens. Must start with a letter or
        digit and be 2–39 characters long.
      </span>
    );
  }
  // error.code === "reserved" — use the canonical restricted-namespace copy.
  return (
    <span role="alert" className="mt-1 text-xs font-normal text-destructive">
      Instance namespace &quot;{error.canonical}&quot; contains the reserved substring &quot;
      {error.reservedSubstring}&quot; and is restricted. Names containing &quot;
      {error.reservedSubstring}&quot; are reserved for Cinatra.ai-affiliated instances and require
      pre-registration. To request approval,{" "}
      {error.contact.href ? (
        <a
          href={error.contact.href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-destructive underline hover:text-destructive/80"
        >
          {error.contact.channel}
        </a>
      ) : (
        <span className="underline">{error.contact.channel}</span>
      )}
      .
    </span>
  );
}

// -----------------------------------------------------------------------------
// SubmitButtonGate — wraps the Continue button so it can read isValid.
// Exported so page.tsx can place it around the existing <Button> render.
// -----------------------------------------------------------------------------

export function SubmitButtonGate({ children }: { children: (disabled: boolean) => ReactNode }) {
  const { isValid } = useNamespaceValidation();
  return <>{children(!isValid)}</>;
}

// -----------------------------------------------------------------------------
// SubmitContinueButton — the Continue button must live INSIDE the form so
// useFormStatus() can read its pending lifecycle. Composes the
// namespace-validity gate with the form-pending gate so
// `disabled = !isValid || pending`. Renders <Spinner> in place of the trailing
// arrow during pending (saveInstanceIdentityAction can take seconds when the
// Verdaccio external HTTP path is slow).
// -----------------------------------------------------------------------------

export function SubmitContinueButton() {
  const { isValid } = useNamespaceValidation();
  const { pending } = useFormStatus();
  const disabled = !isValid || pending;
  return (
    <Button type="submit" disabled={disabled}>
      Continue
      {pending ? <Spinner /> : <ArrowRight className="size-4" />}
    </Button>
  );
}
