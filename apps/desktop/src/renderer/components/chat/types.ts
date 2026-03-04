export type ChatRenderableMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: unknown;
  metaParts: string[];
};
