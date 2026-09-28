import type { InvocationIdentity, ObservedDriver } from './observation.ts';
import { runSuite, type RunSuiteOptions, type RunSuiteResult } from '../index.ts';
import type { ObservedNativeDriver } from './observed-driver.ts';

export interface NativeConformanceOptions extends Omit<RunSuiteOptions, 'driver'> {
  driver: ObservedNativeDriver;
  expectedCaseIds: string[];
  expectedInvocations: InvocationIdentity[];
  expectedTransport: string;
}

const TRANSPORT_DRIVER: Readonly<Record<string, string>> = {
  'codex-exec': 'codex-exec',
  'pi-json': 'pi-json',
  'pi-rpc': 'pi-rpc',
  'zcode-acp': 'zcode-acp',
};

/**
 * G1 entrypoint: this calls the actual runSuite path, whose row and table
 * validators remain authoritative. It is deliberately gated on runner-side
 * identity delivery from the S1 integration.
 */
export async function runNativeConformanceSuite(options: NativeConformanceOptions): Promise<RunSuiteResult> {
  const { expectedCaseIds, expectedInvocations, expectedTransport, ...suiteOptions } = options;
  const expectedDriver = TRANSPORT_DRIVER[expectedTransport];
  if (!expectedDriver) throw new Error(`unsupported native transport for runSuite conformance: ${expectedTransport}`);
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

  // The row schema carries the validated lane label; the native transport
  // identity remains in the observation envelope. Aggregation must preserve
  // that same lane in its comparison cell.
  for (const row of result.rows) {
    if (row.driver !== expectedDriver) {
      throw new Error(`native row ${row.case} has driver ${row.driver}; expected ${expectedDriver}`);
    }
  }
  const matchingCells = result.tables.flatMap((table) => table.cells)
    .filter((cell) => cell.driver === expectedDriver);
  if (matchingCells.length === 0) throw new Error(`comparison tables lost native driver lane ${expectedDriver}`);
  return result;
}
