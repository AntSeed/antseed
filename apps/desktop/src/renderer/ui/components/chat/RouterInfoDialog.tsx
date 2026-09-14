import { Button, Modal } from '@antseed/ui';
import type { RouterPluginInfo } from '../../../types/bridge';
import { useCachedResource } from '../../../modules/app/cached-resource';
import { dayPassPriceResource, type DayPassPriceOffer } from '../../../modules/app/vpr-resources';
import styles from './RouterInfoDialog.module.scss';

type Props = {
  isOpen: boolean;
  /** The router plugin the user just picked from Preferences' dropdown --
   *  not necessarily the currently-active one, since nothing is active yet
   *  until `onConfirm`. `null` while no option is pending confirmation. */
  plugin: RouterPluginInfo | null;
  onClose: () => void;
  /**
   * `offer` is this dialog's own live day-pass price lookup at confirm time
   * (`null` if the routing peer isn't currently advertising one) -- passed
   * back so the caller can record it as the buyer's agreed price for that
   * seller (`VprRoutingPreferences.agreedDayPassPricesUsdc`), keyed by the
   * peer id the offer actually came from.
   */
  onConfirm: (offer: DayPassPriceOffer | null) => void;
};

/**
 * "What does Auto do, and what does it cost" dialog for whichever router
 * plugin the user just picked in Preferences. Copy comes from that plugin's
 * own `autoRouteInfo` (packages/node's AntseedRouterPlugin), falling back to
 * its `displayName`/`description` if a plugin doesn't declare dedicated
 * dialog copy. The live daily price comes from `/_antseed/day-pass-price`,
 * a hardcoded admin route on the buyer-proxy (apps/cli/src/proxy/buyer-proxy.ts)
 * reading whatever peer advertises a `type: 'day-pass'` offer -- not
 * (yet) a member of the `Router` TS interface itself.
 */
export function RouterInfoDialog({ isOpen, plugin, onClose, onConfirm }: Props) {
  const usesDayPass = !!plugin?.dailyPassServiceId;
  const { data: offer } = useCachedResource(dayPassPriceResource, isOpen && usesDayPass);
  const dailyUsd = offer?.flatUsdPrice;
  const title = plugin?.autoRouteInfo?.title ?? plugin?.displayName ?? 'Model router';
  const body = plugin?.autoRouteInfo?.body ?? plugin?.description ?? '';

  return (
    <Modal
      bodyClassName={styles.dialogBody}
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      title={title}
    >
      <p className={styles.paragraph}>{body}</p>

      {usesDayPass && <div className={styles.priceLine}>
        {typeof dailyUsd === 'number'
          ? (
            <>
              <span className={styles.priceAmount}>${dailyUsd.toFixed(2)}</span>
              <span className={styles.priceSecondary}>
                {' '}per day you use it
              </span>
            </>
          )
          : <span className={styles.priceAmount}>Billed per day used</span>}
      </div>}
      <p className={styles.paragraph}>
        {usesDayPass
          ? 'Only on the days you use it. Turn off any time from Preferences.'
          : 'Enabling this router does not authorize a day pass or token charges for routing. Configure any paid routing service separately. Model inference is billed separately.'}
      </p>

      <div className={styles.actions}>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={() => onConfirm(usesDayPass ? offer ?? null : null)}>
          {usesDayPass && !offer ? 'Enable without day-pass consent' : 'Enable'}
        </Button>
      </div>
    </Modal>
  );
}
