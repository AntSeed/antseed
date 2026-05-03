import type { SVGProps } from 'react';

/**
 * Brand-mark glyphs for known model families. Rendered as a small inline SVG
 * next to a model name on the Discover card. Each logo uses `currentColor` so
 * it inherits the surrounding text color (and works in light + dark themes).
 *
 * Marks are intentionally simplified, monochromatic, and consistent in weight
 * so the grid of cards reads as a single icon family rather than a collage of
 * full-color brand stickers.
 */

type LogoComponent = (props: SVGProps<SVGSVGElement>) => JSX.Element;

const SVG_BASE: SVGProps<SVGSVGElement> = {
  viewBox: '0 0 24 24',
  xmlns: 'http://www.w3.org/2000/svg',
  'aria-hidden': true,
  focusable: false,
};

const OpenAILogo: LogoComponent = (props) => (
  <svg {...SVG_BASE} fill="currentColor" {...props}>
    <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.4069-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
  </svg>
);

const AnthropicLogo: LogoComponent = (props) => (
  <svg {...SVG_BASE} fill="none" {...props}>
    <g stroke="currentColor" strokeWidth="3.1" strokeLinecap="round">
      <line x1="12" y1="3.6" x2="12" y2="20.4" />
      <line x1="4.4" y1="7.7" x2="19.6" y2="16.3" />
      <line x1="4.4" y1="16.3" x2="19.6" y2="7.7" />
    </g>
  </svg>
);

const MetaLogo: LogoComponent = (props) => (
  <svg {...SVG_BASE} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" {...props}>
    <path d="M3.5 12c0-2.6 1.6-4.4 3.7-4.4 2.4 0 4.1 2.2 5.6 4.4s3.2 4.4 5.6 4.4c2 0 3.6-1.8 3.6-4.4s-1.6-4.4-3.6-4.4c-2.4 0-4.1 2.2-5.6 4.4s-3.2 4.4-5.6 4.4c-2.1 0-3.7-1.8-3.7-4.4Z" />
  </svg>
);

const DeepSeekLogo: LogoComponent = (props) => (
  <svg {...SVG_BASE} fill="currentColor" {...props}>
    <path d="M3.4 13.2c2.2.4 3.7-.5 5.6-.4 1.6.1 2.7 1 4.3 1.1 2.4.2 5-.7 7.3-3.2-.6 3.6-2.8 7-7 7.6-3 .4-7.2-.6-10.2-3.6a8 8 0 0 1-.9-1.7c.3.1.6.2.9.2Z" />
    <circle cx="15.4" cy="12.8" r="0.7" fill="var(--bg-card)" />
    <path d="M19.4 8.5c.6.5 1.2 1.4 1.5 2.3-.5-.1-1-.2-1.6 0a1 1 0 0 1-1.1-1c0-.7.6-1.4 1.2-1.3Z" />
  </svg>
);

const MistralLogo: LogoComponent = (props) => (
  <svg {...SVG_BASE} fill="currentColor" {...props}>
    <rect x="3" y="4" width="5" height="5" />
    <rect x="3" y="9.5" width="5" height="5" />
    <rect x="3" y="15" width="5" height="5" />
    <rect x="9.5" y="4" width="5" height="5" />
    <rect x="9.5" y="15" width="5" height="5" />
    <rect x="16" y="4" width="5" height="5" />
    <rect x="16" y="15" width="5" height="5" />
  </svg>
);

const MoonshotLogo: LogoComponent = (props) => (
  <svg {...SVG_BASE} fill="currentColor" {...props}>
    <path d="M14.6 3a9 9 0 1 0 6.4 15.4 7 7 0 0 1-6.4-15.4Z" />
  </svg>
);

const QwenLogo: LogoComponent = (props) => (
  <svg {...SVG_BASE} fill="currentColor" fillRule="evenodd" clipRule="evenodd" {...props}>
    <path d="M12 3a9 9 0 1 1-6.5 15.25l-1.85 1.85-2.12-2.12 1.85-1.85A9 9 0 0 1 12 3Zm0 3a6 6 0 1 0 4.4 10.07l-2-2 2.12-2.12 2 2A6 6 0 0 0 12 6Z" />
  </svg>
);

const GoogleLogo: LogoComponent = (props) => (
  <svg {...SVG_BASE} fill="currentColor" {...props}>
    <path d="M12 1.5 13.5 9c.3 1.4 1.4 2.5 2.8 2.8L23 13.5l-6.7 1.7c-1.4.3-2.5 1.4-2.8 2.8L12 24.5l-1.5-6.5c-.3-1.4-1.4-2.5-2.8-2.8L1 13.5l6.7-1.7c1.4-.3 2.5-1.4 2.8-2.8L12 1.5Z" />
  </svg>
);

