/** Native side of the actual-route G2 sentinel receipt. Missing tool channels fail closed. */
import type { SupervisedInvocationIdentity } from './process.ts';

export type G2ToolKind = 'read' | 'search' | 'shell' | 'http' | 'config';
export type G2ToolOutcome = 'denied' | 'success' | 'unavailable' | 'unknown';
export type G2DenialKind = 'filesystem-denied' | 'not-found' | 'broker-403' | 'namespace-denied' | 'guardian-not-visible' | 'config-inventory-verified';
export type G2TerminalState = 'exit' | 'timeout' | 'cancelled' | 'spawn-error';
export type G2ToolErrorCode = 'EACCES' | 'EPERM' | 'ENOENT';
export type G2ControlProof = { kind: 'guardian-namespace-absent' | 'native-inventory-verified' | 'namespace-egress-denied'; verified: true };

/** Private stdout/stderr buffers stay attached to the raw receipt, never normalized into public output. */
export interface NativeToolTraceEvent {
  eventId: string;
  invocationId: string;
  collectorSequence: number;
  phase: 'start' | 'result';
  kind: G2ToolKind;
  targetOrCommand: string;
  correlationId: string;
  at: string;
  /** Raw Codex command_execution status is private protocol evidence, not model prose. */
  toolStatus?: string;
  /** Exact item.exit_code including null; null never becomes zero. */
  toolExitCode?: number | null;
  /** Codex combines command streams in aggregated_output; retain these bytes privately as stdout slot for boundary scanning. */
  outputSource?: 'aggregated_output';
  outcome?: {
    disposition: G2ToolOutcome;
    denialKind?: G2DenialKind;
    exitCode?: number;
    httpStatus?: number;
    toolErrorCode?: G2ToolErrorCode;
    controlProof?: G2ControlProof;
  };
  stdout?: Uint8Array;
  stderr?: Uint8Array;
}

export interface NativeExecutionReceipt {
  identity: SupervisedInvocationIdentity;
  launch: { boundaryIdentity: string; launchIdentity: string; admissionId: string; profileInvocationIdentity?: string };
  terminal: { state: G2TerminalState; code: number | null; signal: string | null };
  /** Completeness of correlated tool start/result records, independent of invocation terminal/teardown. */
  toolPhase: { state: 'complete' | 'unavailable'; itemCount: number };
  decoderFailures: readonly string[];
  toolTrace: readonly NativeToolTraceEvent[];
  teardown: {
    processTree: 'stopped-and-reaped' | 'unproven';
    boundary: 'terminated' | 'unproven';
    export: { inventoryHash: string; head: string } | null;
  };
}

/** Structural mirror of runner/boundary/g2-harness.ts G2CanonicalNativeReceipt. */
export interface BoundaryCanonicalNativeReceipt {
  identity: SupervisedInvocationIdentity;
  launch: { boundaryIdentity: string; launchIdentity: string; admissionId: string };
  terminal: { state: G2TerminalState };
  toolPhase: { state: 'complete' | 'unavailable'; itemCount: number };
  decoderFailures: readonly string[];
  toolTrace: Array<{
    eventId: string; invocationId: string; collectorSequence: number; at: string; phase: 'start' | 'result'; kind: G2ToolKind;
    targetOrCommand: string; correlationId: string; toolStatus?: string; toolExitCode?: number | null;
    outputSource?: 'aggregated_output'; stdout?: Uint8Array; stderr?: Uint8Array;
    outcome?: NonNullable<NativeToolTraceEvent['outcome']>;
  }>;
  teardown?: {
    processTree: 'stopped-and-reaped'; boundary: 'terminated';
    export?: { inventoryHash: string; head: string };
  };
}

