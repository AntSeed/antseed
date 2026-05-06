/**
 * Shared HTTP-layer types. Lives in http/ rather than at the package root so
 * server-only types stay out of the published-frontend-agnostic store/insights
 * imports — but is imported by both index.ts (writer) and the /stats route
 * (reader), which is why it isn't inside server.ts itself.
 */

export interface BackfillStatusPayload {
  state: 'idle' | 'running' | 'done' | 'failed' | 'skipped';
  startedAt: number | null;
  finishedAt: number | null;
  scannedBlocks: number;
  totalBlocks: number;
  events: number;
  rowsWritten: number;
  phase: 'scanning' | 'resolving-timestamps' | 'done' | null;
  errorMessage: string | null;
}
