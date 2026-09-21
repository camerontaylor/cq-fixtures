export function nextState(state: string): string {
  if (state === 'queued') return 'running';
  if (state === 'running') return 'done';
  return state;
}