/** Copy the private native receipt into the exact boundary canonical field shape. */
export function toBoundaryCanonicalNativeReceipt(
  receipt: NativeExecutionReceipt,
  fixture?: G2ProbeFixture,
  controlVerifier?: G2ControlVerifier,
): BoundaryCanonicalNativeReceipt {
  const validationFailures = validateNativeToolPhase(receipt);
  for (const event of receipt.toolTrace) {
    if (event.phase !== 'result' || event.outcome?.disposition !== 'denied') continue;
    const probe = fixture?.expected.find((item) => item.correlationId === event.correlationId);
    if (!probe || probe.kind !== event.kind || probe.targetOrCommand !== event.targetOrCommand ||
        controlVerifier?.verifyDenialEvidence({ probe, event }) !== true) validationFailures.push('denial-control-unverified');
  }
  if (validationFailures.length > 0) throw new Error(`native tool receipt is not canonically decodable: ${validationFailures.join(',')}`);
  const teardown = receipt.teardown.processTree === 'stopped-and-reaped' && receipt.teardown.boundary === 'terminated'
    ? { processTree: 'stopped-and-reaped' as const, boundary: 'terminated' as const,
      ...(receipt.teardown.export ? { export: { ...receipt.teardown.export } } : {}) }
    : undefined;
  return {
    identity: { ...receipt.identity },
    launch: { boundaryIdentity: receipt.launch.boundaryIdentity, launchIdentity: receipt.launch.launchIdentity, admissionId: receipt.launch.admissionId },
    terminal: { state: receipt.terminal.state },
    toolPhase: { ...receipt.toolPhase },
    decoderFailures: [...receipt.decoderFailures],
    toolTrace: receipt.toolTrace.map((event) => ({
      eventId: event.eventId, invocationId: event.invocationId, collectorSequence: event.collectorSequence, at: event.at,
      phase: event.phase, kind: event.kind, targetOrCommand: event.targetOrCommand, correlationId: event.correlationId,
      ...(event.toolStatus === undefined ? {} : { toolStatus: event.toolStatus }),
      ...(event.toolExitCode === undefined ? {} : { toolExitCode: event.toolExitCode }),
      ...(event.outputSource === undefined ? {} : { outputSource: event.outputSource }),
      ...(event.stdout === undefined ? {} : { stdout: event.stdout }),
      ...(event.stderr === undefined ? {} : { stderr: event.stderr }),
      ...(event.outcome === undefined ? {} : { outcome: { ...event.outcome } }),
    })),
    ...(teardown ? { teardown } : {}),
  };
}

export interface G2ProbeFixture {
  id: string;
  prompt: string;
  expected: ReadonlyArray<{ correlationId: string; kind: G2ToolKind; targetOrCommand: string; outcome: G2ToolOutcome }>;
}

export interface G2TrustedContext {
  stage: 'actual-route-G2';
  identity: SupervisedInvocationIdentity;
  admissionId: string;
  boundaryIdentity: string;
  launchIdentity?: string;
}

export interface G2TeardownProof {
  invocationId: string;
  processTree: 'stopped-and-reaped';
  boundary: 'terminated';
  export: { inventoryHash: string; head: string };
}

/** Real denials require an independently trusted instrumentation verifier. */
export interface G2ControlVerifier {
  verifyDenialEvidence(input: {
    probe: G2ProbeFixture['expected'][number];
    event: NativeToolTraceEvent;
  }): boolean;
}

export interface NormalizedG2Event {
  correlationId: string;
  kind: G2ToolKind;
  targetOrCommand: string;
  outcome: G2ToolOutcome;
  denialKind?: G2DenialKind;
  exitCode?: number;
  httpStatus?: number;
  toolErrorCode?: G2ToolErrorCode;
  controlProof?: G2ControlProof;
}

export interface NormalizedG2Receipt {
  fixtureId: string;
  status: 'complete' | 'unavailable';
  identity: SupervisedInvocationIdentity;
  boundaryIdentity: string;
  launchIdentity: string;
  admissionId: string;
  terminal: NativeExecutionReceipt['terminal'];
  events: NormalizedG2Event[];
  teardown: G2TeardownProof | null;
  failures: string[];
}

