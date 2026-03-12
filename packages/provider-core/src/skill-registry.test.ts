import { describe, it, expect } from 'vitest';
import { SkillRegistry } from './skill-registry.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('SkillRegistry', () => {
  it('registers and retrieves a skill', () => {
    const registry = new SkillRegistry();
    registry.register({
      name: 'test-skill',
      description: 'A test skill',
      content: '# Test\nDo the thing.',
    });

    expect(registry.has('test-skill')).toBe(true);
    expect(registry.get('test-skill')?.description).toBe('A test skill');
    expect(registry.get('test-skill')?.content).toBe('# Test\nDo the thing.');
  });

  it('returns undefined for unknown skills', () => {
    const registry = new SkillRegistry();
    expect(registry.has('nope')).toBe(false);
    expect(registry.get('nope')).toBeUndefined();
  });

  it('lists all registered skills', () => {
    const registry = new SkillRegistry();
    registry.register({ name: 'a', description: 'Skill A', content: '' });
    registry.register({ name: 'b', description: 'Skill B', content: '' });
    const all = registry.all();
    expect(all).toHaveLength(2);
    expect(all.map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('generates a catalog string', () => {
    const registry = new SkillRegistry();
    registry.register({ name: 'web-search', description: 'Search the web', content: '' });
    registry.register({ name: 'code-review', description: 'Review code', content: '' });
    const catalog = registry.catalog();
    expect(catalog).toContain('web-search: Search the web');
    expect(catalog).toContain('code-review: Review code');
    expect(catalog).toContain('antseed_load');
  });

  it('returns empty catalog when no skills registered', () => {
    const registry = new SkillRegistry();
    expect(registry.catalog()).toBe('');
  });

  it('loads skill directories with SKILL.md files', async () => {
    const dir = join(tmpdir(), `skill-test-${Date.now()}`);
    await mkdir(join(dir, 'my-skill'), { recursive: true });
    await mkdir(join(dir, 'another'), { recursive: true });
    try {
      await writeFile(
        join(dir, 'my-skill', 'SKILL.md'),
        '---\nname: my-skill\ndescription: Does cool things\n---\n# My Skill\nInstructions here.',
      );
      await writeFile(
        join(dir, 'another', 'SKILL.md'),
        '---\nname: another\ndescription: Another skill\n---\n# Another\nMore instructions.',
      );
      // Plain file at root should be ignored (not a directory)
      await writeFile(join(dir, 'readme.txt'), 'not a skill');

      const registry = new SkillRegistry();
      await registry.loadDirectory(dir);

      expect(registry.has('my-skill')).toBe(true);
      expect(registry.has('another')).toBe(true);
      expect(registry.all()).toHaveLength(2);
      expect(registry.get('my-skill')?.description).toBe('Does cool things');
      expect(registry.get('my-skill')?.content).toContain('# My Skill');
      // Frontmatter should be stripped from content
      expect(registry.get('my-skill')?.content).not.toContain('---');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('uses directory name as fallback when frontmatter has no name', async () => {
    const dir = join(tmpdir(), `skill-test-${Date.now()}`);
    await mkdir(join(dir, 'fallback-name'), { recursive: true });
    try {
      await writeFile(
        join(dir, 'fallback-name', 'SKILL.md'),
        '# No frontmatter\nJust content.',
      );

      const registry = new SkillRegistry();
      await registry.loadDirectory(dir);

      expect(registry.has('fallback-name')).toBe(true);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('skips directories without SKILL.md', async () => {
    const dir = join(tmpdir(), `skill-test-${Date.now()}`);
    await mkdir(join(dir, 'has-skill'), { recursive: true });
    await mkdir(join(dir, 'no-skill'), { recursive: true });
    try {
      await writeFile(
        join(dir, 'has-skill', 'SKILL.md'),
        '---\nname: has-skill\ndescription: Works\n---\nContent.',
      );
      // no-skill directory has no SKILL.md
      await writeFile(join(dir, 'no-skill', 'README.md'), 'Not a skill file');

      const registry = new SkillRegistry();
      await registry.loadDirectory(dir);

      expect(registry.has('has-skill')).toBe(true);
      expect(registry.has('no-skill')).toBe(false);
      expect(registry.all()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('silently skips non-existent directories', async () => {
    const registry = new SkillRegistry();
    await registry.loadDirectory('/tmp/does-not-exist-12345');
    expect(registry.all()).toHaveLength(0);
  });
});
