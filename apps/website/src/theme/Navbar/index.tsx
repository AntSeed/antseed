import Link from '@docusaurus/Link';
import {useLocation} from '@docusaurus/router';
import {useNavbarMobileSidebar} from '@docusaurus/theme-common/internal';
import NavbarMobileSidebar from '@theme/Navbar/MobileSidebar';

function NavLogo() {
  return (
    <svg width="32" height="32" viewBox="0 0 80 80" fill="none">
      <ellipse cx="40" cy="22" rx="5" ry="5.5" fill="#3dffa2" opacity="0.9" />
      <ellipse cx="40" cy="36" rx="7" ry="8" fill="#3dffa2" />
      <ellipse cx="40" cy="55" rx="9" ry="12" fill="#3dffa2" opacity="0.9" />
      <line x1="37" y1="17" x2="28" y2="6" stroke="#3dffa2" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
      <line x1="43" y1="17" x2="52" y2="6" stroke="#3dffa2" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
      <circle cx="28" cy="6" r="2.5" fill="#3dffa2" opacity="0.6" />
      <circle cx="52" cy="6" r="2.5" fill="#3dffa2" opacity="0.6" />
      <line x1="34" y1="30" x2="18" y2="22" stroke="#3dffa2" strokeWidth="1.3" strokeLinecap="round" opacity="0.5" />
      <line x1="46" y1="30" x2="62" y2="22" stroke="#3dffa2" strokeWidth="1.3" strokeLinecap="round" opacity="0.5" />
      <circle cx="18" cy="22" r="2.5" fill="#3dffa2" opacity="0.5" />
      <circle cx="62" cy="22" r="2.5" fill="#3dffa2" opacity="0.5" />
      <line x1="33" y1="38" x2="14" y2="40" stroke="#3dffa2" strokeWidth="1.3" strokeLinecap="round" opacity="0.5" />
      <line x1="47" y1="38" x2="66" y2="40" stroke="#3dffa2" strokeWidth="1.3" strokeLinecap="round" opacity="0.5" />
      <circle cx="14" cy="40" r="2.5" fill="#3dffa2" opacity="0.5" />
      <circle cx="66" cy="40" r="2.5" fill="#3dffa2" opacity="0.5" />
      <line x1="34" y1="52" x2="16" y2="60" stroke="#3dffa2" strokeWidth="1.3" strokeLinecap="round" opacity="0.5" />
      <line x1="46" y1="52" x2="64" y2="60" stroke="#3dffa2" strokeWidth="1.3" strokeLinecap="round" opacity="0.5" />
      <circle cx="16" cy="60" r="2.5" fill="#3dffa2" opacity="0.5" />
      <circle cx="64" cy="60" r="2.5" fill="#3dffa2" opacity="0.5" />
      <line x1="18" y1="22" x2="14" y2="40" stroke="#3dffa2" strokeWidth="0.7" strokeLinecap="round" opacity="0.15" />
      <line x1="62" y1="22" x2="66" y2="40" stroke="#3dffa2" strokeWidth="0.7" strokeLinecap="round" opacity="0.15" />
      <line x1="14" y1="40" x2="16" y2="60" stroke="#3dffa2" strokeWidth="0.7" strokeLinecap="round" opacity="0.15" />
      <line x1="66" y1="40" x2="64" y2="60" stroke="#3dffa2" strokeWidth="0.7" strokeLinecap="round" opacity="0.15" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function TelegramIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M11.944 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0a12 12 0 00-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 01.171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  );
}

const iconLinkStyle = {
  color: '#8b949e',
  transition: 'color 0.2s',
  display: 'flex',
  alignItems: 'center',
};

export default function Navbar(): JSX.Element {
  const location = useLocation();
  const isDocsPage = location.pathname.startsWith('/docs');
  const mobileSidebar = useNavbarMobileSidebar();

  const scrollToTop = () => {
    window.scrollTo({top: 0, behavior: 'smooth'});
  };

  // Determine docs link target
  const docsTo = location.pathname.startsWith('/docs') ? location.pathname : '/docs/intro';

  return (
    <>
    <nav
      className="navbar navbar--fixed-top"
      style={{
        position: 'fixed',
        top: 0,
        width: '100%',
        zIndex: 100,
        padding: 'clamp(16px, 4vw, 20px) clamp(16px, 4vw, 56px)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        background: 'rgba(10, 14, 20, 0.8)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderBottom: '1px solid rgba(61, 255, 162, 0.07)',
        boxSizing: 'border-box',
        height: '73px',
      }}
    >
      <Link
        to="/"
        onClick={scrollToTop}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          textDecoration: 'none',
        }}
      >
        <NavLogo />
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontWeight: 700,
            fontSize: '18px',
            letterSpacing: '-1px',
          }}
        >
          <span style={{color: '#e6edf3'}}>ANT</span>
          <span style={{color: '#3dffa2'}}>SEED</span>
        </span>
      </Link>
      <div style={{display: 'flex', alignItems: 'center', gap: '20px'}}>
        <a
          href="https://github.com/antseed"
          target="_blank"
          rel="noopener noreferrer"
          className="custom-nav-link custom-nav-github"
          style={iconLinkStyle}
          title="GitHub"
        >
          <GitHubIcon />
        </a>
        <a
          href="https://x.com/antseedai"
          target="_blank"
          rel="noopener noreferrer"
          className="custom-nav-link custom-nav-github"
          style={iconLinkStyle}
          title="X (Twitter)"
        >
          <XIcon />
        </a>
        <a
          href="https://t.me/antseed"
          target="_blank"
          rel="noopener noreferrer"
          className="custom-nav-link custom-nav-github"
          style={iconLinkStyle}
          title="Telegram"
        >
          <TelegramIcon />
        </a>
        <Link
          to="/blog"
          className="custom-nav-link"
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '12px',
            fontWeight: 500,
            color: '#8b949e',
            letterSpacing: '1px',
            textDecoration: 'none',
            transition: 'color 0.2s',
          }}
        >
          Blog
        </Link>
        <Link
          to={docsTo}
          onClick={scrollToTop}
          className="custom-nav-link nav-docs-btn"
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '12px',
            fontWeight: 500,
            color: '#8b949e',
            letterSpacing: '1px',
            textDecoration: 'none',
            background: 'transparent',
            border: '1px solid rgba(61, 255, 162, 0.09)',
            borderRadius: '6px',
            padding: '8px 20px',
            transition: 'all 0.2s',
          }}
        >
          Docs
        </Link>
      </div>
    </nav>
    {/* Mobile docs sidebar toggle — only on docs pages, only on mobile */}
    {isDocsPage && (
      <button
        onClick={() => mobileSidebar.toggle()}
        className="mobile-docs-hamburger"
        aria-label="Toggle docs menu"
      >
        ☰
      </button>
    )}
    {isDocsPage && <NavbarMobileSidebar />}
    </>
  );
}