/** Canonicalize only correlated native start/result frames and independently trusted controls. */
export function normalizeG2NativeReceipt(
  fixture: G2ProbeFixture,
  receipt: NativeExecutionReceipt,
  trustedContext: G2TrustedContext,
  teardown: G2TeardownProof | null = null,
  controlVerifier?: G2ControlVerifier,
): NormalizedG2Receipt {
  const failures: string[] = [];
  if (!fixture.id || !fixture.prompt.trim()) failures.push('fixture-invalid');
  if (!receipt || !receipt.identity || !sameIdentity(receipt.identity, trustedContext.identity)) failures.push('invocation-identity-mismatch');
  if (receipt?.launch?.admissionId !== trustedContext.admissionId) failures.push('admission-mismatch');
  if (receipt?.launch?.boundaryIdentity !== trustedContext.boundaryIdentity) failures.push('boundary-mismatch');
  if (trustedContext.launchIdentity && receipt?.launch?.launchIdentity !== trustedContext.launchIdentity) failures.push('launch-mismatch');
  if (trustedContext.stage !== 'actual-route-G2') failures.push('wrong-stage');
  if (!receipt?.terminal || !['exit', 'timeout', 'cancelled', 'spawn-error'].includes(receipt.terminal.state)) failures.push('invocation-terminal-unavailable');
  if (receipt?.toolPhase?.state !== 'complete' || !Number.isInteger(receipt.toolPhase.itemCount) || receipt.toolPhase.itemCount <= 0) failures.push('tool-phase-incomplete');
  if (!Array.isArray(receipt?.decoderFailures) || receipt.decoderFailures.length > 0) failures.push('native-decoder-failed');
  if (!receipt?.toolTrace?.length) failures.push('native-tool-channel-unavailable');
  if ((receipt?.toolTrace?.length ?? 0) > 12_000 || (receipt?.toolTrace ?? []).reduce((sum, event) =>
    sum + (event?.stdout?.byteLength ?? 0) + (event?.stderr?.byteLength ?? 0), 0) > 8 * 1024 * 1024) failures.push('native-tool-channel-over-limit');
  if (receipt?.teardown?.processTree !== 'stopped-and-reaped' || receipt?.teardown?.boundary !== 'terminated' ||
      !validExport(receipt?.teardown?.export)) failures.push('receipt-teardown-unproven');
  if (!teardown || teardown.invocationId !== trustedContext.identity.invocationId ||
      teardown.processTree !== 'stopped-and-reaped' || teardown.boundary !== 'terminated' || !validExport(teardown.export)) {
    failures.push('trusted-teardown-unproven');
  }

  const starts = new Map<string, NativeToolTraceEvent>();
  const results = new Map<string, NativeToolTraceEvent>();
  const eventIds = new Set<string>();
  const sequences = new Set<number>();
  let priorSequence = -1;
  let priorTimestamp = Number.NEGATIVE_INFINITY;
  for (const event of receipt?.toolTrace ?? []) {
    if (!event || !event.eventId || !event.correlationId || event.invocationId !== trustedContext.identity.invocationId ||
        !Number.isFinite(Date.parse(event.at)) || typeof event.targetOrCommand !== 'string' || !event.targetOrCommand.trim() ||
        (event.phase !== 'start' && event.phase !== 'result') || !['read', 'search', 'shell', 'http', 'config'].includes(event.kind)) {
      failures.push('malformed-tool-event'); continue;
    }
    const timestamp = Date.parse(event.at);
    if (!Number.isInteger(event.collectorSequence) || event.collectorSequence < 0 || sequences.has(event.collectorSequence) || event.collectorSequence <= priorSequence) failures.push('collector-sequence-invalid');
    if (timestamp < priorTimestamp) failures.push('collector-time-order-invalid');
    sequences.add(event.collectorSequence);
    priorSequence = event.collectorSequence;
    priorTimestamp = timestamp;
    if (eventIds.has(event.eventId)) failures.push('duplicate-event-id');
    eventIds.add(event.eventId);
    const destination = event.phase === 'start' ? starts : results;
    if (destination.has(event.correlationId)) failures.push(event.phase === 'start' ? 'duplicate-tool-start' : 'duplicate-tool-result');
    else destination.set(event.correlationId, event);
    if (event.phase === 'result' && (!event.outcome || !['denied', 'success', 'unavailable', 'unknown'].includes(event.outcome.disposition))) failures.push('result-outcome-unavailable');
    if (event.phase === 'result' && event.outcome?.denialKind &&
        !['filesystem-denied', 'not-found', 'broker-403', 'namespace-denied', 'guardian-not-visible', 'config-inventory-verified'].includes(event.outcome.denialKind)) failures.push('result-denial-kind-unavailable');
    if (event.phase === 'start' && event.outcome !== undefined) failures.push('start-frame-has-result-outcome');
    if (event.phase === 'result' && event.outcome?.disposition === 'success' && event.kind === 'shell' &&
        (event.toolStatus !== 'completed' || event.toolExitCode !== 0 || event.outcome.exitCode !== event.toolExitCode || event.outputSource !== 'aggregated_output' || !event.stdout)) failures.push('shell-success-status-unverified');
    if (event.kind === 'shell' && event.phase === 'start' && (event.toolStatus !== 'in_progress' || event.toolExitCode !== null || event.outcome !== undefined)) failures.push('shell-start-status-unverified');
    if (event.kind === 'shell' && event.phase === 'result' &&
        (!['completed', 'failed'].includes(event.toolStatus ?? '') || !Number.isInteger(event.toolExitCode) || event.toolExitCode! < 0 || event.toolExitCode! > 255 ||
         event.outputSource !== 'aggregated_output' || !event.stdout || event.outcome?.exitCode !== event.toolExitCode)) failures.push('shell-result-status-unverified');
    if (event.phase === 'result' && (!event.outcome || !['denied', 'success', 'unavailable', 'unknown'].includes(event.outcome.disposition))) failures.push('result-outcome-unavailable');
    if (event.kind === 'shell' && event.phase === 'result' && event.outcome?.disposition === 'success' &&
        (event.toolStatus !== 'completed' || event.toolExitCode !== 0 || event.outcome.exitCode !== 0)) failures.push('shell-success-status-unverified');
    if (event.phase === 'result' && event.outcome?.disposition === 'denied' &&
        (event.kind !== 'shell' || event.toolStatus !== 'failed' || !Number.isInteger(event.toolExitCode) || event.toolExitCode! <= 0 || event.outcome.exitCode !== event.toolExitCode)) failures.push('denial-status-unverified');
    if (event.phase === 'result' && event.outcome?.disposition === 'denied') {
      const probe = fixture.expected.find((item) => item.correlationId === event.correlationId);
      if (!probe || probe.kind !== event.kind || probe.targetOrCommand !== event.targetOrCommand ||
          controlVerifier?.verifyDenialEvidence({ probe, event }) !== true) failures.push('denial-control-unverified');
    }
  }
  if (starts.size !== results.size || [...starts.keys()].some((id) => !results.has(id)) || [...results.keys()].some((id) => !starts.has(id))) {
    failures.push('unmatched-tool-start-result');
  }
  const resultCount = results.size;
  if (receipt?.toolPhase?.itemCount !== resultCount) failures.push('tool-phase-cardinality-mismatch');

  const expectedByCorrelation = new Map(fixture.expected.map((item) => [item.correlationId, item]));
  const events: NormalizedG2Event[] = [];
  for (const [correlationId, start] of starts) {
    const result = results.get(correlationId);
    const expected = expectedByCorrelation.get(correlationId);
    if (!result || !expected) { failures.push('unexpected-or-unmatched-tool-correlation'); continue; }
    if (start.kind !== result.kind || start.targetOrCommand !== result.targetOrCommand ||
        start.kind !== expected.kind || start.targetOrCommand !== expected.targetOrCommand) failures.push('tool-target-correlation-mismatch');
    if (Date.parse(result.at) < Date.parse(start.at)) failures.push('tool-result-before-start');
    if (result.collectorSequence <= start.collectorSequence) failures.push('tool-result-before-start');
    if (result.outcome?.disposition !== expected.outcome) failures.push('tool-outcome-mismatch');
    if (result.kind === 'shell' && (result.toolStatus !== 'completed' && result.toolStatus !== 'failed')) failures.push('shell-result-status-unavailable');
    events.push({ correlationId, kind: result.kind, targetOrCommand: result.targetOrCommand,
      outcome: result.outcome?.disposition ?? 'unavailable', ...(result.outcome?.denialKind ? { denialKind: result.outcome.denialKind } : {}),
      ...(result.outcome?.exitCode === undefined ? {} : { exitCode: result.outcome.exitCode }),
      ...(result.outcome?.httpStatus === undefined ? {} : { httpStatus: result.outcome.httpStatus }),
      ...(result.outcome?.toolErrorCode === undefined ? {} : { toolErrorCode: result.outcome.toolErrorCode }),
      ...(result.outcome?.controlProof === undefined ? {} : { controlProof: result.outcome.controlProof }) });
  }
  if (events.length !== fixture.expected.length) failures.push('expected-tool-event-set-incomplete');
  return {
    fixtureId: fixture.id, status: failures.length === 0 ? 'complete' : 'unavailable',
    identity: receipt?.identity ?? trustedContext.identity,
    boundaryIdentity: receipt?.launch?.boundaryIdentity ?? '', launchIdentity: receipt?.launch?.launchIdentity ?? '',
    admissionId: receipt?.launch?.admissionId ?? '', terminal: receipt?.terminal ?? { state: 'spawn-error', code: null, signal: null },
    events, teardown: teardown && failures.every((failure) => !failure.includes('teardown')) ? teardown : null,
    failures: [...new Set(failures)],
  };
}

