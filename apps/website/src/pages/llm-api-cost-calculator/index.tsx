import {useEffect, useMemo, useState} from 'react';
import Head from '@docusaurus/Head';
import Layout from '@theme/Layout';
import {
  ArrowRight,
  Button,
  Faq,
  FinalCta,
  PageHero,
  Reveal,
  Section,
  SectionHeader,
} from '../../components/ui';
import {
  ANTSEED_PROTOCOL_FEE_RATE,
  compareModelCost,
  pickFeaturedModel,
} from '../../lib/llmCostCatalog';
import {useLlmCostCatalog} from '../../lib/useLlmCostCatalog';
import styles from './styles.module.css';

const TITLE = 'LLM API Cost Calculator';
const DESCRIPTION =
  'Compare live OpenRouter model prices with the cheapest active AntSeed seller for your actual monthly input and output token usage.';
const SOCIAL_IMAGE = 'https://antseed.com/img/og-cost-calculator.png';
const DEFAULT_INPUT_MILLIONS = 22;
const DEFAULT_OUTPUT_MILLIONS = 5.5;

const FAQ_ITEMS = [
  {
    q: 'Where do the prices come from?',
    a: 'Model names and reference rates come directly from OpenRouter’s public models API. AntSeed rates come from active offers published to the peer-to-peer network and indexed by AntScan. The calculator does not ship with a model or price snapshot.',
  },
  {
    q: 'How is the cheapest AntSeed seller selected?',
    a: 'The calculator prices every active seller against the exact input/output mix entered above, adds the 4% AntSeed protocol fee, and selects the lowest total. Changing the token mix can therefore change the winning seller.',
  },
  {
    q: 'Why are some OpenRouter models missing?',
    a: 'A model appears only when OpenRouter publishes non-zero input and output rates and at least one active AntSeed seller advertises non-zero rates for the same model. The list updates automatically as either catalog changes.',
  },
  {
    q: 'Are these prices guaranteed?',
    a: 'No. They are live advertised rates, not a quote. Sellers can join, leave, or reprice, and OpenRouter can update its catalog. Refresh immediately before making a purchase decision.',
  },
];

function money(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function rate(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value < 1 ? 3 : 2,
    maximumFractionDigits: value < 1 ? 3 : 2,
  });
}

function time(value: number | null): string {
  if (!value) return 'just now';
  return new Intl.DateTimeFormat('en-US', {hour: 'numeric', minute: '2-digit'}).format(value);
}

function NumberField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className={styles.field} htmlFor={id}>
      <span className={styles.fieldLabel}>{label}</span>
      <span className={styles.numberControl}>
        <input
          id={id}
          type="number"
          min="0"
          step="0.1"
          inputMode="decimal"
          value={value}
          onChange={(event) => onChange(Math.max(0, Number(event.target.value) || 0))}
        />
        <span>million</span>
      </span>
    </label>
  );
}

