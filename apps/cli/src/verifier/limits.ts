export const MAX_AUDIT_BATCH_RECORDS = 256
export const MAX_AUDIT_PROBES_PER_REQUEST = 3

export function maxAuditRecordCount(
  cohortSize: number,
  probeCount: number,
  maxProbesPerRequest: number,
): number {
  return cohortSize * Math.ceil(probeCount / maxProbesPerRequest)
}