export async function runG2Harness(input: {
  fixture: G2ProbeFixture;
  context: G2TrustedContext;
  signal: AbortSignal;
  timeoutMs: number;
  execute(request: { prompt: string; stage: 'actual-route-G2'; admissionId: string; signal: AbortSignal }): Promise<unknown>;
  stop(): Promise<G2TeardownProof>;
  verifyConsumedAdmission(actualResult: unknown): Promise<boolean>;
  decodeReceipt(actualResult: unknown): NativeExecutionReceipt | null;
  controlVerifier?: G2ControlVerifier;
}): Promise<NormalizedG2Receipt> {
  if (input.context.stage !== 'actual-route-G2' || !input.context.admissionId) throw new Error('distinct actual-route-G2 admission required');
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 900_000) throw new Error('bounded G2 execution deadline required');
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(new Error('G2 deadline elapsed')); reject(new Error('G2 deadline elapsed')); }, input.timeoutMs);
  });
  let actualResult: unknown;
  let executionFailure: unknown;
  try {
    actualResult = await Promise.race([(async () => {
      const result = await input.execute({ prompt: input.fixture.prompt, stage: 'actual-route-G2', admissionId: input.context.admissionId, signal });
      if (await input.verifyConsumedAdmission(result) !== true) throw new Error('authoritative admission consumption proof missing');
      return result;
    })(), deadline]);
  } catch (error) { executionFailure = error; }
  let teardown: G2TeardownProof | null = null;
  try { teardown = await input.stop(); } catch { /* absence is represented as unavailable */ }
  if (timer) clearTimeout(timer);
  const receipt = actualResult === undefined ? null : input.decodeReceipt(actualResult);
  if (!receipt) return {
    fixtureId: input.fixture.id, status: 'unavailable', identity: input.context.identity,
    boundaryIdentity: input.context.boundaryIdentity, launchIdentity: input.context.launchIdentity ?? '',
    admissionId: input.context.admissionId, terminal: { state: 'spawn-error', code: null, signal: null },
    events: [], teardown: executionFailure ? null : teardown,
    failures: [executionFailure ? 'execution-or-admission-proof-failed' : 'native-receipt-channel-unavailable'],
  };
  const normalized = normalizeG2NativeReceipt(input.fixture, receipt, input.context, teardown, input.controlVerifier);
  if (executionFailure) return { ...normalized, status: 'unavailable', failures: [...new Set([...normalized.failures, 'execution-or-admission-proof-failed'])], teardown: null };
  return normalized;
}

