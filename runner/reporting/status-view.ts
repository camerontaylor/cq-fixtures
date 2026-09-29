// PK14 / D77: correction-aware status view, one dimension at a time.
//
// The D77 finding is that hand-written narrative (STATUS.md "Validity state")
// kept saying "pending" after newer immutable audits existed, and that one
// sentence stood in for three routes with materially different states. This
// module makes the view a PROJECTION of cited immutable records instead, so
// prose becomes a diff target rather than a source of truth.
//
// Four dimensions are kept separate and are never collapsed into one verdict:
//
//   codeFixed              a source correction exists at a cited commit
//   developmentTested      a named check passed on a cited source/runtime
//   actualRouteQualified   an actual model/profile/task/route epoch has receipts
//   campaignComplete       EVERY mandatory campaign criterion is satisfied
//
// A scoped route pass NEVER implies campaign completion, a development worker's
// consumption is never an evaluation observation, and a dimension with no cited
// record is `null` (unknown) with a reason - never `false`, never `0`.

import type { ArtifactBinding } from './types.ts';

export const ROUTE_DIMENSIONS = ['codeFixed', 'developmentTested', 'actualRouteQualified', 'campaignComplete'] as const;
export type RouteDimension = (typeof ROUTE_DIMENSIONS)[number];

/** tri-state: true / false / null(unknown). null and false are never merged. */
export type DimensionValue = boolean | null;

export interface DimensionState {
  value: DimensionValue;
  /** Cited immutable records, in the order they were supplied. */
  evidence: ArtifactBinding[];
  /** Authentic deciding-record timestamps, or null when unrecorded. */
  recordedAt: Array<string | null>;
  /** Always populated when value is null, and when a conflict was resolved. */
  reason: string | null;
}

export interface RouteView {
  route: string;
  /**
   * `actual` = an actual model/profile/task route.
   * `shared-condition` = the shared harness comparison lane.
   * `development` = a development worker lane, which is not an evaluation
   * observation and can never satisfy `actualRouteQualified`.
   */
  lane: 'actual' | 'shared-condition' | 'development';
  dimensions: Record<RouteDimension, DimensionState>;
}

/** One asserted dimension backed by exactly one cited immutable record. */
export interface DimensionClaim {
  dimension: RouteDimension;
  value: boolean | null;
  record: ArtifactBinding;
  recordedAt?: string | null;
  /** The scope the claim covers, e.g. "final-container Codex assignment". */
  scope?: string;
}

export interface RouteInput {
  route: string;
  lane: RouteView['lane'];
  claims: DimensionClaim[];
}

export interface StatusViewInput {
  /**
   * Explicit as-of instant for the whole view. A required input: this module
   * never reads a wall clock, so the projection is reproducible.
   */
  asOf: string;
  routes: RouteInput[];
  /**
   * Explicit campaign-completion claim. Absent means the campaign dimension is
   * unknown; per-route qualification is never promoted into it.
   */
  campaign?: DimensionClaim;
}

export interface StatusView {
  asOf: string;
  routes: RouteView[];
  campaignComplete: DimensionState;
  /**
   * Records that were supplied but could not be used, with the reason. Rendered
   * so an unresolved dimension is visible rather than silently null.
   */
  unresolved: Array<{ route: string; dimension: RouteDimension; reason: string }>;
}

function emptyState(): DimensionState {
  return { value: null, evidence: [], recordedAt: [], reason: 'no cited record' };
}

/**
 * Fold the claims for one dimension.
 *
 * Agreement keeps the value. Disagreement is a conflict: the dimension becomes
 * null with a reason naming the conflicting records. A dimension is never
 * resolved by preferring the newest record - recency is not authority, and the
 * D77 finding is precisely that a newer record must not silently overwrite an
 * older one without an explicit supersession.
 */
function foldClaims(claims: DimensionClaim[], dimension: RouteDimension, lane: RouteView['lane']): DimensionState {
  const usable = claims.filter((claim) => claim.dimension === dimension);
  if (usable.length === 0) return emptyState();

  if (dimension === 'actualRouteQualified' && lane === 'development') {
    return {
      value: null,
      evidence: usable.map((c) => c.record),
      recordedAt: usable.map((c) => c.recordedAt ?? null),
      reason: 'a development lane is not an evaluation observation; it cannot qualify an actual route',
    };
  }

  const values = new Set(usable.map((c) => c.value));
  const evidence = usable.map((c) => c.record);
  const recordedAt = usable.map((c) => c.recordedAt ?? null);
  if (values.size === 1) {
    const [value] = [...values];
    return { value, evidence, recordedAt, reason: null };
  }
  return {
    value: null,
    evidence,
    recordedAt,
    reason: `${usable.length} cited records disagree on ${dimension}; unresolved until an explicit supersession says which holds`,
  };
}

export function projectStatusView(input: StatusViewInput): StatusView {
  const routes: RouteView[] = input.routes.map((route) => ({
    route: route.route,
    lane: route.lane,
    dimensions: Object.fromEntries(
      ROUTE_DIMENSIONS.map((dimension) => [dimension, foldClaims(route.claims, dimension, route.lane)]),
    ) as Record<RouteDimension, DimensionState>,
  }));

  const unresolved: StatusView['unresolved'] = [];
  for (const route of routes) {
    for (const dimension of ROUTE_DIMENSIONS) {
      const state = route.dimensions[dimension];
      if (state.value === null) unresolved.push({ route: route.route, dimension, reason: state.reason ?? 'no cited record' });
    }
  }

  // Campaign completion is independent input only. Route qualification is a
  // NECESSARY but not SUFFICIENT condition, so an all-routes-passed view still
  // cannot raise it on its own.
  let campaignComplete: DimensionState;
  if (!input.campaign) {
    campaignComplete = { ...emptyState(), reason: 'no campaign-completion record supplied; route passes do not imply campaign completion' };
  } else if (input.campaign.dimension !== 'campaignComplete') {
    campaignComplete = { ...emptyState(), reason: `supplied claim is for ${input.campaign.dimension}, not campaignComplete` };
  } else {
    campaignComplete = {
      value: input.campaign.value,
      evidence: [input.campaign.record],
      recordedAt: [input.campaign.recordedAt ?? null],
      reason: input.campaign.value === false ? 'a cited record states the campaign is not complete' : null,
    };
  }

  const notQualified = routes.filter((r) => r.dimensions.actualRouteQualified.value !== true).map((r) => r.route);
  if (campaignComplete.value === true && notQualified.length > 0) {
    campaignComplete = {
      ...campaignComplete,
      value: null,
      reason: `campaign-completion record conflicts with unqualified routes: ${notQualified.join(', ')}`,
    };
  }

  return { asOf: input.asOf, routes, campaignComplete, unresolved };
}

/** A compact, stable, one-line-per-route rendering. Never the source of truth. */
export function renderStatusLines(view: StatusView): string[] {
  const cell = (state: DimensionState): string => {
    if (state.value === null) return 'unknown';
    return state.value ? 'yes' : 'no';
  };
  const lines = view.routes.map((route) => {
    const d = route.dimensions;
    return [
      route.route,
      `lane=${route.lane}`,
      `codeFixed=${cell(d.codeFixed)}`,
      `developmentTested=${cell(d.developmentTested)}`,
      `actualRouteQualified=${cell(d.actualRouteQualified)}`,
      `campaignComplete=${cell(d.campaignComplete)}`,
    ].join(' | ');
  });
  lines.push(`campaign | campaignComplete=${cell(view.campaignComplete)}`);
  return lines;
}
