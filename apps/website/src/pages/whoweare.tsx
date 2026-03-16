import {useState, useCallback} from 'react';
import Head from '@docusaurus/Head';

const PASSWORD = 'Antagent';

export default function WhoWeAre(): JSX.Element {
  const [input, setInput] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [error, setError] = useState(false);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (input === PASSWORD) {
        setAuthenticated(true);
        setError(false);
      } else {
        setError(true);
      }
    },
    [input],
  );

  if (authenticated) {
    return (
      <>
        <Head>
          <title>What We Are Building — AntSeed</title>
          <meta name="robots" content="noindex, nofollow" />
        </Head>
        <iframe
          src="/antseed_what_we_build.html"
          style={{
            width: '100%',
            height: '100vh',
            border: 'none',
            display: 'block',
          }}
          title="What We Are Building"
        />
      </>
    );
  }

  return (
    <>
      <Head>
        <title>Access — AntSeed</title>
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0F0F0E',
          fontFamily:
            "'Space Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
        }}
      >
        <form
          onSubmit={handleSubmit}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '20px',
            padding: '48px',
            background: '#1a1a1a',
            borderRadius: '16px',
            border: '1px solid rgba(31,216,122,0.15)',
            maxWidth: '400px',
            width: '90%',
          }}
        >
          <div
            style={{
              fontWeight: 800,
              fontSize: '22px',
              letterSpacing: '-0.5px',
              color: 'white',
            }}
          >
            <span>ANT</span>
            <span style={{color: '#1FD87A'}}>SEED</span>
          </div>
          <p
            style={{
              color: 'rgba(255,255,255,0.45)',
              fontSize: '14px',
              textAlign: 'center',
              margin: 0,
              lineHeight: 1.6,
            }}
          >
            Enter the password to continue.
          </p>
          <input
            type="password"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setError(false);
            }}
            placeholder="Password"
            autoFocus
            style={{
              width: '100%',
              padding: '12px 16px',
              borderRadius: '8px',
              border: error
                ? '1px solid #ff5f57'
                : '1px solid rgba(255,255,255,0.12)',
              background: '#0F0F0E',
              color: 'white',
              fontSize: '15px',
              fontFamily: 'inherit',
              outline: 'none',
            }}
          />
          {error && (
            <span style={{color: '#ff5f57', fontSize: '13px', marginTop: '-12px'}}>
              Incorrect password.
            </span>
          )}
          <button
            type="submit"
            style={{
              width: '100%',
              padding: '13px',
              borderRadius: '8px',
              border: 'none',
              background: '#1FD87A',
              color: '#0F0F0E',
              fontWeight: 700,
              fontSize: '14px',
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            Enter
          </button>
        </form>
      </div>
    </>
  );
}
