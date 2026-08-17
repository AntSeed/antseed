import {useEffect, useMemo, useState} from 'react';
import Layout from '@theme/Layout';
import Head from '@docusaurus/Head';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import styles from './styles.module.css';

const ANTSCAN = 'https://antscan.co/api/network';
// OpenRouter is the reference feed. It is named here and nowhere in the visible
// copy: it is a marketplace with its own margin, so its rate is a real
// published price but not always the provider's direct one. See the note on
// `.who` copy below before relabelling anything.
const OPENROUTER = 'https://openrouter.ai/api/v1/models';
const FEE = 0.04; // AntSeed protocol fee
const PATH = '/llm-api-cost-calculator/';

// The month the calculator opens with, and the weighting used to rank sellers.
const REF_IN = 22;
const REF_OUT = 5.5;

const TITLE = 'LLM API Cost Calculator';
const DESC =
  'Enter the tokens you burn in a month and compare live prices for Claude, GPT, ' +
  'DeepSeek and more: the standard rate versus the cheapest seller on the AntSeed network.';

const FAQ = [
  {
    q: 'How many tokens does one developer use per month?',
    a: 'A developer coding daily with an agent runs roughly 22 million input tokens and 5.5 million output tokens a month. That profile sits inside the $150 to $250 per developer per month range Anthropic publishes for Claude Code, which is why the calculator starts there.',
  },
  {
    q: 'Where do I find my own token usage?',
    a: 'Every provider shows it in the usage dashboard of their console, split into input and output. If you use Claude Code, running ccusage in your terminal prints the same totals per day and per month. Add up a full month and enter both figures in millions.',
  },
  {
    q: 'What counts as input and what counts as output?',
    a: 'Input is everything you send: the prompt, the chat history, attached files and system instructions. Output is everything the model writes back, including reasoning tokens. Output costs several times more per token, so it usually drives the bill.',
  },
  {
    q: 'Why is a seller on AntSeed cheaper?',
    a: 'AntSeed is an open marketplace, so sellers compete on price for the same model weights instead of quoting one published rate. The gap is widest where the standard price carries the most margin, and it closes on models already priced near cost.',
  },
  {
    q: 'Are these prices guaranteed?',
    a: 'No. Both sides are live advertised rates, not quotes. Sellers join, leave and reprice through the day, and published rates move too. The figure includes the 4% AntSeed protocol fee but should be treated as a snapshot.',
  },
];

// ---------------------------------------------------------------------------
// DeepSeek is the one vendor whose reference price does not come from the feed.
//
// It moved to time-based billing at 16:00 UTC on 16 Aug 2026: peak hours are
// 01:00-04:00 and 06:00-10:00 UTC, and peak costs exactly double off-peak. A
// blended marketplace rate cannot express that split at all, and for these two
// models it is also simply wrong — the feed carried V4 Pro at ~$1.17 input
// while DeepSeek's own published rate was $0.435. So these two take their
// reference price from DeepSeek's published pricing instead.
//
// Input uses the cache-miss column, which is what an uncached month of tokens
// actually bills at. Keyed by normalised service id, so only the two models the
// rates are published for are affected; every other DeepSeek model on the
// network still prices off the feed.
// ---------------------------------------------------------------------------

/** 16:00 UTC, 16 Aug 2026 — the moment split billing starts. */
const DEEPSEEK_CUTOVER = Date.UTC(2026, 7, 16, 16, 0, 0);

const DEEPSEEK_RATES: Record<string, {before: [number, number]; offPeak: [number, number]}> = {
  deepseekv4pro: {before: [0.435, 0.87], offPeak: [0.66, 1.98]},
  deepseekv4flash: {before: [0.14, 0.28], offPeak: [0.22, 0.66]},
};

/** Peak is 01:00-04:00 and 06:00-10:00 UTC; every other hour is off-peak. */
const isPeakUtc = (d: Date): boolean => {
  const h = d.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
};

/**
 * DeepSeek's own published rate at `now`, plus the label to show beside it, or
 * null for any model it is not published for.
 */
const deepseekRate = (
  key: string,
  now: Date,
): {rate: [number, number]; note: string} | null => {
  const r = DEEPSEEK_RATES[key];
  if (!r) return null;
  // Pre-cutover branch. Dead after 16:00 UTC on 16 Aug 2026 and safe to delete then.
  if (now.getTime() < DEEPSEEK_CUTOVER) {
    return {rate: r.before, note: 'flat rate, until 16:00 UTC on 16 Aug'};
  }
  if (isPeakUtc(now)) {
    return {rate: [r.offPeak[0] * 2, r.offPeak[1] * 2], note: 'peak rate, right now'};
  }
  return {rate: r.offPeak, note: 'off-peak rate, right now'};
};

