// FIXTURE — ESLint should flag this. Imports bullmq from inside
// sdk-dashboard, which is forbidden by ADR 0044 (job orchestration is
// host-provided).
//
// eslint-disable-next-line no-unused-vars
import { Queue } from "bullmq";

export const used = Queue;
