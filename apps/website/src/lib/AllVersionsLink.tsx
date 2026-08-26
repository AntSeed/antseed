import React, {useCallback, useEffect, useState} from 'react';
import {DesktopDownloadIcon} from './DesktopDownloadIcon';
import {
  ALL_VERSIONS_URL,
  DOWNLOAD_BASE_URL,
  type DesktopPlatform,
} from './useLatestDesktopDownload';

/**
 * "All platforms & versions" — an escape hatch under the download CTAs for
 * visitors whose platform detection guessed wrong (privacy browsers spoof a
 * Windows UA on Linux, so the CTA offers the .exe) or who want a different
 * installer. Opens a modal listing every installer as download.antseed.com
 * links, so these downloads carry the same started/completed telemetry as
 * the main CTA.
 *
 * The list is hardcoded: the proxy always resolves /vpr/<target> to the
 * latest release server-side, so the links never go stale, and a target
 * missing from a partial release 302s to the GitHub releases page rather
 * than 404ing. Older versions and .deb packages stay on the GitHub releases
 * page, linked in the modal footer. Hidden on phone viewports, where the
 * CTAs become "Get Started".
 */

interface TargetRow {
  target: string;
  platform: DesktopPlatform;
  label: string;
  sub: string;
}

const TARGET_ROWS: TargetRow[] = [
  {target: 'mac-arm64', platform: 'mac', label: 'macOS', sub: 'Apple Silicon'},
  {target: 'mac-x64', platform: 'mac', label: 'macOS', sub: 'Intel'},
  {target: 'win-x64', platform: 'win', label: 'Windows', sub: 'x64 installer'},
  {target: 'linux-x64', platform: 'linux', label: 'Linux', sub: 'AppImage · x86_64'},
  {target: 'linux-arm64', platform: 'linux', label: 'Linux', sub: 'AppImage · ARM64'},
];

function AllVersionsModal({onClose}: {onClose: () => void}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return (
    <div className="vprVersionsOverlay" onClick={onClose} role="presentation">
      <div
        className="vprVersionsModal"
        role="dialog"
        aria-modal="true"
        aria-label="All download versions"
        onClick={e => e.stopPropagation()}
      >
        <div className="vprVersionsHead">
          <span className="vprVersionsTitle">Download AntSeed VPR</span>
          <button className="vprVersionsClose" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="vprVersionsList">
          {TARGET_ROWS.map(row => (
            <a
              key={row.target}
              className="vprVersionsRow"
              href={`${DOWNLOAD_BASE_URL}/vpr/${row.target}`}
            >
              <span className="vprVersionsIcon">
                <DesktopDownloadIcon platform={row.platform} size={20} />
              </span>
              <span className="vprVersionsName">
                {row.label}
                <span className="vprVersionsSub">{row.sub}</span>
              </span>
            </a>
          ))}
        </div>
        <a className="vprVersionsFooter" href={ALL_VERSIONS_URL}>
          Older versions &amp; .deb packages →
        </a>
      </div>
    </div>
  );
}

export function AllVersionsLink({light}: {light?: boolean}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        type="button"
        className={`vprAllVersions${light ? ' vprAllVersionsLight' : ''}`}
        onClick={() => setOpen(true)}
      >
        All platforms &amp; versions
      </button>
      {open && <AllVersionsModal onClose={close} />}
    </>
  );
}
