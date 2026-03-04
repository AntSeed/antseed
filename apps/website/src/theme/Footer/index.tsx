import Link from '@docusaurus/Link';

const linkStyle = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '11px',
  color: '#484F58',
  letterSpacing: '1px',
  textDecoration: 'none',
  transition: 'color 0.2s',
};

export default function Footer(): JSX.Element {
  return (
    <footer
      style={{
        padding: '40px 56px',
        borderTop: '1px solid rgba(61, 255, 162, 0.03)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '16px',
      }}
    >
      {/* Copyright */}
      <div style={{fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', color: '#484F58', letterSpacing: '1px'}}>
        &copy; 2026 AntSeed Protocol
      </div>

      {/* Links */}
      <div style={{display: 'flex', gap: '24px'}}>
        <Link to="/docs/intro" className="custom-footer-link" style={linkStyle}>Docs</Link>
        <Link to="/docs/lightpaper" className="custom-footer-link" style={linkStyle}>Light Paper</Link>
        <Link to="/blog" className="custom-footer-link" style={linkStyle}>Blog</Link>
      </div>

      {/* Social icons */}
      <div style={{display: 'flex', gap: '16px', alignItems: 'center'}}>
        <a href="https://github.com/antseed" target="_blank" rel="noopener noreferrer" title="GitHub" style={{color: '#484F58', transition: 'color 0.2s'}} className="custom-footer-link">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 00-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0020 4.77 5.07 5.07 0 0019.91 1S18.73.65 16 2.48a13.38 13.38 0 00-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 005 4.77a5.44 5.44 0 00-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 009 18.13V22"/>
          </svg>
        </a>
        <a href="https://x.com/antseedai" target="_blank" rel="noopener noreferrer" title="X / Twitter" style={{color: '#484F58', transition: 'color 0.2s'}} className="custom-footer-link">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M4 4l11.7 16h4.3M4 20L20 4"/>
          </svg>
        </a>
        <a href="https://t.me/antseed" target="_blank" rel="noopener noreferrer" title="Telegram" style={{color: '#484F58', transition: 'color 0.2s'}} className="custom-footer-link">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.2 4.4L2.4 10.7c-.6.2-.6 1.1.1 1.3l4.8 1.5 1.9 6c.1.4.6.5.9.3l2.7-2.2 5.3 3.9c.4.3 1 .1 1.1-.4l3.2-15.3c.1-.6-.5-1-.2-.9z"/>
            <path d="M8.3 13.5l9.7-7.4"/>
          </svg>
        </a>
        <a href="https://discord.gg/antseed" target="_blank" rel="noopener noreferrer" title="Discord" style={{color: '#484F58', transition: 'color 0.2s'}} className="custom-footer-link">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M8.5 14.5A1.5 1.5 0 1 0 8.5 11.5 1.5 1.5 0 1 0 8.5 14.5z"/>
            <path d="M15.5 14.5A1.5 1.5 0 1 0 15.5 11.5 1.5 1.5 0 1 0 15.5 14.5z"/>
            <path d="M6 7c1-1 3-2 6-2s5 1 6 2"/>
            <path d="M6 17c1 1 3 2 6 2s5-1 6-2"/>
            <path d="M4 8l-1 5c0 3 2 5 4 6"/>
            <path d="M20 8l1 5c0 3-2 5-4 6"/>
          </svg>
        </a>
      </div>
    </footer>
  );
}
