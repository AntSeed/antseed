import {useHistory} from '@docusaurus/router';

/* On phones (where VPR CTAs read "Get Started") download buttons route to
   the /get-started Telegram flow instead of downloading an installer the
   device can't run. Desktop keeps the direct download. Matches the 640px
   breakpoint that swaps the label in custom.css. */
export function useMobileGetStarted() {
  const history = useHistory();
  return (e: {preventDefault: () => void}) => {
    if (window.matchMedia('(max-width: 640px)').matches) {
      e.preventDefault();
      history.push('/get-started');
    }
  };
}
