export interface DHTHealthSnapshot {
  nodeCount: number;
  totalLookups: number;
  successfulLookups: number;
  failedLookups: number;
  totalAnnounces: number;
  successfulAnnounces: number;
  failedAnnounces: number;
  averageLookupLatencyMs: number;
  isHealthy: boolean;
}

export interface HealthThresholds {
  minNodeCount: number;
  minLookupSuccessRate: number;
  maxAvgLookupLatencyMs: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  minNodeCount: 5,
  minLookupSuccessRate: 0.3,
  maxAvgLookupLatencyMs: 15000,
};

export class DHTHealthMonitor {
  private readonly thresholds: HealthThresholds;
  private readonly getNodeCount: () => number;
  private _totalLookups = 0;
  private _successfulLookups = 0;
  private _failedLookups = 0;
  private _totalAnnounces = 0;
  private _successfulAnnounces = 0;
  private _failedAnnounces = 0;
  private readonly latencySamples: number[] = [];
  private static readonly MAX_LATENCY_SAMPLES = 100;

  constructor(
    getNodeCount: () => number,
    thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS
  ) {
    this.getNodeCount = getNodeCount;
    this.thresholds = thresholds;
  }

  recordLookup(success: boolean, latencyMs: number): void {
    this._totalLookups++;
    if (success) {
      this._successfulLookups++;
    } else {
      this._failedLookups++;
    }

    this.latencySamples.push(latencyMs);
    if (this.latencySamples.length > DHTHealthMonitor.MAX_LATENCY_SAMPLES) {
      this.latencySamples.shift();
    }
  }

  recordAnnounce(success: boolean): void {
    this._totalAnnounces++;
    if (success) {
      this._successfulAnnounces++;
    } else {
      this._failedAnnounces++;
    }
  }

  getSnapshot(): DHTHealthSnapshot {
    const nodeCount = this.getNodeCount();
    const averageLookupLatencyMs = this.computeAverageLatency();
    const healthy = this.evaluateHealth(nodeCount, averageLookupLatencyMs);

    return {
      nodeCount,
      totalLookups: this._totalLookups,
      successfulLookups: this._successfulLookups,
      failedLookups: this._failedLookups,
      totalAnnounces: this._totalAnnounces,
      successfulAnnounces: this._successfulAnnounces,
      failedAnnounces: this._failedAnnounces,
      averageLookupLatencyMs,
      isHealthy: healthy,
    };
  }

  isHealthy(): boolean {
    const nodeCount = this.getNodeCount();
    const averageLookupLatencyMs = this.computeAverageLatency();
    return this.evaluateHealth(nodeCount, averageLookupLatencyMs);
  }

  reset(): void {
    this._totalLookups = 0;
    this._successfulLookups = 0;
    this._failedLookups = 0;
    this._totalAnnounces = 0;
    this._successfulAnnounces = 0;
    this._failedAnnounces = 0;
    this.latencySamples.length = 0;
  }

  private computeAverageLatency(): number {
    if (this.latencySamples.length === 0) {
      return 0;
    }
    const sum = this.latencySamples.reduce((a, b) => a + b, 0);
    return sum / this.latencySamples.length;
  }

  private evaluateHealth(
    nodeCount: number,
    averageLookupLatencyMs: number
  ): boolean {
    // Must have minimum node count
    if (nodeCount < this.thresholds.minNodeCount) {
      return false;
    }

    // Check lookup success rate (only if we have 5+ lookups)
    if (this._totalLookups >= 5) {
      const successRate = this._successfulLookups / this._totalLookups;
      if (successRate < this.thresholds.minLookupSuccessRate) {
        return false;
      }
    }

    // Check average latency (only if we have 5+ samples)
    if (this.latencySamples.length >= 5) {
      if (averageLookupLatencyMs > this.thresholds.maxAvgLookupLatencyMs) {
        return false;
      }
    }

    return true;
  }
}
