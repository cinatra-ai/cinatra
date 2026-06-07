"use client";

export type BackgroundProcessRunStatus =
  | "idle"
  | "running"
  | "succeeded"
  | "failed"
  | "stopped";

export type BackgroundProcessSaveStatus =
  | "idle"
  | "running"
  | "saved"
  | "error"
  | "stopped";

export type BackgroundProcessState<TStatus extends string = string> = {
  status: TStatus;
  message: string;
  updatedAt: string;
  jobId?: string;
};

export type BackgroundProcessJobState<TStatus extends string = string> =
  BackgroundProcessState<TStatus> & {
    phase?: string;
  };

export type BackgroundProcessPromptState<TStatus extends string = BackgroundProcessSaveStatus> = {
  status: TStatus;
  message?: string;
};
