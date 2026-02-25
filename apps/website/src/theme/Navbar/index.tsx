import Link from '@docusaurus/Link';
import {useLocation} from '@docusaurus/router';

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

export default function Navbar(): JSX.Element {
  const location = useLocation();

  const scrollToTop = () => {
    window.scrollTo({top: 0, behavior: 'smooth'});
  };

  // Determine docs link target
  const docsTo = location.pathname.startsWith('/docs') ? location.pathname : '/docs/intro';

  return (
    <nav
      className="navbar navbar--fixed-top"
      style={{
        position: 'fixed',
        top: 0,
        width: '100%',
        zIndex: 100,
        padding: '20px 56px',
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
      <div style={{display: 'flex', alignItems: 'center', gap: '32px'}}>
        <Link
          to={docsTo}
          onClick={scrollToTop}
          className="custom-nav-link"
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '12px',
            color: '#8b949e',
            letterSpacing: '3px',
            textTransform: 'uppercase',
            textDecoration: 'none',
            transition: 'color 0.2s',
          }}
        >
          Docs
        </Link>
        <a
          href="https://github.com/antseed"
          target="_blank"
          rel="noopener noreferrer"
          className="custom-nav-github"
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '12px',
            padding: '8px 20px',
            border: '1px solid rgba(61, 255, 162, 0.09)',
            color: '#8b949e',
            borderRadius: '6px',
            textDecoration: 'none',
            transition: 'all 0.2s',
            letterSpacing: '3px',
            textTransform: 'uppercase',
          }}
        >
          GitHub
        </a>
      </div>
    </nav>
  );
}
