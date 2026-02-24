import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PeerId } from '../types/peer.js';
import type { PeerReport, ReportReason, ReportEvidence } from '../types/report.js';
import type { Identity } from '../p2p/identity.js';
import { signData } from '../p2p/identity.js';
import { bytesToHex } from '../utils/hex.js';

export interface ReportManagerConfig {
  configDir: string;
  identity?: Identity;
}

export class ReportManager {
  private readonly configDir: string;
  private readonly identity: Identity | undefined;
  private reports: PeerReport[] = [];

  constructor(config: ReportManagerConfig) {
    this.configDir = config.configDir;
    this.identity = config.identity;
  }

  async submitReport(
    targetPeerId: PeerId,
    reason: ReportReason,
    evidence: ReportEvidence[],
    sessionId?: string,
  ): Promise<PeerReport> {
    if (!this.identity) throw new Error('Identity required to submit reports');

    const report: PeerReport = {
      reportId: randomUUID(),
      reporterPeerId: this.identity.peerId as PeerId,
      targetPeerId,
      reason,
      evidence,
      sessionId,
      timestamp: Date.now(),
      status: 'pending',
      signature: '',
    };

    // Sign the report
    const dataToSign = `${report.reportId}:${report.reporterPeerId}:${report.targetPeerId}:${report.reason}:${report.timestamp}`;
    const sig = await signData(this.identity.privateKey, new TextEncoder().encode(dataToSign));
    report.signature = bytesToHex(sig);

    this.reports.push(report);
    await this.save();
    return report;
  }

  getReportsAgainst(peerId: PeerId): PeerReport[] {
    return this.reports.filter(r => r.targetPeerId === peerId);
  }

  getMyReports(): PeerReport[] {
    if (!this.identity) return [];
    return this.reports.filter(r => r.reporterPeerId === this.identity!.peerId);
  }

  getReport(reportId: string): PeerReport | null {
    return this.reports.find(r => r.reportId === reportId) ?? null;
  }

  updateReportStatus(reportId: string, status: PeerReport['status']): void {
    const report = this.reports.find(r => r.reportId === reportId);
    if (report) {
      report.status = status;
    }
  }

  async save(): Promise<void> {
    const dir = join(this.configDir, 'reports');
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, 'reports.json');
    await writeFile(filePath, JSON.stringify(this.reports, null, 2), 'utf-8');
  }

  async load(): Promise<void> {
    const filePath = join(this.configDir, 'reports', 'reports.json');
    try {
      const raw = await readFile(filePath, 'utf-8');
      this.reports = JSON.parse(raw) as PeerReport[];
    } catch {
      this.reports = [];
    }
  }
}