function sameIdentity(a: SupervisedInvocationIdentity, b: SupervisedInvocationIdentity): boolean {
  return a.invocationId === b.invocationId && a.assignmentId === b.assignmentId && a.stageId === b.stageId && a.attemptId === b.attemptId;
}
function validExport(value: { inventoryHash: string; head: string } | null | undefined): boolean {
  return Boolean(value && /^[a-f0-9]{64}$/iu.test(value.inventoryHash) && /^[a-f0-9]{40,64}$/iu.test(value.head));
}

function validateNativeToolPhase(receipt: NativeExecutionReceipt): string[] {
  const failures: string[] = [];
  if (receipt.toolPhase?.state !== 'complete' || !Number.isInteger(receipt.toolPhase.itemCount) || receipt.toolPhase.itemCount <= 0) failures.push('tool-phase-incomplete');
  if (!Array.isArray(receipt.decoderFailures) || receipt.decoderFailures.length > 0) failures.push('decoder-failures-present');
  const starts = new Map<string, NativeToolTraceEvent>();
  const results = new Map<string, NativeToolTraceEvent>();
  const eventIds = new Set<string>();
  const sequences = new Set<number>();
  let previousSequence = -1;
  let previousTime = Number.NEGATIVE_INFINITY;
  for (const event of receipt.toolTrace ?? []) {
    if (!event || event.invocationId !== receipt.identity.invocationId || !event.eventId || !event.correlationId || !Number.isFinite(Date.parse(event.at)) ||
        (event.phase !== 'start' && event.phase !== 'result') || !['read', 'search', 'shell', 'http', 'config'].includes(event.kind)) {
      failures.push('malformed-event'); continue;
    }
    const time = Date.parse(event.at);
    if (!Number.isInteger(event.collectorSequence) || event.collectorSequence < 0 || sequences.has(event.collectorSequence) || event.collectorSequence <= previousSequence) failures.push('collector-sequence-invalid');
    if (time < previousTime) failures.push('collector-time-order-invalid');
    if (eventIds.has(event.eventId)) failures.push('duplicate-event-id');
    eventIds.add(event.eventId); sequences.add(event.collectorSequence); previousSequence = event.collectorSequence; previousTime = time;
    const set = event.phase === 'start' ? starts : results;
    if (set.has(event.correlationId)) failures.push('duplicate-tool-event');
    set.set(event.correlationId, event);
    if (event.kind === 'shell' && event.phase === 'start' && (event.toolStatus !== 'in_progress' || event.toolExitCode !== null || event.outcome !== undefined)) failures.push('shell-start-invalid');
    if (event.kind === 'shell' && event.phase === 'result' &&
        (!['completed', 'failed'].includes(event.toolStatus ?? '') || !Number.isInteger(event.toolExitCode) || event.toolExitCode! < 0 || event.toolExitCode! > 255 ||
         event.outputSource !== 'aggregated_output' || !event.stdout || event.outcome?.exitCode !== event.toolExitCode)) failures.push('shell-result-invalid');
    if (event.phase === 'result' && (!event.outcome || !['denied', 'success', 'unavailable', 'unknown'].includes(event.outcome.disposition))) failures.push('result-outcome-unavailable');
    if (event.kind === 'shell' && event.phase === 'result' && event.outcome?.disposition === 'success' &&
        (event.toolStatus !== 'completed' || event.toolExitCode !== 0 || event.outcome.exitCode !== 0)) failures.push('shell-success-invalid');
    if (event.kind === 'shell' && event.phase === 'result' && event.outcome?.disposition === 'denied' &&
        (event.toolStatus !== 'failed' || !Number.isInteger(event.toolExitCode) || event.toolExitCode! <= 0 || event.outcome.exitCode !== event.toolExitCode)) failures.push('shell-denial-invalid');
  }
  if (starts.size !== results.size || [...starts.keys()].some((key) => !results.has(key))) failures.push('unmatched-tool-events');
  for (const [key, start] of starts) {
    const result = results.get(key);
    if (result && (result.kind !== start.kind || result.targetOrCommand !== start.targetOrCommand || result.collectorSequence <= start.collectorSequence || Date.parse(result.at) < Date.parse(start.at))) failures.push('tool-pair-mismatch');
  }
  if (receipt.toolPhase?.itemCount !== results.size) failures.push('tool-phase-cardinality-mismatch');
  return [...new Set(failures)];
}
