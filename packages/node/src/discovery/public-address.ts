export const MAX_PUBLIC_ADDRESS_LENGTH = 255;

export interface ParsedPublicAddress {
  host: string;
  port: number;
}

export function parsePublicAddress(value: string): ParsedPublicAddress | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PUBLIC_ADDRESS_LENGTH) {
    return null;
  }

  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon <= 0 || lastColon === trimmed.length - 1) {
    return null;
  }

  const host = trimmed.slice(0, lastColon).trim();
  const portText = trimmed.slice(lastColon + 1);
  if (!/^\d+$/.test(portText)) {
    return null;
  }

  const port = Number(portText);
  if (host.length === 0 || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  return { host, port };
}
