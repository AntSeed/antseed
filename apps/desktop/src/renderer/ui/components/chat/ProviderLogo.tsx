import type { CSSProperties } from 'react';
import { getModelLogo } from './model-logos';

import anthropicLogo from '../../../assets/provider-logos/anthropic.png';
import cohereLogo from '../../../assets/provider-logos/cohere.png';
import deepseekLogo from '../../../assets/provider-logos/deepseek.png';
import googleLogo from '../../../assets/provider-logos/google.png';
import metaLogo from '../../../assets/provider-logos/meta.png';
import minimaxLogo from '../../../assets/provider-logos/minimax.png';
import mistralLogo from '../../../assets/provider-logos/mistral.png';
import moonshotLogo from '../../../assets/provider-logos/moonshot.png';
import nousLogo from '../../../assets/provider-logos/nousresearch.svg';
import openaiLogo from '../../../assets/provider-logos/openai.png';
import qwenLogo from '../../../assets/provider-logos/qwen.png';
import zhipuLogo from '../../../assets/provider-logos/zhipu.png';

type AssetMatcher = { test: RegExp; src: string; alt: string };

const ASSET_MATCHERS: AssetMatcher[] = [
  { test: /\b(claude|anthropic)/i, src: anthropicLogo, alt: 'Anthropic' },
  { test: /\b(gpt|openai|chatgpt|o[1-9])/i, src: openaiLogo, alt: 'OpenAI' },
  { test: /\b(llama|meta)/i, src: metaLogo, alt: 'Meta' },
  { test: /\bdeepseek/i, src: deepseekLogo, alt: 'DeepSeek' },
  { test: /\b(mistral|mixtral|codestral|magistral|devstral)/i, src: mistralLogo, alt: 'Mistral' },
  { test: /\b(kimi|moonshot)/i, src: moonshotLogo, alt: 'Moonshot' },
  { test: /\b(qwen|qwq|alibaba|tongyi)/i, src: qwenLogo, alt: 'Qwen' },
  { test: /\b(gemini|gemma|palm|bard)/i, src: googleLogo, alt: 'Google' },
  { test: /\bminimax/i, src: minimaxLogo, alt: 'MiniMax' },
  { test: /\b(glm|chatglm|zhipu)/i, src: zhipuLogo, alt: 'Zhipu' },
  { test: /\bcohere/i, src: cohereLogo, alt: 'Cohere' },
  { test: /\b(hermes|nous)/i, src: nousLogo, alt: 'Nous Research' },
];

function matchAsset(modelName: string): AssetMatcher | null {
  if (!modelName) return null;
  for (const m of ASSET_MATCHERS) {
    if (m.test.test(modelName)) return m;
  }
  return null;
}

type Props = {
  modelName: string;
  className?: string;
  style?: CSSProperties;
};

export function ProviderLogo({ modelName, className, style }: Props) {
  const asset = matchAsset(modelName);
  if (asset) {
    return (
      <img
        src={asset.src}
        alt={asset.alt}
        className={className}
        style={{ objectFit: 'contain', ...style }}
        draggable={false}
      />
    );
  }
  const Glyph = getModelLogo(modelName);
  if (!Glyph) return null;
  return <Glyph className={className} style={style} />;
}