type Entry = {
  /** Ranking cost for a REF_IN / REF_OUT month, used to pick the cheapest seller. */
  c: number;
  service: string;
  name: string;
  vendor: string;
  /** Reference [input, output] $ per 1M. */
  ref: [number, number];
  /** Set when the reference rate is time-based, e.g. DeepSeek's peak/off-peak split. */
  note?: string;
  /** Cheapest seller's [input, output] $ per 1M, before the protocol fee. */
  ants: [number, number];
  seller: string;
  sellers: number;
};

type Offering = {
  service?: string;
  sellerName?: string;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
};

type RefModel = {
  id?: string;
  name?: string;
  pricing?: {prompt?: string; completion?: string};
};

/** Strip vendor prefix and punctuation so antscan slugs match OpenRouter ids. */
const norm = (s: unknown): string =>
  String(s)
    .toLowerCase()
    .replace(/^[a-z0-9-]+\//, '')
    .replace(/[^a-z0-9]/g, '');

const money = (v: number): string =>
  '$' + v.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});

const perM = (v: number): string => '$' + (v < 1 ? v.toFixed(3) : v.toFixed(2));

const VENDOR_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  'z-ai': 'Z.ai',
  'x-ai': 'xAI',
  moonshotai: 'Moonshot',
  minimax: 'MiniMax',
  qwen: 'Qwen',
  google: 'Google',
  mistralai: 'Mistral',
  'meta-llama': 'Meta',
  inception: 'Inception',
  meta: 'Meta',
  nvidia: 'NVIDIA',
  xiaomi: 'Xiaomi',
};

const vendorOf = (id: string): string => {
  const v = String(id).split('/')[0];
  return VENDOR_NAMES[v] || v.charAt(0).toUpperCase() + v.slice(1);
};

/** An offering only counts if both sides carry a real price. $0 entries are placeholders. */
const priced = (o: Offering): boolean =>
  typeof o.inputUsdPerMillion === 'number' &&
  o.inputUsdPerMillion > 0 &&
  typeof o.outputUsdPerMillion === 'number' &&
  o.outputUsdPerMillion > 0;

