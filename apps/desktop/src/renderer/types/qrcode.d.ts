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
  export type QRCodeCreateOptions = {
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
  };
  /** Raw symbol from QRCode.create(): square bit matrix of side `size`,
   *  row-major in `data` (truthy = dark module). */
  export type QRCodeModel = {
    modules: { size: number; data: Uint8Array };
  };
  function toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>;
  function create(text: string, options?: QRCodeCreateOptions): QRCodeModel;
  const QRCode: { toDataURL: typeof toDataURL; create: typeof create };
  export default QRCode;
}
