import type { InvocationIdentity, ObservedDriver } from './observation.ts';
import { runSuite, type RunSuiteOptions, type RunSuiteResult } from '../index.ts';
import type { ObservedNativeDriver } from './observed-driver.ts';

export interface NativeConformanceOptions extends Omit<RunSuiteOptions, 'driver'> {
  driver: ObservedNativeDriver;
  expectedCaseIds: string[];
  expectedInvocations: InvocationIdentity[];
  expectedTransport: string;
}

/**
 * G1 entrypoint: this calls the actual runSuite path, whose row and table
 * validators remain authoritative. It is deliberately gated on runner-side
 * identity delivery from the S1 integration.
 */
export async function runNativeConformanceSuite(options: NativeConformanceOptions): Promise<RunSuiteResult> {
  const { expectedCaseIds, expectedInvocations, expectedTransport, ...suiteOptions } = options;
  const result = await runSuite(suiteOptions);
  const foundCases = new Set(result.rows.map((row) => row.case));
  const missingCases = expectedCaseIds.filter((caseId) => !foundCases.has(caseId));
  if (missingCases.length) throw new Error(`runSuite did not return native conformance rows for: ${missingCases.join(', ')}`);
  if (result.tables.length === 0) throw new Error('runSuite returned no native conformance comparison table');

  const driver = options.driver as ObservedNativeDriver & ObservedDriver;
  for (const identity of expectedInvocations) {
    const observation = await driver.getObservation(identity.invocationId);
    if (!observation) throw new Error(`runSuite did not deliver invocation identity ${identity.invocationId} to the native bridge`);
    if (observation.identity.assignmentId !== identity.assignmentId ||
        observation.identity.stageId !== identity.stageId || observation.identity.attemptId !== identity.attemptId) {
      throw new Error(`native observation identity mismatch for ${identity.invocationId}`);
    }
    if (observation.transport !== expectedTransport) throw new Error(`expected ${expectedTransport}, observed ${observation.transport}`);
  }

  // Native identifiers must survive validation and aggregation. The exact
  // field is added by S1; accept either dedicated transport or driver field
  // while keeping the value itself strict.
  for (const row of result.rows) {
    const record = row as unknown as Record<string, unknown>;
    const identity = record.transport ?? record.nativeTransport ?? record.driver;
    if (identity !== expectedTransport) {
      throw new Error(`native row ${String(record.case)} lost transport identity ${expectedTransport}`);
    }
  }
  return result;
}
