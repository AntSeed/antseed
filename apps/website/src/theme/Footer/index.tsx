import Link from '@docusaurus/Link';

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
      <div
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '11px',
          color: '#484F58',
          letterSpacing: '1px',
        }}
      >
        &copy; 2026 AntSeed Protocol
      </div>
      <div style={{display: 'flex', gap: '24px'}}>
        <Link
          to="/docs/intro"
          className="custom-footer-link"
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '11px',
            color: '#484F58',
            letterSpacing: '1px',
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
          className="custom-footer-link"
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '11px',
            color: '#484F58',
            letterSpacing: '1px',
            textDecoration: 'none',
            transition: 'color 0.2s',
          }}
        >
          GitHub
        </a>
        <Link
          to="/docs/lightpaper"
          className="custom-footer-link"
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '11px',
            color: '#484F58',
            letterSpacing: '1px',
            textDecoration: 'none',
            transition: 'color 0.2s',
          }}
        >
          Light Paper
        </Link>
        <a
          href="https://x.com/antseedai"
          target="_blank"
          rel="noopener noreferrer"
          className="custom-footer-link"
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '11px',
            color: '#484F58',
            letterSpacing: '1px',
            textDecoration: 'none',
            transition: 'color 0.2s',
          }}
        >
          Twitter
        </a>
      </div>
    </footer>
  );
}