const MinimaxLogo: LogoComponent = (props) => (
  <svg {...SVG_BASE} fill="currentColor" {...props}>
    <path d="M3 19V5h3.4l4 7.2L14.4 5h3.5v14h-2.8v-9l-3.5 6.2h-1.4L6.7 10v9H3Z" />
    <rect x="19" y="5" width="2.6" height="14" rx="0.4" />
  </svg>
);

const GLMLogo: LogoComponent = (props) => (
  <svg {...SVG_BASE} fill="currentColor" {...props}>
    <path d="M5 5h14v3l-9.4 8H19v3H5v-3l9.4-8H5V5Z" />
  </svg>
);

const FluxLogo: LogoComponent = (props) => (
  <svg {...SVG_BASE} fill="currentColor" {...props}>
    <path d="M12 3 7.5 9.6h2.3L5.7 15.4h2.6L4 21h16l-4.3-5.6h2.6L14 9.6h2.3L12 3Z" />
    <rect x="11" y="20" width="2" height="2.6" />
  </svg>
);

const StabilityLogo: LogoComponent = (props) => (
  <svg {...SVG_BASE} fill="currentColor" fillRule="evenodd" clipRule="evenodd" {...props}>
    <path d="M3.4 5.5h17.2L12 21 3.4 5.5Zm3.7 1.8 4.9 8.9 4.9-8.9H7.1Z" />
  </svg>
);

const NvidiaLogo: LogoComponent = (props) => (
  <svg {...SVG_BASE} fill="currentColor" fillRule="evenodd" clipRule="evenodd" {...props}>
    <path d="M2 12c2.4-4 7.2-6.6 12-5.6s8 4 8 7.2-3.6 5.8-8.4 5.6S4 16.2 2 12Zm4.6-.2c0-1.7 2.4-3 5.4-3s5.4 1.4 5.4 3.2-2.4 3-5.4 3-5.4-1.5-5.4-3.2Z" />
  </svg>
);

const VeniceLogo: LogoComponent = (props) => (
  <svg {...SVG_BASE} fill="currentColor" {...props}>
    <path d="M2.6 4h4.2l5.2 12.4L17.2 4h4.2l-7.6 17h-3.6L2.6 4Z" />
  </svg>
);

const GrokLogo: LogoComponent = (props) => (
  <svg {...SVG_BASE} fill="currentColor" {...props}>
    <path d="M3 3h4.4l4.6 6.6L16.6 3H21l-6.7 9.3L21 21h-4.4l-4.6-6.7L7.4 21H3l6.7-8.7L3 3Z" />
  </svg>
);

/**
 * Pattern → logo lookup. Order matters: more specific tokens must come first
 * so `qwen3` doesn't accidentally match a generic `q` rule, etc.
 */
type Matcher = { test: RegExp; logo: LogoComponent };

const MATCHERS: Matcher[] = [
  { test: /\b(claude|anthropic)/i, logo: AnthropicLogo },
  { test: /\b(gpt|openai|chatgpt|o[1-9])/i, logo: OpenAILogo },
  { test: /\b(llama|meta)/i, logo: MetaLogo },
  { test: /\bdeepseek/i, logo: DeepSeekLogo },
  { test: /\b(mistral|mixtral|codestral|magistral|devstral)/i, logo: MistralLogo },
  { test: /\b(kimi|moonshot)/i, logo: MoonshotLogo },
  { test: /\b(qwen|qwq|alibaba|tongyi)/i, logo: QwenLogo },
  { test: /\b(gemini|gemma|palm|bard)/i, logo: GoogleLogo },
  { test: /\bminimax/i, logo: MinimaxLogo },
  { test: /\b(glm|chatglm|zhipu)/i, logo: GLMLogo },
  { test: /\b(flux|black\s*forest|bfl)/i, logo: FluxLogo },
  { test: /\b(sdxl|stability|stable[-\s]?diffusion|sd[123])/i, logo: StabilityLogo },
  { test: /\b(nvidia|nemotron)/i, logo: NvidiaLogo },
  { test: /\bvenice/i, logo: VeniceLogo },
  { test: /\b(grok|xai)/i, logo: GrokLogo },
];

export function getModelLogo(modelName: string): LogoComponent | null {
  if (!modelName) return null;
  for (const { test, logo } of MATCHERS) {
    if (test.test(modelName)) return logo;
  }
  return null;
}