export default function LlmApiCostCalculator(): JSX.Element {
  const {catalog, status, error, fetchedAt, networkUpdatedAt, refresh} = useLlmCostCatalog();
  const [modelId, setModelId] = useState('');
  const [inputMillions, setInputMillions] = useState(DEFAULT_INPUT_MILLIONS);
  const [outputMillions, setOutputMillions] = useState(DEFAULT_OUTPUT_MILLIONS);

  useEffect(() => {
    if (!catalog.length || catalog.some((model) => model.id === modelId)) return;
    setModelId(pickFeaturedModel(catalog, inputMillions, outputMillions)?.id || catalog[0].id);
  }, [catalog, inputMillions, modelId, outputMillions]);

  const selectedModel = useMemo(
    () => catalog.find((model) => model.id === modelId) || null,
    [catalog, modelId],
  );
  const comparison = useMemo(
    () => selectedModel ? compareModelCost(selectedModel, inputMillions, outputMillions) : null,
    [inputMillions, outputMillions, selectedModel],
  );
  const isSaving = comparison ? comparison.difference >= 0 : true;
  const feePercent = ANTSEED_PROTOCOL_FEE_RATE * 100;

  return (
    <Layout title={TITLE} description={DESCRIPTION}>
      <Head>
        <meta property="og:title" content={`${TITLE} | AntSeed`} />
        <meta property="og:description" content={DESCRIPTION} />
        <meta property="og:image" content={SOCIAL_IMAGE} />
        <meta property="og:image:alt" content="AntSeed live LLM API cost calculator" />
        <meta name="twitter:title" content={`${TITLE} | AntSeed`} />
        <meta name="twitter:description" content={DESCRIPTION} />
        <meta name="twitter:image" content={SOCIAL_IMAGE} />
        <script type="application/ld+json">
          {JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'WebApplication',
            name: TITLE,
            applicationCategory: 'FinanceApplication',
            operatingSystem: 'Any',
            description: DESCRIPTION,
            offers: {price: '0', priceCurrency: 'USD'},
          })}
        </script>
        <script type="application/ld+json">
          {JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'FAQPage',
            mainEntity: FAQ_ITEMS.map((item) => ({
              '@type': 'Question',
              name: item.q,
              acceptedAnswer: {'@type': 'Answer', text: item.a},
            })),
          })}
        </script>
      </Head>

      <PageHero
        kicker="Live LLM pricing"
        title={<>See what your tokens cost <em>right now.</em></>}
        lead="Choose a model, enter your monthly usage, and compare OpenRouter’s current rate with the cheapest active seller on AntSeed. No maintained price table, no stale fallback."
        animatedDots
      />

      <Section tone="tinted" width="xl" className={styles.calculatorSection}>
        <Reveal className={styles.calculatorShell}>
          <div className={styles.controlsPane}>
            <div className={styles.liveHeader}>
              <div>
                <span className={`${styles.liveDot} ${status === 'ready' ? styles.liveDotReady : ''}`} />
                <span className={styles.liveLabel}>
                  {status === 'ready' ? `${catalog.length} live matched models` : 'Connecting to live pricing'}
                </span>
              </div>
              <button type="button" className={styles.refreshButton} onClick={refresh} disabled={status === 'loading'}>
                Refresh
              </button>
            </div>

            <div className={styles.controlsTitleBlock}>
              <h2>Price your workload</h2>
              <p>Usage is entered in millions of tokens, matching how API rates are published.</p>
            </div>

            <label className={styles.field} htmlFor="model">
              <span className={styles.fieldLabel}>Model</span>
              <select
                id="model"
                value={modelId}
                disabled={status !== 'ready'}
                onChange={(event) => setModelId(event.target.value)}>
                {status !== 'ready' ? <option>Loading live models…</option> : null}
                {catalog.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name} · {model.provider}
                  </option>
                ))}
              </select>
            </label>

            <div className={styles.tokenGrid}>
              <NumberField id="input-tokens" label="Input tokens / month" value={inputMillions} onChange={setInputMillions} />
              <NumberField id="output-tokens" label="Output tokens / month" value={outputMillions} onChange={setOutputMillions} />
            </div>

            <div className={styles.sourceNote}>
              <span>Fetched {time(networkUpdatedAt || fetchedAt)}</span>
              <span aria-hidden="true">·</span>
              <a href="https://openrouter.ai/api/v1/models" target="_blank" rel="noopener noreferrer">OpenRouter API</a>
              <span aria-hidden="true">+</span>
              <a href="https://antscan.co/api/network" target="_blank" rel="noopener noreferrer">AntScan network API</a>
            </div>
          </div>

          <div className={styles.resultsPane} aria-live="polite">
            {status === 'loading' ? (
              <div className={styles.loadingState}>
                <span className={styles.loadingMark} aria-hidden="true" />
                <h2>Reading both live markets…</h2>
                <p>The calculator only renders prices after both sources respond.</p>
              </div>
            ) : null}

            {status === 'error' ? (
              <div className={styles.errorState}>
                <span className={styles.errorEyebrow}>Live data unavailable</span>
                <h2>We could not verify current prices.</h2>
                <p>{error}</p>
                <button type="button" className={styles.retryButton} onClick={refresh}>Try again <ArrowRight size={16} /></button>
              </div>
            ) : null}

            {status === 'ready' && selectedModel && comparison ? (
              <>
                <div className={styles.resultHeading}>
                  <div>
                    <span className={styles.resultKicker}>{selectedModel.provider}</span>
                    <h2>{selectedModel.name}</h2>
                  </div>
                  <span className={styles.sellerPill}>
                    {selectedModel.sellerCount} {selectedModel.sellerCount === 1 ? 'seller' : 'sellers'}
                  </span>
                </div>

                <div className={styles.priceCards}>
                  <article className={styles.priceCard}>
                    <span className={styles.priceCardLabel}>OpenRouter</span>
                    <strong>{money(comparison.openRouterCost)}</strong>
                    <span className={styles.priceCardPeriod}>per month</span>
                    <dl>
                      <div><dt>Input / 1M</dt><dd>{rate(selectedModel.openRouterInputUsdPerMillion)}</dd></div>
                      <div><dt>Output / 1M</dt><dd>{rate(selectedModel.openRouterOutputUsdPerMillion)}</dd></div>
                    </dl>
                  </article>

                  <article className={`${styles.priceCard} ${styles.antseedCard}`}>
                    <span className={styles.priceCardLabel}>Best on AntSeed</span>
                    <strong>{money(comparison.antseedCost)}</strong>
                    <span className={styles.priceCardPeriod}>per month · fee included</span>
                    <dl>
                      <div><dt>Input / 1M</dt><dd>{rate(comparison.bestOffer.inputUsdPerMillion)}</dd></div>
                      <div><dt>Output / 1M</dt><dd>{rate(comparison.bestOffer.outputUsdPerMillion)}</dd></div>
                    </dl>
                  </article>
                </div>

                <div className={`${styles.verdict} ${isSaving ? styles.verdictSaving : styles.verdictDirect}`}>
                  <span className={styles.verdictEyebrow}>{isSaving ? 'AntSeed is cheaper' : 'OpenRouter is cheaper'}</span>
                  <strong>
                    {money(Math.abs(comparison.difference))}
                    <small>{Math.abs(comparison.differencePercent).toFixed(1)}%</small>
                  </strong>
                  <p>
                    {isSaving
                      ? `Saved at this usage mix with ${comparison.bestOffer.sellerName}.`
                      : `Buying through OpenRouter costs less for this model and usage mix.`}
                  </p>
                </div>

                <p className={styles.feeNote}>
                  AntSeed total includes the {feePercent}% protocol fee. Prices are live advertised rates, not quotes.
                </p>
              </>
            ) : null}
          </div>
        </Reveal>
      </Section>

      <Section width="lg">
        <Reveal>
          <SectionHeader
            kicker="How it stays current"
            title="The page is a live join, not a price spreadsheet."
            lead="Every refresh rebuilds the available catalog from the two public feeds."
          />
        </Reveal>
        <div className={styles.stepsGrid}>
          <Reveal className={styles.stepCard}>
            <span>01</span>
            <h3>Read OpenRouter</h3>
            <p>Load the current model catalog and convert its per-token input and output rates to prices per million.</p>
          </Reveal>
          <Reveal className={styles.stepCard} delay={80}>
            <span>02</span>
            <h3>Match live sellers</h3>
            <p>Normalize model identifiers, ignore zero-price placeholders, and keep only models available in both markets.</p>
          </Reveal>
          <Reveal className={styles.stepCard} delay={160}>
            <span>03</span>
            <h3>Price your exact mix</h3>
            <p>Re-rank every seller when your input/output ratio changes, then include the protocol fee in the result.</p>
          </Reveal>
        </div>
      </Section>

      <Section tone="tinted" width="md">
        <Reveal>
          <SectionHeader kicker="Fair questions" title="What the comparison does—and does not—claim." />
        </Reveal>
        <Reveal delay={80}>
          <Faq items={FAQ_ITEMS} />
        </Reveal>
      </Section>

      <FinalCta
        title="Route the cheaper model from your own machine."
        sub="AntSeed exposes an OpenAI-compatible local endpoint, so existing tools only need a base URL change."
        note={<span>Open source · pay per request · no account required</span>}>
        <Button to="/docs/install" variant="white" arrow>Install AntSeed</Button>
        <Button to="/vs/openrouter" variant="light">Compare the networks</Button>
      </FinalCta>
    </Layout>
  );
}
