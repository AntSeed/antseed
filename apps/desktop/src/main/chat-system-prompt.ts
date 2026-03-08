/**
 * System prompt customization for AntStation's AI chat.
 *
 * We use systemPromptOverride (rather than customPrompt) so that pi's
 * buildSystemPrompt still generates the full dynamic section — available tools,
 * guidelines based on active tools, skills, context files, date/time, cwd —
 * and we just replace the pi-specific intro and remove the pi docs reference.
 *
 * When the user has set ANTSEED_CHAT_SYSTEM_PROMPT / ANTSEED_CHAT_SYSTEM_PROMPT_FILE /
 * buyer.chatSystemPrompt, their text is passed as customPrompt instead, which
 * bypasses this override entirely.
 */

const PI_INTRO_PATTERN =
  /You are an expert coding assistant operating inside pi, a coding agent harness\. You help users by reading files, executing commands, editing code, and writing new files\./;

const PI_DOCS_PATTERN =
  /\nPi documentation \(read only when.*?(?=\nCurrent date|\nCurrent working directory|$)/s;

const ANTSTATION_INTRO =
  'You are a helpful AI assistant inside AntStation, a peer-to-peer AI network. ' +
  'You can help with any task — coding, writing, research, analysis, math, brainstorming, ' +
  'answering questions, and more. When the task involves files or a codebase you have tools ' +
  'to read, edit, run commands, and write files.';

/**
 * Transform pi's built system prompt into an AntStation-branded one.
 * Receives the fully-built prompt (with tool list, guidelines, skills, context
 * files, date/time) and returns a version with the pi-specific parts replaced.
 */
export function antStationSystemPromptOverride(built: string | undefined): string | undefined {
  if (!built) return built;

  let prompt = built;

  // Replace the pi coding assistant intro with an AntStation intro.
  prompt = prompt.replace(PI_INTRO_PATTERN, ANTSTATION_INTRO);

  // Add a note after "In addition to the tools above..." line so users know
  // the assistant handles general tasks too, not just coding.
  prompt = prompt.replace(
    'In addition to the tools above, you may have access to other custom tools depending on the project.',
    'In addition to the tools above, you may have access to other custom tools depending on the project. ' +
    'For general tasks (writing, research, math, etc.) just respond directly — only reach for tools when needed.',
  );

  // Remove the pi-specific documentation reference (irrelevant for AntStation users).
  prompt = prompt.replace(PI_DOCS_PATTERN, '');

  return prompt;
}
