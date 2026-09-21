export function nextState(state: string): string {
  if (state === 'pending') return 'running';
  if (state === 'running') return 'done';
  return state;
}
