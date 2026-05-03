import type { HugeiconsIcon } from '@hugeicons/react';
import {
  Robot01Icon,
  IncognitoIcon,
  Mic01Icon,
  BubbleChatIcon,
  CodeIcon,
  CodeFolderIcon,
  BrushIcon,
  RocketIcon,
  GiftIcon,
  CalculatorIcon,
  ImageUploadIcon,
  CrownIcon,
  SecurityLockIcon,
  DatabaseIcon,
  BrainIcon,
  Books01Icon,
  Task01Icon,
  MicrochipIcon,
  SquareUnlock01Icon,
  Video01Icon,
  EyeIcon,
  Globe02Icon,
  Edit01Icon,
  NewTwitterIcon,
  Tag01Icon,
} from '@hugeicons/core-free-icons';

type IconData = Parameters<typeof HugeiconsIcon>[0]['icon'];

/**
 * Icon associated with each known category tag. Unknown tags fall back to a
 * generic tag glyph so chip layouts remain consistent.
 *
 * Kept separate from `discover-filter-util` so that file stays React-free and
 * importable from non-DOM test contexts.
 */
const CATEGORY_ICONS: Record<string, IconData> = {
  agents: Robot01Icon,
  anon: IncognitoIcon,
  audio: Mic01Icon,
  chat: BubbleChatIcon,
  code: CodeIcon,
  coding: CodeFolderIcon,
  creative: BrushIcon,
  fast: RocketIcon,
  free: GiftIcon,
  math: CalculatorIcon,
  multimodal: ImageUploadIcon,
  premium: CrownIcon,
  privacy: SecurityLockIcon,
  rag: DatabaseIcon,
  reasoning: BrainIcon,
  study: Books01Icon,
  tasks: Task01Icon,
  tee: MicrochipIcon,
  uncensored: SquareUnlock01Icon,
  video: Video01Icon,
  vision: EyeIcon,
  'web-search': Globe02Icon,
  writing: Edit01Icon,
  'x-search': NewTwitterIcon,
};

export function getCategoryIcon(category: string): IconData {
  const key = category.trim().toLowerCase();
  return CATEGORY_ICONS[key] ?? Tag01Icon;
}
