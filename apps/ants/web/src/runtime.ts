export interface DashboardTransport {
  mode: 'local' | 'hosted';
  request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
}

let transport: DashboardTransport | null = null;

export function installDashboardTransport(next: DashboardTransport): void {
  transport = next;
}

export function dashboardTransport(): DashboardTransport | null {
  return transport;
}

export function isHosted(): boolean {
  return transport?.mode === 'hosted';
}

/** The standalone dashboard before a wallet connects: the address is the zero address placeholder. */
export function isHostedDisconnected(config: { mode?: 'local' | 'hosted'; address: string }): boolean {
  return config.mode === 'hosted' && /^0x0{40}$/i.test(config.address);
}
