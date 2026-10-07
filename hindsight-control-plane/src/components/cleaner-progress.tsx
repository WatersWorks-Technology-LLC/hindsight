"use client";

import Image from "next/image";
import styles from "./cleaner-liquid.module.css";

export function CleanerIcon({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <Image src="/favicon.png" width={64} height={64} alt="" unoptimized className={className} />
  );
}

export interface CleanerProgressData {
  enumerated?: number;
  total?: number | null;
  read?: number;
  processed?: number;
  failed?: number;
  remaining?: number | null;
  completed?: number;
  quarantined?: number;
}

export function measuredProgress(progress?: CleanerProgressData): number | undefined {
  if (
    !progress ||
    typeof progress.total !== "number" ||
    !Number.isFinite(progress.total) ||
    progress.total <= 0 ||
    typeof progress.processed !== "number" ||
    !Number.isFinite(progress.processed)
  )
    return undefined;
  return Math.max(0, Math.min(100, Math.floor((progress.processed / progress.total) * 100)));
}

export function CleanerProgress({
  stage,
  progress,
  interrupted,
  active = true,
  unitLabel = "staged",
}: {
  stage: string;
  progress?: CleanerProgressData;
  interrupted?: boolean;
  active?: boolean;
  unitLabel?: string;
}) {
  const percent = measuredProgress(progress);
  const counts = [
    ["Discovered", progress?.enumerated],
    ["Read", progress?.read],
    ["Processed", progress?.processed],
    ["Quarantined", progress?.quarantined],
    ["Failed", progress?.failed],
    ["Remaining", progress?.remaining],
  ] as const;
  return (
    <div
      className={`${styles.panel} ${!active || interrupted ? styles.settled : ""} rounded-2xl p-5 space-y-4`}
    >
      <div className="flex items-center gap-3">
        <div className={interrupted || !active ? "" : styles.orb}>
          <CleanerIcon className="h-12 w-12" />
        </div>
        <div className="flex-1">
          <h2 className="font-semibold">
            {interrupted ? "Progress connection interrupted" : stage}
          </h2>
          <p className="text-xs text-muted-foreground">
            Real document counts from the cleaner. Original documents stay preserved.
          </p>
        </div>
        <span className="text-lg font-semibold tabular-nums">
          {percent === undefined ? "" : `${percent}% ${unitLabel}`}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={
          unitLabel === "rolled back"
            ? "Candidate rollback progress"
            : "Documents with generated candidates"
        }
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={
          percent === undefined
            ? `${stage}; total not yet known`
            : `${progress?.processed} of ${progress?.total} document outcomes ${unitLabel}; ${progress?.failed || 0} failed`
        }
        className={styles.track}
      >
        <div
          className={`${styles.liquid} ${percent === undefined ? styles.pending : ""}`}
          style={percent === undefined ? undefined : { width: `${percent}%` }}
        />
      </div>
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="flex flex-wrap gap-x-6 gap-y-2 text-sm"
      >
        {counts.map(([label, value]) => (
          <span key={label}>
            <span className="text-muted-foreground">{label}: </span>
            <strong className="tabular-nums">{typeof value === "number" ? value : "—"}</strong>
          </span>
        ))}
      </div>
      {percent === undefined && (
        <p className="text-xs text-muted-foreground">
          {progress?.total === 0
            ? "This bank has no documents. Nothing changed."
            : active
              ? "Discovering the batch or waiting for its total. No percentage is estimated."
              : "No percentage is available for this saved batch."}
        </p>
      )}
    </div>
  );
}
