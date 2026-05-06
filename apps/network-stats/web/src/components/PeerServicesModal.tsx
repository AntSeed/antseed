import type { Peer } from '../api';
import { shortPeerId } from '../utils';
import { Modal } from './Modal';

export function PeerServicesModal({
  peer,
  services,
  onClose,
}: {
  peer: Peer;
  services: string[];
  onClose: () => void;
}) {
  const id = shortPeerId(peer.peerId);
  const title = peer.displayName || `${id.head}${id.tail ? `...${id.tail}` : ''}`;

  return (
    <Modal
      titleId="peer-services-title"
      eyebrow="Services"
      title={title}
      sub={
        <>
          <span>{services.length} {services.length === 1 ? 'service' : 'services'}</span>
          <span className="tm-head-sep" aria-hidden>·</span>
          <span className="mono">{id.head}{id.tail ? `...${id.tail}` : ''}</span>
        </>
      }
      onClose={onClose}
      closeLabel="Close services"
      frameClassName="peer-services-modal"
    >
      <div className="peer-services-modal-body">
        {services.map((service) => (
          <span key={service} className="svc-tag">{service}</span>
        ))}
      </div>
    </Modal>
  );
}
