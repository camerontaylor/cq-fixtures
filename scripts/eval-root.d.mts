// Types for scripts/eval-root.mjs (W6.3), so tests can call its pure helpers.

export declare const REPO_ROOT: string;
export declare const EVAL_ROOT_MARKER: string;
export declare const CODE_FILES: readonly string[];
export declare const FIX_SPAN_TOKENS: number;

export interface StrippedSuite {
  name: string;
  role: string;
  servedModel?: string;
  variant?: string;
  provenance: { origin: string };
  cases: Array<{ id: string; fixture: string; task: { prompt: string }; probe: { kind: string; check?: string } }>;
}

export declare function discoverSuites(root: string): string[];
export declare function stripSuite(doc: unknown): StrippedSuite;
export declare function sidecarStatus(repo: string, fixture: string): string;
export declare function fixDiffText(repo: string, fixture: string): string | undefined;
export declare function promptProblems(prompt: string, fixText: string | undefined): string[];

export interface BuildOptions {
  repo?: string;
  out: string;
  key: string;
  nodeModules?: 'copy' | 'move' | 'symlink' | 'skip';
  plantDirs?: string[];
  token?: string;
}
export interface BuildResult {
  root: string;
  key: string;
  token: string;
  files: number;
  suites: string[];
  plantedPaths: string[];
}
export declare function buildEvalRoot(opts: BuildOptions): BuildResult;
export declare function scanEvalRoot(opts: { root: string; repo?: string; key?: string }): { problems: string[]; checked: number };
