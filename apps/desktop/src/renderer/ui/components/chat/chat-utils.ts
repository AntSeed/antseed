type ChatMessage = {
  role: string;
  content: unknown;
  createdAt?: number;
  meta?: Record<string, unknown>;
};

type ContentBlock = {
  type: string;
};

export function isToolResultOnlyMessage(msg: ChatMessage): boolean {
  return (
    msg.role === 'user' &&
    Array.isArray(msg.content) &&
    msg.content.length > 0 &&
    (msg.content as ContentBlock[]).every((b) => b.type === 'tool_result')
  );
}
