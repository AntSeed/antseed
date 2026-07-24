import { execFileSync } from 'node:child_process'

export interface ProxySettings {
  host: string
  port: number
}

export type SystemProxySnapshot =
  | { platform: 'darwin'; services: MacProxyServiceSnapshot[] }
  | { platform: 'win32'; proxyEnable: string | null; proxyServer: string | null }
  | { platform: 'other' }

export interface MacProxyServiceSnapshot {
  service: string
  enabled: boolean
  server: string
  port: string
}

function runFileSilent(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: 'pipe' })
}

/**
 * Windows caches Internet Settings per-process — writing the `ProxyServer`/
 * `ProxyEnable` registry values alone doesn't make already-running WinINET
 * apps (and sometimes new ones) pick up the change. This broadcasts the
 * same `InternetSetOption` refresh that Control Panel's proxy UI issues.
 * No native dependency: routed through PowerShell's P/Invoke support.
 */
function notifyWindowsProxyChanged(): void {
  const script = [
    '$sig = \'[DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);\'',
    '$t = Add-Type -MemberDefinition $sig -Name AntSeedWinInet -Namespace AntSeed -PassThru',
    '$t::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null',
    '$t::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null',
  ].join('; ')
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'pipe' })
  } catch {
    // Best-effort: settings still take effect for newly-launched processes.
  }
}

function getEnabledNetworkServices(): string[] {
  try {
    const out = execFileSync('networksetup', ['-listallnetworkservices'], { encoding: 'utf8' })
    const services = out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('*') && !line.includes('denotes'))
    return services.length > 0 ? services : ['Wi-Fi']
  } catch {
    return ['Wi-Fi']
  }
}

function parseMacProxyOutput(service: string, out: string): MacProxyServiceSnapshot {
  const readValue = (label: string): string => {
    const line = out.split('\n').find((entry) => entry.startsWith(`${label}:`))
    return line ? line.slice(label.length + 1).trim() : ''
  }
  return {
    service,
    enabled: readValue('Enabled').toLowerCase() === 'yes',
    server: readValue('Server'),
    port: readValue('Port'),
  }
}

function readWindowsRegValue(name: string): string | null {
  try {
    const out = execFileSync('reg', [
      'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '/v', name,
    ], { encoding: 'utf8' })
    const line = out.split(/\r?\n/).find((entry) => entry.trim().startsWith(name))
    if (!line) return null
    const parts = line.trim().split(/\s+/)
    return parts.slice(2).join(' ') || null
  } catch {
    return null
  }
}

export function captureSystemProxySnapshot(): SystemProxySnapshot {
  if (process.platform === 'darwin') {
    const services: MacProxyServiceSnapshot[] = []
    for (const svc of getEnabledNetworkServices()) {
      try {
        const out = execFileSync('networksetup', ['-getsecurewebproxy', svc], { encoding: 'utf8' })
        services.push(parseMacProxyOutput(svc, out))
      } catch { /* best-effort */ }
    }
    return { platform: 'darwin', services }
  }
  if (process.platform === 'win32') {
    return {
      platform: 'win32',
      proxyEnable: readWindowsRegValue('ProxyEnable'),
      proxyServer: readWindowsRegValue('ProxyServer'),
    }
  }
  return { platform: 'other' }
}

export function restoreSystemProxySnapshot(snapshot: SystemProxySnapshot): void {
  if (snapshot.platform === 'darwin') {
    for (const svc of snapshot.services) {
      try {
        if (svc.server && svc.port) {
          runFileSilent('networksetup', ['-setsecurewebproxy', svc.service, svc.server, svc.port])
        }
        runFileSilent('networksetup', ['-setsecurewebproxystate', svc.service, svc.enabled ? 'on' : 'off'])
      } catch { /* best-effort */ }
    }
    return
  }
  if (snapshot.platform === 'win32') {
    try {
      runFileSilent('reg', [
        'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', snapshot.proxyEnable ?? '0', '/f',
      ])
      if (snapshot.proxyServer) {
        runFileSilent('reg', [
          'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
          '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', snapshot.proxyServer, '/f',
        ])
      } else {
        try {
          runFileSilent('reg', [
            'delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
            '/v', 'ProxyServer', '/f',
          ])
        } catch { /* missing value */ }
      }
      notifyWindowsProxyChanged()
    } catch { /* best-effort */ }
  }
}

export function setSystemProxy(settings: ProxySettings): SystemProxySnapshot {
  const { host, port } = settings
  const snapshot = captureSystemProxySnapshot()
  if (process.platform === 'darwin') {
    for (const svc of getEnabledNetworkServices()) {
      runFileSilent('networksetup', ['-setsecurewebproxy', svc, host, String(port)])
      runFileSilent('networksetup', ['-setsecurewebproxystate', svc, 'on'])
    }
  } else if (process.platform === 'win32') {
    runFileSilent('reg', [
      'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f',
    ])
    runFileSilent('reg', [
      'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', `${host}:${port}`, '/f',
    ])
    notifyWindowsProxyChanged()
  }
  // Linux: env vars only — no system-level setter
  return snapshot
}

export function clearSystemProxy(settings?: ProxySettings): void {
  if (process.platform === 'darwin') {
    for (const svc of getEnabledNetworkServices()) {
      try {
        const out = execFileSync('networksetup', ['-getsecurewebproxy', svc], { encoding: 'utf8' })
        const host = settings?.host ?? '127.0.0.1'
        if (!out.includes(`Server: ${host}`)) continue
        if (settings && !out.includes(`Port: ${settings.port}`)) continue
        runFileSilent('networksetup', ['-setsecurewebproxystate', svc, 'off'])
      } catch { /* best-effort */ }
    }
  } else if (process.platform === 'win32') {
    try {
      runFileSilent('reg', [
        'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f',
      ])
      notifyWindowsProxyChanged()
    } catch { /* best-effort */ }
  }
}
