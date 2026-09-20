import { backoffDelay } from './backoff.ts';

export function retryPlan(baseMs: number, attempts: number): number[] {
  const plan: number[] = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    plan.push(backoffDelay(baseMs, attempt));
  }
  return plan;
}
