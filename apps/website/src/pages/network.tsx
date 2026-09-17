import React, {useEffect} from 'react';
import Head from '@docusaurus/Head';
import Layout from '@theme/Layout';

const EXPLORER_URL = 'https://antseedstats.com/network';

export default function NetworkRedirectPage() {
  useEffect(() => {
    window.location.replace(EXPLORER_URL);
  }, []);

  return (
    <Layout
      title="Redirecting to Antseed Network Explorer"
      description="Antseed live network pricing, providers, and usage statistics are available in the Antseed Network Explorer.">
      <Head>
        <meta name="robots" content="noindex" />
        <meta httpEquiv="refresh" content={`0; url=${EXPLORER_URL}`} />
        <link rel="canonical" href={EXPLORER_URL} />
      </Head>
      <main style={{padding: '4rem 1.5rem', textAlign: 'center'}}>
        <h1>Redirecting to the Antseed Network Explorer…</h1>
        <p>
          If you are not redirected automatically,{' '}
          <a href={EXPLORER_URL} target="_blank" rel="noopener noreferrer">open the live network explorer</a>.
        </p>
      </main>
    </Layout>
  );
}
