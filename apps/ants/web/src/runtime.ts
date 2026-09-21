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
