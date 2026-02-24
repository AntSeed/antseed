import type { PeerId } from './peer.js';

export type ReportReason =
  | 'bad-quality'
  | 'overcharging'
  | 'timeout'
  | 'harmful-content'
  | 'fraud'
  | 'impersonation'
  | 'other';

export type ReportStatus = 'pending' | 'acknowledged' | 'resolved' | 'dismissed';

export interface ReportEvidence {
  type: 'receipt' | 'log' | 'screenshot' | 'text';
  data: string;
}

export interface PeerReport {
  reportId: string;
  reporterPeerId: PeerId;
  targetPeerId: PeerId;
  reason: ReportReason;
  evidence: ReportEvidence[];
  sessionId?: string;
  timestamp: number;
  status: ReportStatus;
  /** Ed25519 signature over report data (hex string) */
  signature: string;
}
