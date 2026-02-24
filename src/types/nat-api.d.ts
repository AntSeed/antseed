declare module "@silentbot1/nat-api" {
  interface NatAPIOptions {
    ttl?: number;
    description?: string;
    gateway?: string;
    autoUpdate?: boolean;
    enablePMP?: boolean;
    enableUPNP?: boolean;
    upnpPermanentFallback?: boolean;
  }

  interface MapOptions {
    publicPort: number;
    privatePort: number;
    protocol?: "TCP" | "UDP";
    ttl?: number;
    description?: string;
  }

  class NatAPI {
    constructor(opts?: NatAPIOptions);
    map(publicPort: number | MapOptions, privatePort?: number): Promise<boolean>;
    unmap(publicPort: number | MapOptions, privatePort?: number): Promise<void>;
    externalIp(): Promise<string>;
    destroy(): Promise<void>;
  }

  export default NatAPI;
}
