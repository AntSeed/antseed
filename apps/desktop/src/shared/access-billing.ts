export interface AccessBillingRequest {
  action: 'status' | 'activate' | 'pause';
  serviceId: string;
  sellerPeerId?: string;
  amountMicroUsdc?: string;
  durationSeconds?: number;
}

export interface AccessBillingSnapshot {
  offer: { peerId: string; serviceId: string; amountMicroUsdc: string; durationSeconds: number } | null;
  agreement: { enabled: boolean; pauseReason: string | null; amountMicroUsdc: string; durationSeconds: number } | null;
  purchase: { authorizedAtMs: number; durationSeconds: number; amountMicroUsdc: string } | null;
}

export interface AccessBillingResult {
  ok: boolean;
  data?: AccessBillingSnapshot;
  error?: string;
}
