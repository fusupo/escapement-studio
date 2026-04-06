export interface ReconciliationFileComparison {
  matched_files: string[];
  missed_predicted_files: string[];
  unpredicted_actual_files: string[];
}

export interface ReconciliationOverlap {
  file: string;
  overlapping_work_item_ids: string[];
}

export interface ReconciliationDriftPattern {
  kind: "exact_match" | "overprediction" | "unpredicted_change" | "mixed_drift" | "no_prediction" | "no_actual_changes";
  summary: string;
}

export interface ReconciliationRunReference {
  run_id: string;
  status: string;
  completed_at?: string;
  artifact_dir: string;
  changed_files: string[];
}

export interface ReconciliationReport {
  work_item_id: string;
  work_item_name: string;
  repo: string | null;
  issue_url: string | null;
  predicted_files: string[];
  actual_files: string[];
  comparison: ReconciliationFileComparison;
  overlap_candidates: ReconciliationOverlap[];
  drift_patterns: ReconciliationDriftPattern[];
  latest_run: ReconciliationRunReference | null;
  recent_runs: ReconciliationRunReference[];
  stats: {
    predicted_count: number;
    actual_count: number;
    matched_count: number;
    missed_count: number;
    unpredicted_count: number;
    overlap_count: number;
  };
}
