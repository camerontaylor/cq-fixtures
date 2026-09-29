// PK14 / D77: the deterministic, correction-aware board.
//
// The orchestrator's finish step requires a timestamped board that shows
// code-fixed, development-tested, route-qualified, limitation and
// campaign-complete SEPARATELY. This module builds that projection from cited
// immutable records; it does not summarise prose and it does not decide.
//
// Reproducibility: `generatedAt` is derived from the newest timestamp among the
// cited records, or from an explicit as-of input when no record carries a
// timestamp. The wall clock is never read, so two runs over the same evidence
// produce byte-identical output. Legacy records carry no timestamp, so a board
// over them is stamped with the explicit as-of input and says so.

import { projectStatusView, ROUTE_DIMENSIONS, type DimensionState, type StatusView, type StatusViewInput } from './status-view.ts';
import { retentionIsFullyAccountedFor, type RetentionView } from './retention.ts';
import type { SelectionResult } from './corrections.ts';
import type { Disposition, RetentionState, ResourceKind } from './types.ts';

export const BOARD_SCHEMA_VERSION = 1;

const RETENTION_KINDS: ResourceKind[] = ['patch', 'auth', 'fullCandidate', 'taskVolume', 'contextVolume', 'publishedHost'];

export interface BoardCorrectionLine {
  runId: string;
  status: SelectionResult['status'];
  /** Fields whose value came from a qualified correction. */
  correctedFields: string[];
  /** Known-applicable claims deliberately not asserted. */
  withheld: SelectionResult['withheld'];
  originalRef: { path: string; sha256: string } | null;
}

export interface BoardRetentionLine {
  runId: string;
  /** Retained/absent/unknown per resource; `unknown` is never rendered as 0. */
  resources: Record<ResourceKind, RetentionState>;
  unaccounted: ResourceKind[];
  conflatedField: { field: string; value: unknown } | null;
}

export interface BoardDimension {
  dimension: string;
  yes: string[];
  no: string[];
  unknown: Array<{ route: string; reason: string }>;
}

export interface CorrectionAwareBoard {
  schemaVersion: number;
  /** Derived, never a wall clock. */
  generatedAt: string;
  /** True when generatedAt came from an explicit as-of input, not a record. */
  generatedAtIsAsOfFallback: boolean;
  asOf: string;
  dimensions: BoardDimension[];
  corrections: BoardCorrectionLine[];
  retention: BoardRetentionLine[];
  campaignComplete: { value: boolean | null; reason: string | null; evidence: string[] };
  limitations: string[];
}

export interface BuildBoardInput {
  /** Explicit as-of instant; required, and never replaced by a clock read. */
  asOf: string;
  status: StatusViewInput;
  corrections?: SelectionResult[];
  retention?: RetentionView[];
  /** Dispositions to surface as open items, newest first as supplied. */
  limitations?: string[];
}

function newestTimestamp(values: Array<string | null>): string | null {
  const present = values.filter((v): v is string => typeof v === 'string' && v.length > 0).sort();
  return present.length > 0 ? present[present.length - 1] : null;
}

function dispositionSummary(dispositions: Disposition[]): string[] {
  return dispositions.map((d) => `${d.status}:${d.reason}`);
}

/**
 * Build the board. Deterministic: the same evidence yields the same bytes.
 */
