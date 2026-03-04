import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const INCLUDE_PATTERN = /<!--\s*@include\s+([^\s]+)\s*-->/g;

function resolveHtmlIncludes(source: string, currentFile: string, stack: Set<string>): string {
  const currentDir = path.dirname(currentFile);

  return source.replace(INCLUDE_PATTERN, (_match, includeRef: string) => {
    const includePath = path.resolve(currentDir, includeRef.trim());

    if (stack.has(includePath)) {
      const chain = [...stack, includePath].join(' -> ');
      throw new Error(`Recursive HTML partial include detected: ${chain}`);
    }

    if (!fs.existsSync(includePath)) {
      throw new Error(`Missing HTML partial include: ${includePath}`);
    }

    const includeContent = fs.readFileSync(includePath, 'utf8');
    const nextStack = new Set(stack);
    nextStack.add(includePath);
    return resolveHtmlIncludes(includeContent, includePath, nextStack);
  });
}

function createHtmlPartialsPlugin(rendererRoot: string): Plugin {
  const partialsRoot = path.resolve(rendererRoot, 'partials');
  const indexFile = path.resolve(rendererRoot, 'index.html');

  function isPartialFile(filePath: string): boolean {
    const relative = path.relative(partialsRoot, filePath);
    return !relative.startsWith('..') && !path.isAbsolute(relative) && filePath.endsWith('.html');
  }

  return {
    name: 'antseed-html-partials',
    enforce: 'pre',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const sourceFile = ctx?.filename ? path.resolve(ctx.filename) : indexFile;
        return resolveHtmlIncludes(html, sourceFile, new Set([sourceFile]));
      },
    },
    configureServer(server) {
      server.watcher.add(partialsRoot);

      const triggerFullReload = (filePath: string) => {
        if (!isPartialFile(path.resolve(filePath))) {
          return;
        }
        server.ws.send({ type: 'full-reload' });
      };

      server.watcher.on('add', triggerFullReload);
      server.watcher.on('change', triggerFullReload);
      server.watcher.on('unlink', triggerFullReload);
    },
  };
}

const rendererRoot = path.resolve(__dirname, 'src/renderer');

export default defineConfig({
  plugins: [createHtmlPartialsPlugin(rendererRoot)],
  base: './',
  root: rendererRoot,
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
  },
});
