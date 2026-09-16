export interface AccessTerms {
  amountMicroUsdc: string;
  durationSeconds: number;
}

export interface AccessAgreement extends AccessTerms {
  enabled: boolean;
  pauseReason: string | null;
}

export interface AccessPurchase extends AccessTerms {
  authorizedAtMs: number;
  channelId: string;
  cumulativeAmount: string;
}

export interface AccessAuthorization {
  scope: string;
  previousAuthorizedAtMs: number | null;
  purchase: AccessPurchase;
}

export function validateAccessTerms(terms: AccessTerms): void {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(terms.amountMicroUsdc)
    || !Number.isSafeInteger(terms.durationSeconds)
    || terms.durationSeconds < 1 || terms.durationSeconds > 31_536_000) {
    throw new Error('Invalid access terms');
  }
}

export function sameAccessTerms(left: AccessTerms, right: AccessTerms): boolean {
  return left.amountMicroUsdc === right.amountMicroUsdc && left.durationSeconds === right.durationSeconds;
}
