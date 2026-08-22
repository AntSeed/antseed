import {useHistory} from '@docusaurus/router';

/* The viewport where VPR CTAs read "Get Started" and reroute — must stay in
   sync with the 640px breakpoint that swaps the label in custom.css. Also
   used by click tracking (Root.tsx) to classify taps on download links. */
export const MOBILE_GET_STARTED_QUERY = '(max-width: 640px)';

/* On phones (where VPR CTAs read "Get Started") download buttons route to
   the /get-started Telegram flow instead of downloading an installer the
   device can't run. Desktop keeps the direct download. */
export function useMobileGetStarted() {
  const history = useHistory();
  return (e: {preventDefault: () => void}) => {
    if (window.matchMedia(MOBILE_GET_STARTED_QUERY).matches) {
      e.preventDefault();
      history.push('/get-started');
    }
  };
}
