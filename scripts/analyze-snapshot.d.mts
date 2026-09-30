export interface SnapshotAnalysis {
  toolkitLock: string;
  suiteSha: string;
  cellCount: number;
  tables: Array<{
    role: string;
    suite: string;
    comparisons?: Array<{
      cases: number;
      repeatsPerCase: number;
      coverageParity: boolean;
      interpretation: 'noise' | 'signal' | 'descriptive';
    }>;
  }>;
}

export function analyzeSnapshot(from: string): SnapshotAnalysis;
