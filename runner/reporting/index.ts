// PK14 barrel. Correction-aware reporting sidecar for D22 and D77.
//
// CONSUMPTION STATUS: not wired. Nothing in runner/index.ts or
// runner/aggregate.ts imports this module, and no emitted result row or
// comparison table carries a correction today. Reports will NOT consume these
// projections until the conductor grants the serialized PK02/PK03 wiring lease
// recorded as SEAM-1 and SEAM-2 in the PK14 reconciliation handoff. Until then
// this is source proof for the module, not a claim of report consumption, and
// not evidence for any campaign acceptance criterion.

export * from './types.ts';
export * from './corrections.ts';
export * from './correction-binding.ts';
export * from './retention.ts';
export * from './status-view.ts';
export * from './board.ts';
export * from './manifest.ts';