export default function CostCalculator(): JSX.Element {
  const {siteConfig} = useDocusaurusContext();
  const base = siteConfig?.url || 'https://antseed.com';
  const canonical = base + PATH;

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [catalog, setCatalog] = useState<Entry[]>([]);
  const [updatedAt, setUpdatedAt] = useState<number | string | null>(null);
  const [model, setModel] = useState('');
  const [tin, setTin] = useState(String(REF_IN));
  const [tout, setTout] = useState(String(REF_OUT));

  useEffect(() => {
    let alive = true;
    const timeout = (ms: number) =>
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));

    const load = async () => {
      try {
        const [net, or] = await Promise.race([
          Promise.all([
            fetch(ANTSCAN, {cache: 'no-store'}).then((r) => {
              if (!r.ok) throw new Error('antscan ' + r.status);
              return r.json() as Promise<{offerings?: Offering[]; updatedAt?: number}>;
            }),
            fetch(OPENROUTER).then((r) => {
              if (!r.ok) throw new Error('openrouter ' + r.status);
              return r.json() as Promise<{data?: RefModel[]}>;
            }),
          ]),
          timeout(12000),
        ]);
        if (!alive) return;

        // Index the reference feed by normalised id.
        const ref = new Map<string, {id: string; name: string; in: number; out: number}>();
        for (const m of or.data || []) {
          const p = m.pricing || {};
          const i = parseFloat(p.prompt ?? '') * 1e6;
          const o = parseFloat(p.completion ?? '') * 1e6;
          if (!(i > 0) || !(o > 0)) continue;
          const id = String(m.id ?? '');
          if (!id) continue;
          const k = norm(id);
          // Reference names are prefixed with the vendor ("DeepSeek: DeepSeek V4
          // Pro") and the optgroup already shows it, so drop the prefix.
          const label = String(m.name || id).replace(/^[^:]+:\s*/, '');
          if (!ref.has(k)) ref.set(k, {id, name: label, in: i, out: o});
        }

        const offerings = (net.offerings || []).filter(
          (o): o is Offering & {service: string} => Boolean(o.service) && priced(o),
        );

        // Cheapest live seller per service, matched against a reference price.
        const now = new Date();
        const best = new Map<string, Entry>();
        for (const off of offerings) {
          const i = off.inputUsdPerMillion as number;
          const o = off.outputUsdPerMillion as number;
          const key = norm(off.service);
          const r = ref.get(key);
          if (!r) continue;
          const c = REF_IN * i + REF_OUT * o;
          const cur = best.get(off.service);
          if (!cur || c < cur.c) {
            // Only the reference side is overridden. Seller selection above is
            // untouched, so which seller wins never depends on this.
            const ds = deepseekRate(key, now);
            best.set(off.service, {
              c,
              service: off.service,
              name: r.name,
              vendor: vendorOf(r.id),
              ref: ds ? ds.rate : [r.in, r.out],
              note: ds ? ds.note : undefined,
              ants: [i, o],
              seller: off.sellerName || 'unknown seller',
              sellers: cur ? cur.sellers : 0,
            });
          }
        }
        // Count how many sellers carry each matched service. Uses the same
        // "real price" test as the selection above, so the count can never
        // include a listing that was not eligible to win.
        for (const off of offerings) {
          const e = best.get(off.service);
          if (e) e.sellers += 1;
        }

        const list = [...best.values()].sort(
          (a, b) => a.vendor.localeCompare(b.vendor) || a.name.localeCompare(b.name),
        );
        if (!list.length) throw new Error('no overlap');

        setCatalog(list);
        setUpdatedAt(net.updatedAt ?? null);
        const preferred =
          list.find((x) => x.service === 'deepseek-v4-pro') ||
          list.find((x) => x.service === 'claude-opus-4-6') ||
          list[0];
        setModel(preferred.service);
        setStatus('ready');
      } catch {
        if (alive) setStatus('error');
      }
    };
    load();
    return () => {
      alive = false;
    };
  }, []);

  const current = useMemo(
    () => catalog.find((m) => m.service === model),
    [catalog, model],
  );

  const calc = useMemo(() => {
    if (!current) return null;
    const i = Math.max(0, parseFloat(tin) || 0);
    const o = Math.max(0, parseFloat(tout) || 0);
    const a = i * current.ref[0] + o * current.ref[1];
    const b = (i * current.ants[0] + o * current.ants[1]) * (1 + FEE);
    return {a, b, saved: a - b, pct: a > 0 ? ((a - b) / a) * 100 : 0};
  }, [current, tin, tout]);

  const grouped = useMemo(() => {
    const g: {vendor: string; items: Entry[]}[] = [];
    for (const m of catalog) {
      const last = g[g.length - 1];
      if (last && last.vendor === m.vendor) last.items.push(m);
      else g.push({vendor: m.vendor, items: [m]});
    }
    return g;
  }, [catalog]);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebApplication',
        name: TITLE,
        url: canonical,
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Any',
        description: DESC,
        offers: {'@type': 'Offer', price: '0', priceCurrency: 'USD'},
        publisher: {'@type': 'Organization', name: 'AntSeed', url: base},
      },
      {
        '@type': 'FAQPage',
        mainEntity: FAQ.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: {'@type': 'Answer', text: f.a},
        })),
      },
    ],
  };

  return (
    <Layout title={TITLE} description={DESC}>
      <Head>
        <meta property="og:title" content={`${TITLE}: standard price vs the open market`} />
        <meta property="og:description" content={DESC} />
        <meta property="og:url" content={canonical} />
        <meta property="og:image" content={`${base}/img/og-cost-calculator.png`} />
        <meta name="twitter:title" content={`${TITLE}: standard price vs the open market`} />
        <meta name="twitter:description" content={DESC} />
        <meta name="twitter:image" content={`${base}/img/og-cost-calculator.png`} />
        <script type="application/ld+json">{JSON.stringify(jsonLd)}</script>
      </Head>

      <main className={styles.page}>
        <div className={styles.wrap}>
          <h1 className={styles.h1}>LLM API cost calculator</h1>
          <p className={styles.lede}>
            Put in the tokens you burn in a month and see the same workload priced two ways:
            what it normally costs, and what the cheapest seller currently serving that model on
            the AntSeed network is asking. Both sides are read live.
          </p>

          <div className={styles.card}>
            <div className={`${styles.field} ${styles.wide}`}>
              <label htmlFor="asc-model">Model</label>
              <select
                id="asc-model"
                value={model}
                disabled={status !== 'ready'}
                onChange={(e) => setModel(e.target.value)}>
                {status !== 'ready' ? (
                  <option>{status === 'loading' ? 'Loading live prices…' : 'Unavailable'}</option>
                ) : (
                  grouped.map((g) => (
                    <optgroup key={g.vendor} label={g.vendor}>
                      {g.items.map((m) => (
                        <option key={m.service} value={m.service}>
                          {m.name}
                        </option>
                      ))}
                    </optgroup>
                  ))
                )}
              </select>
            </div>

            <div className={styles.field}>
              <label htmlFor="asc-in">
                Input tokens / month
                <span className={styles.tip} tabIndex={0} role="note">
                  ?
                  <em>
                    Everything you send the model: prompts, chat history, files and system
                    instructions. Find the monthly total in your provider&rsquo;s usage
                    dashboard, or run <code>ccusage</code> for Claude Code.
                  </em>
                </span>
              </label>
              <input
                id="asc-in"
                type="number"
                min="0"
                step="1"
                inputMode="decimal"
                value={tin}
                onChange={(e) => setTin(e.target.value)}
              />
            </div>

            <div className={styles.field}>
              <label htmlFor="asc-out">
                Output tokens / month
                <span className={styles.tip} tabIndex={0} role="note">
                  ?
                  <em>
                    Everything the model writes back, including reasoning tokens. It sits next
                    to input in the same usage dashboard, and it is usually the smaller number.
                  </em>
                </span>
              </label>
              <input
                id="asc-out"
                type="number"
                min="0"
                step="0.5"
                inputMode="decimal"
                value={tout}
                onChange={(e) => setTout(e.target.value)}
              />
            </div>
          </div>

          {status === 'error' && (
            <p className={`${styles.live} ${styles.err}`} role="status">
              <i /> Could not reach the price feeds. Refresh in a moment, or check{' '}
              <a href="https://antscan.co/view/services">antscan.co</a> directly.
            </p>
          )}

          <div className={styles.rows} aria-live="polite">
            <div className={styles.row}>
              <div className={styles.rowTop}>
                {/* "The standard price", never "official"/"list": the reference
                    feed is a marketplace with its own margin. */}
                <span className={styles.who}>The standard price</span>
                <span className={styles.amt}>{calc ? money(calc.a) : '—'}</span>
              </div>
              <div className={styles.track}>
                <div className={styles.fill} style={{width: '100%'}} />
              </div>
              {current && (
                <p className={styles.rate}>
                  {perM(current.ref[0])} in · {perM(current.ref[1])} out, per 1M
                  {current.note ? ` · ${current.note}` : ''}
                </p>
              )}
            </div>

            <div className={`${styles.row} ${styles.win}`}>
              <div className={styles.rowTop}>
                <span className={styles.who}>On AntSeed</span>
                <span className={styles.amt}>{calc ? money(calc.b) : '—'}</span>
              </div>
              <div className={styles.track}>
                <div
                  className={styles.fill}
                  style={{
                    width:
                      calc && calc.a > 0
                        ? Math.min(100, Math.max(1, (calc.b / calc.a) * 100)) + '%'
                        : '0%',
                  }}
                />
              </div>
              {current && (
                <p className={styles.rate}>
                  {perM(current.ants[0])} in · {perM(current.ants[1])} out, per 1M · fee included
                </p>
              )}
            </div>
          </div>

          {calc && current && calc.a > 0 && (
            <>
              <p className={styles.out}>
                {calc.saved > 0 ? (
                  <>
                    You&rsquo;d keep <b>{money(calc.saved)}</b> a month. That&rsquo;s{' '}
                    {calc.pct >= 99.5 ? calc.pct.toFixed(1) : calc.pct.toFixed(0)}%.
                  </>
                ) : (
                  <>
                    No saving here — the cheapest seller wants <b>{money(-calc.saved)}</b> more
                    a month.
                  </>
                )}
              </p>
              <p className={styles.sub}>
                {calc.saved > 0 ? `${money(calc.saved * 12)} a year · ` : 'Buy this one direct · '}
                cheapest seller: {current.seller}
                {current.sellers > 1 ? ` · ${current.sellers} sellers serving it` : ''}
              </p>
            </>
          )}

          {status === 'ready' && (
            <p className={styles.live}>
              <i /> Live · {catalog.length} models ·{' '}
              {updatedAt
                ? 'network updated ' +
                  new Date(updatedAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                : 'just now'}
            </p>
          )}

          <p className={styles.fine}>
            Token counts in millions. AntSeed rates are read live from the{' '}
            <a href="https://antscan.co/view/services" rel="noopener">
              network
            </a>{' '}
            and show the cheapest seller currently offering that model, plus the 4% protocol fee.
            The standard price is the published market rate for the same model. Listings priced at
            $0 and models with no published rate are left out. Both sides change through the day.
            DeepSeek V4 Pro and V4 Flash bill by time of day from 16:00 UTC on 16 August 2026:
            peak hours are 01:00&ndash;04:00 and 06:00&ndash;10:00 UTC and cost double off&#8209;peak,
            so those two are priced at whichever rate is in force as you load the page.
          </p>

          <h2 className={styles.h2}>Questions about token costs</h2>
          {FAQ.map((f) => (
            <div key={f.q}>
              <h3 className={styles.h3}>{f.q}</h3>
              <p className={styles.answer}>{f.a}</p>
            </div>
          ))}

          <div className={styles.cta}>
            <h2 className={styles.ctaH}>Buy inference on the open market</h2>
            <p>
              AntSeed is a peer-to-peer marketplace for AI inference. No accounts, no gatekeepers,
              an OpenAI and Anthropic compatible API, and payment that settles on-chain in USDC.
            </p>
            <a className={styles.btn} href="/docs">
              Read the docs
            </a>
          </div>
        </div>
      </main>
    </Layout>
  );
}
