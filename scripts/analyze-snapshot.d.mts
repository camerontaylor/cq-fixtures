export interface SnapshotAnalysis {
  toolkitVersion: string;
  suiteSha: string;
  cellCount: number;
  tables: Array<{
    role: string;
    suite: string;
    cells: Array<{ model: string; driver: string }>;
    comparisons?: Array<{
      cases: number;
      repeatsPerCase: number;
      coverageParity: boolean;
      interpretation: 'within-noise' | 'not-distinguishable' | 'signal' | 'descriptive';
    }>;
  }>;
}

export function analyzeSnapshot(from: string): SnapshotAnalysis;
