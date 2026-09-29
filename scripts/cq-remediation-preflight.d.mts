export interface SourcePreflightResult {
  status: 'preflight-green';
  dispatched: false;
  provisioned: false;
  sourceEntryPoint: 'runner/native/run-visible-g1.ts';
  taskIdExport: 'runner/experiment.ts#suiteTaskId';
  closureCount: number;
  closure: Record<string, string>;
  implicitRuntimeAssets: Record<string, string>;
}

/** Verify required non-import runtime assets against exact SHA-256 pins. */
export function verifyImplicitRuntimeAssets(
  rootPath?: string,
  expectedPins?: Readonly<Record<string, string>>,
): Promise<Record<string, string>>;

/** Resolve and validate the transitive local source/data closure. */
export function discoverSourceClosure(
  rootPath: string,
  entrypoints: readonly string[],
): Promise<string[]>;

/** Compare two source closure path sets, ignoring duplicate entries. */
export function assertSameClosure(
  expected: Iterable<string>,
  actual: Iterable<string>,
  label?: string,
): void;

/** Compare closure path sets and each corresponding content hash. */
export function assertSamePins(
  expected: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>,
  label?: string,
): void;

/** Run transformed entrypoint, export and real source-loader checks without dispatch. */
export function runPreflight(rootPath?: string): Promise<SourcePreflightResult>;
