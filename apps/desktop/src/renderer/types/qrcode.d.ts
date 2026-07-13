// Minimal local declaration for the `qrcode` package. The published
// @types/qrcode references @types/node, which leaks NodeJS globals
// (setTimeout return types, etc.) into the renderer compile — so we
// declare just the browser API surface we use instead.
declare module 'qrcode' {
  export type QRCodeToDataURLOptions = {
    margin?: number;
    width?: number;
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    color?: { dark?: string; light?: string };
  };
  function toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>;
  const QRCode: { toDataURL: typeof toDataURL };
  export default QRCode;
}
