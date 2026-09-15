import styles from '../pages/index.module.css';
import {useLatestDesktopDownload} from '../lib/useLatestDesktopDownload';
import {AllVersionsLink} from '../lib/AllVersionsLink';
import {useMobileGetStarted} from '../lib/useMobileGetStarted';
import type {ReactNode} from 'react';
import {Button, Reveal, ArrowRight} from './ui';

/** The ink closing band from the homepage, shared with /network. */
export function FinalCtaBand({
  title = 'Run your agents on your terms',
  sub = 'Every model, no middleman. Anonymous and always on.',
  caption = 'No account needed. Just start.',
  secondary,
  versionsLink = true,
}: {
  title?: string;
  sub?: string;
  caption?: string;
  /** optional second button beside the download pill */
  secondary?: ReactNode;
  versionsLink?: boolean;
}) {
  return (
    <section className={styles.finalCta}>
      <Reveal className={styles.finalCtaInner}>
        <h2 className={styles.finalTitle}>{title}</h2>
        <p className={styles.finalSub}>{sub}</p>
        <div className={styles.ctaBlock}>
          {secondary ? (
            <div className={styles.finalBtnRow}>
              <FinalCtaButton />
              {secondary}
            </div>
          ) : (
            <FinalCtaButton />
          )}
          {versionsLink && <AllVersionsLink light />}
          <span className={styles.ctaCaptionLight}>{caption}</span>
        </div>
      </Reveal>
    </section>
  );
}

function FinalCtaButton() {
  const download = useLatestDesktopDownload();
  const onGetStarted = useMobileGetStarted();
  return (
    <Button href={download.href} variant="white" size="lg" osIcons className="vprBtn" onClick={onGetStarted}>
      <span className="vprLabelDesktop">Download AI VPN</span>
      <span className="vprLabelMobile">Get Started<ArrowRight /></span>
    </Button>
  );
}
