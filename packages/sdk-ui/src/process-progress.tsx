import { LoadingSpinner } from "./loading-spinner";

export type ProcessProgressStep = {
  id: string;
  label: string;
  status: "pending" | "running" | "completed" | "failed";
  detail?: string;
};

function PendingStepIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5 text-muted-foreground" aria-hidden="true">
      <circle
        cx="12"
        cy="12"
        r="8"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeDasharray="3 3.6"
      />
    </svg>
  );
}

function CompletedStepIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5 text-foreground" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="currentColor" />
      <path d="m8 12.5 2.5 2.5L16.5 9" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FailedStepIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5 text-destructive" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="currentColor" />
      <path d="M9 9 15 15" stroke="white" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M15 9 9 15" stroke="white" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function StepIcon({ status }: { status: ProcessProgressStep["status"] }) {
  if (status === "running") {
    return <LoadingSpinner className="h-5 w-5 text-foreground" />;
  }
  if (status === "completed") {
    return <CompletedStepIcon />;
  }
  if (status === "failed") {
    return <FailedStepIcon />;
  }
  return <PendingStepIcon />;
}

export function ProcessProgressList({
  steps,
  className = "",
}: {
  steps: ProcessProgressStep[];
  className?: string;
}) {
  return (
    <div className={`rounded-panel border border-line bg-surface-strong px-5 py-4 ${className}`}>
      <div className="grid gap-4">
        {steps.map((step) => {
          return (
            <div key={step.id} className="flex items-start gap-3">
              <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
                <StepIcon status={step.status} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-medium leading-6 text-foreground">{step.label}</div>
                {step.detail ? <p className="mt-0.5 text-sm leading-6 text-muted-foreground">{step.detail}</p> : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
