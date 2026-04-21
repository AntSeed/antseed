import {useEffect, useMemo, useState} from 'react';

/**
 * Resolves the best AntSeed Desktop download URL for the visitor's OS + arch
 * by fetching the latest GitHub Release and matching assets against the
 * detected platform. Falls back to the releases page when detection fails or
 * the matching asset isn't published yet (e.g. Windows during a partial
 * release).
 *
 * Detection:
 *   - Mac arm64 / Mac x64: via `navigator.userAgentData.getHighEntropyValues`
 *     (Chromium) when available; otherwise defaults to arm64 since Apple
 *     Silicon has been the mainstream Mac since 2020. The legacy UA string
 *     always reports "Intel" on macOS regardless of chip, so it can't be
 *     relied on.
 *   - Windows arm64 / Windows x64: same high-entropy API. Windows UA also
 *     lies about arch by default.
 *   - Linux / unknown: no installer is matched; the CTA links to the
 *     releases page where the user picks.
 *
 * Asset matching is done by regex against `asset.name` rather than URL
 * construction so the hook self-corrects when electron-builder changes its
 * artifact naming.
 */

const GH_API_LATEST = 'https://api.github.com/repos/AntSeed/antseed/releases/latest';
export const RELEASES_URL = 'https://github.com/AntSeed/antseed/releases/latest';

export type DesktopPlatform = 'mac' | 'win' | 'linux' | 'unknown';
export type DesktopArch = 'arm64' | 'x64';

interface GitHubAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name?: string;
  assets?: GitHubAsset[];
}

export interface DesktopDownload {
  /** Detected OS — used to pick label text. */
  platform: DesktopPlatform;
  /** Detected CPU arch. Unknown arch defaults to `arm64` for Mac, `x64` for Windows. */
  arch: DesktopArch;
  /** Direct download URL for the matched installer, or `null` if none was found. */
  url: string | null;
  /**
   * URL a CTA should link to: prefers the direct installer URL, falls back
   * to the releases page so users always have somewhere to go.
   */
  href: string;
  /** Human label, e.g. "Download for Mac" / "Download for Windows" / "Download". */
  label: string;
  /** Resolved release tag from the API, or null while loading. */
  tag: string | null;
}

function detectPlatform(): DesktopPlatform {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent;
  if (/Windows/.test(ua)) return 'win';
  if (/Macintosh|Mac OS X/.test(ua)) return 'mac';
  if (/Linux/.test(ua) && !/Android/.test(ua)) return 'linux';
  return 'unknown';
}

function defaultArchFor(platform: DesktopPlatform): DesktopArch {
  // Apple Silicon has been the default Mac since late 2020; Windows is still
  // predominantly x64. These are the fallbacks when the high-entropy arch API
  // is unavailable (non-Chromium browsers).
  return platform === 'mac' ? 'arm64' : 'x64';
}

interface UserAgentDataLike {
  getHighEntropyValues(hints: string[]): Promise<{architecture?: string; bitness?: string}>;
}

async function detectArch(platform: DesktopPlatform): Promise<DesktopArch> {
  const fallback = defaultArchFor(platform);
  if (typeof navigator === 'undefined') return fallback;
  const nav = navigator as Navigator & {userAgentData?: UserAgentDataLike};
  if (!nav.userAgentData?.getHighEntropyValues) return fallback;
  try {
    const data = await nav.userAgentData.getHighEntropyValues(['architecture', 'bitness']);
    // Values per the UA-CH spec: "x86", "arm", "arm64", ... Bitness is "64" or "32".
    if (data.architecture === 'arm') return 'arm64';
    if (data.architecture === 'x86') return 'x64';
    return fallback;
  } catch {
    return fallback;
  }
}

function matchAsset(
  assets: GitHubAsset[],
  platform: DesktopPlatform,
  arch: DesktopArch,
): GitHubAsset | null {
  const isBlockmap = (n: string) => /\.blockmap$/i.test(n);
  const hasArm64 = (n: string) => /arm64/i.test(n);

  if (platform === 'mac') {
    return assets.find(a => {
      if (isBlockmap(a.name)) return false;
      if (!/\.dmg$/i.test(a.name)) return false;
      return arch === 'arm64' ? hasArm64(a.name) : !hasArm64(a.name);
    }) ?? null;
  }

  if (platform === 'win') {
    return assets.find(a => {
      if (isBlockmap(a.name)) return false;
      if (!/\.exe$/i.test(a.name)) return false;
      return arch === 'arm64' ? hasArm64(a.name) : !hasArm64(a.name);
    }) ?? null;
  }

  return null;
}

function labelFor(platform: DesktopPlatform): string {
  switch (platform) {
    case 'mac':
      return 'Download for Mac';
    case 'win':
      return 'Download for Windows';
    case 'linux':
      return 'Download for Linux';
    default:
      return 'Download';
  }
}

/**
 * React hook. Returns resolved download metadata. Safe to call during SSR
 * (returns a neutral fallback that points at the releases page).
 */
export function useLatestDesktopDownload(): DesktopDownload {
  const platform = useMemo<DesktopPlatform>(detectPlatform, []);
  const [arch, setArch] = useState<DesktopArch>(() => defaultArchFor(platform));
  const [tag, setTag] = useState<string | null>(null);
  const [assets, setAssets] = useState<GitHubAsset[]>([]);

  useEffect(() => {
    let cancelled = false;
    detectArch(platform).then(a => {
      if (!cancelled) setArch(a);
    });
    return () => { cancelled = true; };
  }, [platform]);

  useEffect(() => {
    // Only fetch on platforms we actually ship installers for. Avoids burning
    // GitHub's unauthenticated API rate limit for Linux / unknown visitors
    // who will be sent to the releases page anyway.
    if (platform !== 'mac' && platform !== 'win') return;
    let cancelled = false;
    fetch(GH_API_LATEST)
      .then(r => (r.ok ? r.json() : null))
      .then((data: GitHubRelease | null) => {
        if (cancelled || !data) return;
        if (data.tag_name) setTag(data.tag_name);
        if (Array.isArray(data.assets)) setAssets(data.assets);
      })
      .catch(() => { /* network / rate-limit / offline — silently fall back */ });
    return () => { cancelled = true; };
  }, [platform]);

  const matched = useMemo(
    () => (assets.length > 0 ? matchAsset(assets, platform, arch) : null),
    [assets, platform, arch],
  );

  const url = matched?.browser_download_url ?? null;
  return {
    platform,
    arch,
    url,
    href: url ?? RELEASES_URL,
    label: labelFor(platform),
    tag,
  };
}
