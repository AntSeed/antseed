// Imperative bridge for streaming text DOM updates.
// Lets the RAF animation loop write directly to the DOM, bypassing React
// renders for high-frequency character-level text updates.

type TextUpdater = (html: string) => void;

let currentUpdater: TextUpdater | null = null;

export function registerStreamingTextUpdater(fn: TextUpdater): () => void {
  currentUpdater = fn;
  return () => {
    if (currentUpdater === fn) currentUpdater = null;
  };
}

export function applyStreamingText(html: string): void {
  currentUpdater?.(html);
}
