import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { SellerMiddlewareConfig } from '../config/types.js';
import type { ProviderMiddleware } from '@antseed/provider-core';

export async function loadMiddlewareFiles(
  configs: SellerMiddlewareConfig[],
  baseDir: string,
): Promise<ProviderMiddleware[]> {
  return Promise.all(
    configs.map(async (entry) => {
      if (entry.services !== undefined && entry.services.length === 0) {
        throw new Error(`Middleware entry "${entry.file}" has an empty services list — remove the field to apply globally or list at least one service ID.`);
      }
      const filePath = isAbsolute(entry.file) ? entry.file : resolve(baseDir, entry.file);
      const content = await readFile(filePath, 'utf-8');
      return { content, position: entry.position, role: entry.role, services: entry.services } as ProviderMiddleware;
    }),
  );
}

export async function loadMiddlewareDirectory(
  directory: string,
  defaults: Omit<SellerMiddlewareConfig, 'file'>,
): Promise<ProviderMiddleware[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const configs = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => ({
      file: resolve(directory, entry.name),
      position: defaults.position,
      ...(defaults.role !== undefined ? { role: defaults.role } : {}),
      ...(defaults.services !== undefined ? { services: defaults.services } : {}),
    }))
    .sort((a, b) => a.file.localeCompare(b.file));

  return loadMiddlewareFiles(configs, directory);
}
