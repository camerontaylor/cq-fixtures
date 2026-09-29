/** Native side of the actual-route G2 sentinel receipt. Missing tool channels fail closed. */
import type { SupervisedInvocationIdentity } from './process.ts';

export type G2ToolKind = 'read' | 'search' | 'shell' | 'http' | 'config';
export type G2ToolOutcome = 'denied' | 'success' | 'unavailable' | 'unknown';
export type G2DenialKind = 'filesystem-denied' | 'not-found' | 'broker-403' | 'namespace-denied' | 'guardian-not-visible' | 'config-inventory-verified';
export type G2TerminalState = 'exit' | 'timeout' | 'cancelled' | 'spawn-error';

/** Private stdout/stderr buffers stay attached to the raw receipt, never normalized into public output. */
export interface NativeToolTraceEvent {
  eventId: string;
  invocationId: string;
  phase: 'start' | 'result';
  kind: G2ToolKind;
  targetOrCommand: string;
  correlationId: string;
  at: string;
  outcome?: { disposition: G2ToolOutcome; denialKind?: G2DenialKind };
  stdout?: Uint8Array;
  stderr?: Uint8Array;
}

export interface NativeExecutionReceipt {
  identity: SupervisedInvocationIdentity;
  launch: { boundaryIdentity: string; launchIdentity: string; admissionId: string; profileInvocationIdentity?: string };
  terminal: { state: G2TerminalState; code: number | null; signal: string | null };
  toolTrace: readonly NativeToolTraceEvent[];
  teardown: {
    processTree: 'stopped-and-reaped' | 'unproven';
    boundary: 'terminated' | 'unproven';
    export: { inventoryHash: string; head: string } | null;
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

export interface NormalizedG2Event {
  correlationId: string;
  kind: G2ToolKind;
  targetOrCommand: string;
  outcome: G2ToolOutcome;
  denialKind?: G2DenialKind;
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
): NormalizedG2Receipt {
  const failures: string[] = [];
  if (!fixture.id || !fixture.prompt.trim()) failures.push('fixture-invalid');
  if (!receipt || !receipt.identity || !sameIdentity(receipt.identity, trustedContext.identity)) failures.push('invocation-identity-mismatch');
  if (receipt?.launch?.admissionId !== trustedContext.admissionId) failures.push('admission-mismatch');
  if (receipt?.launch?.boundaryIdentity !== trustedContext.boundaryIdentity) failures.push('boundary-mismatch');
  if (trustedContext.launchIdentity && receipt?.launch?.launchIdentity !== trustedContext.launchIdentity) failures.push('launch-mismatch');
  if (trustedContext.stage !== 'actual-route-G2') failures.push('wrong-stage');
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
  for (const event of receipt?.toolTrace ?? []) {
    if (!event || !event.eventId || !event.correlationId || event.invocationId !== trustedContext.identity.invocationId ||
        !Number.isFinite(Date.parse(event.at)) || typeof event.targetOrCommand !== 'string' || !event.targetOrCommand.trim()) {
      failures.push('malformed-tool-event'); continue;
    }
    if (eventIds.has(event.eventId)) failures.push('duplicate-event-id');
    eventIds.add(event.eventId);
    const destination = event.phase === 'start' ? starts : results;
    if (destination.has(event.correlationId)) failures.push(event.phase === 'start' ? 'duplicate-tool-start' : 'duplicate-tool-result');
    else destination.set(event.correlationId, event);
    if (event.phase === 'result' && (!event.outcome || !['denied', 'success', 'unavailable', 'unknown'].includes(event.outcome.disposition))) failures.push('result-outcome-unavailable');
    if (event.phase === 'result' && event.outcome?.denialKind &&
        !['filesystem-denied', 'not-found', 'broker-403', 'namespace-denied', 'guardian-not-visible', 'config-inventory-verified'].includes(event.outcome.denialKind)) failures.push('result-denial-kind-unavailable');
    if (event.phase === 'start' && event.outcome !== undefined) failures.push('start-frame-has-result-outcome');
  }
  if (starts.size !== results.size || [...starts.keys()].some((id) => !results.has(id)) || [...results.keys()].some((id) => !starts.has(id))) {
    failures.push('unmatched-tool-start-result');
  }

  const expectedByCorrelation = new Map(fixture.expected.map((item) => [item.correlationId, item]));
  const events: NormalizedG2Event[] = [];
  for (const [correlationId, start] of starts) {
    const result = results.get(correlationId);
    const expected = expectedByCorrelation.get(correlationId);
    if (!result || !expected) { failures.push('unexpected-or-unmatched-tool-correlation'); continue; }
    if (start.kind !== result.kind || start.targetOrCommand !== result.targetOrCommand ||
        start.kind !== expected.kind || start.targetOrCommand !== expected.targetOrCommand) failures.push('tool-target-correlation-mismatch');
    if (result.outcome?.disposition !== expected.outcome) failures.push('tool-outcome-mismatch');
    events.push({ correlationId, kind: result.kind, targetOrCommand: result.targetOrCommand,
      outcome: result.outcome?.disposition ?? 'unavailable', ...(result.outcome?.denialKind ? { denialKind: result.outcome.denialKind } : {}) });
  }
  if (events.length !== fixture.expected.length) failures.push('expected-tool-event-set-incomplete');
  if (receipt?.terminal?.state !== 'exit' || receipt.terminal.code !== 0) failures.push('native-invocation-not-successful');
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
  const normalized = normalizeG2NativeReceipt(input.fixture, receipt, input.context, teardown);
  if (executionFailure) return { ...normalized, status: 'unavailable', failures: [...new Set([...normalized.failures, 'execution-or-admission-proof-failed'])], teardown: null };
  return normalized;
}

function sameIdentity(a: SupervisedInvocationIdentity, b: SupervisedInvocationIdentity): boolean {
  return a.invocationId === b.invocationId && a.assignmentId === b.assignmentId && a.stageId === b.stageId && a.attemptId === b.attemptId;
}
function validExport(value: { inventoryHash: string; head: string } | null | undefined): boolean {
  return Boolean(value && /^[a-f0-9]{64}$/iu.test(value.inventoryHash) && /^[a-f0-9]{40,64}$/iu.test(value.head));
}
