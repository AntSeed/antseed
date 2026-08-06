import { app } from 'electron';
import { readFileSync } from 'node:fs';

function readProcSys(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

function userNamespacesRestricted(): boolean {
  // Ubuntu 23.10+ AppArmor default: unconfined binaries may not create
  // unprivileged user namespaces.
  if (readProcSys('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') === '1') {
    return true;
  }
  // Debian-style hard switch.
  if (readProcSys('/proc/sys/kernel/unprivileged_userns_clone') === '0') {
    return true;
  }
  return false;
}

/**
 * An AppImage mounts under /tmp as the invoking user, so Chromium's SUID
 * chrome-sandbox fallback can never be root-owned 4755 there. On kernels
 * that restrict unprivileged user namespaces (Ubuntu 23.10+, hardened
 * Debian), the userns sandbox is unavailable too, and Electron aborts at
 * startup with FATAL:setuid_sandbox_host.cc unless launched with
 * --no-sandbox. Detect that combination and disable the sandbox ourselves —
 * same effect as the manual flag, without the crash-first experience.
 * .deb installs are unaffected: their chrome-sandbox is installed SUID root.
 *
 * Must be called before app.whenReady() — the sandboxed zygote is spawned
 * during browser-process startup.
 */
export function disableSandboxIfAppImageCannotSandbox(): void {
  if (process.platform !== 'linux' || !process.env.APPIMAGE) return;
  if (app.commandLine.hasSwitch('no-sandbox')) return;
  if (!userNamespacesRestricted()) return;
  app.commandLine.appendSwitch('no-sandbox');
  console.warn(
    '[desktop] kernel restricts unprivileged user namespaces and the AppImage SUID helper cannot work; running with --no-sandbox',
  );
}
