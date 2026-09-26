import styles from '../pages/index.module.css';
import {Button, Reveal, SectionHeader} from './ui';

/** "Owned by no one. Available to everyone." — the network section. */
const OWNED_CARDS = [
  {
    title: 'Open source and onchain',
    illo: <img src="/img/home/illo-best-prices.svg" alt="" aria-hidden="true" />,
  },
  {
    title: 'Private by design',
    illo: <img src="/img/home/illo-private-by-design.svg" alt="" aria-hidden="true" />,
  },
  {
    title: 'Distributed and always on',
    illo: <img src="/img/home/illo-distributed-always-on.svg" alt="" aria-hidden="true" />,
  },
];

export function OwnedByNoOne() {
  return (
    <section className={styles.section}>
      <div className={styles.sectionInner}>
        <Reveal>
          <SectionHeader
            kicker="The network behind the AI VPN"
            title={
              <>
                Owned by no one. <span className={styles.titleAccent}>Available to everyone.</span>
              </>
            }
            lead="With Antseed, there is no central server or company in the middle. It's decentralized and maintained by the Antseed Foundation."
          />
        </Reveal>
        <Reveal className={styles.buttonRow} delay={60}>
          <Button to="/docs/overview" variant="ghost" arrow>About the network</Button>
        </Reveal>
        <div className={styles.cardGrid3}>
          {OWNED_CARDS.map((card, i) => (
            <Reveal key={card.title} className={styles.featureCard} delay={i * 100}>
              <div className={styles.featureIlloWell}>{card.illo}</div>
              <div className={styles.featureDivider} />
              <div className={styles.featureCopy}>
                <h3>{card.title}</h3>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