export function buildCorrectionAwareBoard(input: BuildBoardInput): CorrectionAwareBoard {
  const view: StatusView = projectStatusView(input.status);
  const corrections = input.corrections ?? [];
  const retention = input.retention ?? [];

  // generatedAt is derived from the newest RECORD timestamp. The explicit as-of
  // input is only a fallback, and the board says which one it used.
  const recordTimestamps = [
    ...view.routes.flatMap((route) => ROUTE_DIMENSIONS.flatMap((d) => route.dimensions[d].recordedAt)),
    ...view.campaignComplete.recordedAt,
    ...corrections.flatMap((c) => c.provenance.map((p) => p.recordedAt)),
  ];
  const newest = newestTimestamp(recordTimestamps);
  const generatedAt = newest ?? view.asOf;

  const dimensionLine = (dimension: string, states: Array<{ route: string; state: DimensionState }>): BoardDimension => ({
    dimension,
    yes: states.filter((s) => s.state.value === true).map((s) => s.route),
    no: states.filter((s) => s.state.value === false).map((s) => s.route),
    unknown: states
      .filter((s) => s.state.value === null)
      .map((s) => ({ route: s.route, reason: s.state.reason ?? 'no cited record' })),
  });

  const dimensions: BoardDimension[] = ROUTE_DIMENSIONS.map((dimension) =>
    dimensionLine(dimension, view.routes.map((route) => ({ route: route.route, state: route.dimensions[dimension] }))),
  );
  dimensions.push(dimensionLine('campaignComplete', [{ route: 'campaign', state: view.campaignComplete }]));

  const retentionLines: BoardRetentionLine[] = retention.map((view_) => ({
    runId: view_.runId,
    resources: Object.fromEntries(RETENTION_KINDS.map((kind) => [kind, view_.resources[kind].state])) as Record<ResourceKind, RetentionState>,
    unaccounted: RETENTION_KINDS.filter((kind) => view_.resources[kind].state === 'unknown'),
    conflatedField: view_.conflatedField ?? null,
  }));

  return {
    schemaVersion: BOARD_SCHEMA_VERSION,
    generatedAt,
    generatedAtIsAsOfFallback: newest === null,
    asOf: view.asOf,
    dimensions,
    corrections: corrections.map((selection) => ({
      runId: selection.runId,
      status: selection.status,
      correctedFields: Object.entries(selection.projection)
        .filter(([, field]) => field.origin === 'correction')
        .map(([name]) => name)
        .sort(),
      withheld: selection.withheld,
      originalRef: selection.originalRef ? { path: selection.originalRef.path, sha256: selection.originalRef.sha256 } : null,
    })),
    retention: retentionLines,
    campaignComplete: {
      value: view.campaignComplete.value,
      reason: view.campaignComplete.reason,
      evidence: view.campaignComplete.evidence.map((e) => `${e.path}@${e.sha256}`),
    },
    limitations: input.limitations ?? [],
  };
}

/**
 * Render the board as markdown. This text is a DIFF TARGET for narrative
 * documents such as STATUS.md: if the prose disagrees with this rendering, the
 * prose is what is stale, and the cited records decide.
 */
export function renderBoardMarkdown(board: CorrectionAwareBoard): string {
  const lines: string[] = [];
  lines.push(`# Correction-aware board (generated ${board.generatedAt}${board.generatedAtIsAsOfFallback ? ', as-of fallback' : ''})`);
  lines.push('');
  lines.push('| dimension | yes | no | unknown |');
  lines.push('| --- | --- | --- | --- |');
  for (const dimension of board.dimensions) {
    const unknown = dimension.unknown.map((u) => `${u.route} (${u.reason})`);
    lines.push(`| ${dimension.dimension} | ${dimension.yes.join(', ') || '—'} | ${dimension.no.join(', ') || '—'} | ${unknown.join('; ') || '—'} |`);
  }
  lines.push('');
  if (board.corrections.length > 0) {
    lines.push('## Corrections');
    for (const correction of board.corrections) {
      lines.push(`- ${correction.runId}: ${correction.status}; corrected: ${correction.correctedFields.join(', ') || 'none'}`);
      for (const withheld of correction.withheld) {
        lines.push(`  - withheld ${withheld.field}: ${withheld.reason}`);
      }
    }
    lines.push('');
  }
  if (board.retention.length > 0) {
    lines.push('## Retention by resource type');
    for (const line of board.retention) {
      const cells = RETENTION_KINDS.map((kind) => `${kind}=${line.resources[kind]}`).join(', ');
      lines.push(`- ${line.runId}: ${cells}`);
      if (line.unaccounted.length > 0) lines.push(`  - unaccounted (unknown, not zero): ${line.unaccounted.join(', ')}`);
      if (line.conflatedField) {
        lines.push(`  - historical conflated field ${line.conflatedField.field}=${String(line.conflatedField.value)} is not a per-resource state`);
      }
    }
    lines.push('');
  }
  lines.push(`## Campaign complete: ${board.campaignComplete.value === null ? 'unknown' : String(board.campaignComplete.value)}`);
  if (board.campaignComplete.reason) lines.push(`- ${board.campaignComplete.reason}`);
  if (board.limitations.length > 0) {
    lines.push('');
    lines.push('## Limitations');
    for (const limitation of board.limitations) lines.push(`- ${limitation}`);
  }
  return lines.join('\n');
}

export { retentionIsFullyAccountedFor, dispositionSummary };
