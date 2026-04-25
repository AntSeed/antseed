import Head from '@docusaurus/Head';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import styles from './openrouter.module.css';

const ROWS: Array<{dim: string; antseed: string; openrouter: string}> = [
  {
    dim: 'Architecture',
    antseed: 'Peer-to-peer network. Requests go direct from buyer to provider.',
    openrouter: 'Centralized aggregator. Every request flows through their servers.',
  },
  {
    dim: 'Provider onboarding',
    antseed: "Permissionless. Run the node binary; you're live.",
    openrouter: 'Approval-based. Models curated by the platform.',
  },
  {
    dim: 'Payments',
    antseed: 'On-chain USDC, per request, settled directly to provider wallet.',
    openrouter: 'Credit card top-ups. Platform holds earnings until payout.',
  },
  {
    dim: 'Account required',
    antseed: 'No. No email, no API keys issued by a platform.',
    openrouter: 'Yes. Sign-up, API key issuance, account-level limits.',
  },
  {
    dim: 'Platform fee',
    antseed: 'No platform cut on inference. Provider sets the price.',
    openrouter: 'Platform fee on top of provider pricing.',
  },
  {
    dim: 'Request privacy',
    antseed: "Prompts go peer-to-peer. The network operator doesn't exist.",
    openrouter: 'Every prompt transits their infrastructure.',
  },
  {
    dim: 'Can be shut down',
    antseed: 'No central company. No single off switch.',
    openrouter: 'Single company can be sued, acquired, or deplatformed.',
  },
  {
    dim: 'OpenAI SDK compatible',
    antseed: 'Yes. Point base_url at your local gateway.',
    openrouter: 'Yes.',
  },
  {
    dim: 'Agent-ready',
    antseed: 'Designed for it. USDC-native, no account, always-on discovery.',
    openrouter: 'Works via API key, but the account model assumes a human operator.',
  },
];

const TITLE = 'OpenRouter Alternative: Permissionless P2P AI Inference | AntSeed';
const DESCRIPTION =
  'AntSeed is a permissionless, peer-to-peer alternative to OpenRouter. Any provider can join. Requests go direct. Pay per request in USDC — no accounts, no platform fee.';

export default function VsOpenRouter(): JSX.Element {
  return (
    <Layout title="OpenRouter Alternative" description={DESCRIPTION}>
      <Head>
        <title>{TITLE}</title>
        <meta name="description" content={DESCRIPTION} />
        <meta property="og:title" content={TITLE} />
        <meta property="og:description" content={DESCRIPTION} />
        <link rel="canonical" href="https://antseed.com/vs/openrouter" />
        <script type="application/ld+json">
          {JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'FAQPage',
            mainEntity: [
              {
                '@type': 'Question',
                name: 'What is the main difference between AntSeed and OpenRouter?',
                acceptedAnswer: {
                  '@type': 'Answer',
                  text:
                    "OpenRouter is a centralized aggregator; AntSeed is a peer-to-peer network. OpenRouter curates which providers are listed and routes every request through their servers. AntSeed lets any provider join permissionlessly, and requests go directly from the buyer's local gateway to the provider.",
                },
              },
              {
                '@type': 'Question',
                name: 'Do I need an account to use AntSeed?',
                acceptedAnswer: {
                  '@type': 'Answer',
                  text:
                    'No. AntSeed has no sign-up, no email, and no platform-issued API keys. A local gateway connects you to the peer-to-peer network, and payments settle on-chain in USDC.',
                },
              },
              {
                '@type': 'Question',
                name: 'How does AntSeed handle payments compared to OpenRouter?',
                acceptedAnswer: {
                  '@type': 'Answer',
                  text:
                    "OpenRouter uses credit card top-ups and holds provider earnings until a payout. AntSeed settles each request on-chain in USDC, directly to the provider's wallet. There is no platform escrow.",
                },
              },
              {
                '@type': 'Question',
                name: 'Is AntSeed OpenAI SDK compatible like OpenRouter?',
                acceptedAnswer: {
                  '@type': 'Answer',
                  text:
                    'Yes. Point the OpenAI SDK base_url at your local AntSeed gateway (http://localhost:8377/v1 by default). Existing OpenAI or OpenRouter code works with no changes beyond the URL.',
                },
              },
            ],
          })}
        </script>
      </Head>

      <div className={styles.page}>
        <div className={styles.header}>
          <p className={styles.eyebrow}>OpenRouter Alternative</p>
          <h1 className={styles.title}>A permissionless, peer-to-peer alternative to OpenRouter.</h1>
          <p className={styles.subtitle}>
            Same OpenAI-compatible API. Any provider can join. Pay per request in USDC.
            No accounts, no platform fee, no central operator.
          </p>
          <div className={styles.ctaRow}>
            <Link to="/docs/install" className={styles.ctaPrimary}>Install AntSeed</Link>
            <Link to="/network" className={styles.ctaSecondary}>Live pricing →</Link>
          </div>
        </div>

        <div className={styles.table}>
          <div className={styles.tableHead}>
            <div className={styles.colDim}></div>
            <div className={styles.colAnt}>AntSeed</div>
            <div className={styles.colOr}>OpenRouter</div>
          </div>
          {ROWS.map((row) => (
            <div key={row.dim} className={styles.tableRow}>
              <div className={styles.colDim}>{row.dim}</div>
              <div className={styles.colAnt}>{row.antseed}</div>
              <div className={styles.colOr}>{row.openrouter}</div>
            </div>
          ))}
        </div>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>When to pick AntSeed</h2>
          <ul className={styles.list}>
            <li>You want to run inference without creating another SaaS account.</li>
            <li>You're building an agent that needs to pay for its own inference.</li>
            <li>You want payments to settle per request, on-chain, with no platform holding funds.</li>
            <li>You want to <Link to="/providers">serve</Link> a model and get paid without applying to a platform.</li>
            <li>You need a routing layer with no central company behind it.</li>
          </ul>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>When OpenRouter might still fit</h2>
          <ul className={styles.list}>
            <li>You prefer a credit-card-funded account over an on-chain wallet.</li>
            <li>You want a single vendor relationship with a support contact.</li>
            <li>You're fine with the platform routing every request through their servers.</li>
          </ul>
        </section>

        <section className={styles.footerCta}>
          <h2>Get started in one command.</h2>
          <pre className={styles.code}>curl -fsSL https://antseed.com/install.sh | sh</pre>
          <p className={styles.footerNote}>
            Open source. Runs locally. <Link to="/docs/install">Full install guide →</Link>
          </p>
        </section>
      </div>
    </Layout>
  );
}
