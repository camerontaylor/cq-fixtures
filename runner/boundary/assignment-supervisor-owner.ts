import { AsyncLocalStorage } from 'node:async_hooks';
import type { AssignmentResource } from './assignment-supervisor.ts';

/** Internal executor scope. Legacy callers have no outer ownership guarantee. */
const ownership = new AsyncLocalStorage<(resource: AssignmentResource) => Promise<void>>();
export function assignmentResourceOwner(): (resource: AssignmentResource) => Promise<void> {
  return ownership.getStore() ?? (async () => {});
}
export function withAssignmentResourceOwner<T>(owner: (resource: AssignmentResource) => Promise<void>, run: () => Promise<T>): Promise<T> {
  return ownership.run(owner, run);
}
