import { readFile } from 'node:fs/promises';
import { validateRoutingRequest } from '../../../../packages/protocol/dist/index.js';
import { parseRoutingResponse } from '../../../../packages/router-core/dist/index.js';

try {
  const paths = process.argv.slice(2);
  if (paths.length !== 0 && paths.length !== 3) throw new Error('Provide metadata.json request.json response.json, or no arguments for the example');
  const files = paths.length ? paths : ['metadata', 'request', 'response'].map((name) => new URL(`./fixtures/${name}.json`, import.meta.url));
  const [metadata, request, response] = await Promise.all(files.map(async (path) => JSON.parse(await readFile(path, 'utf8'))));
  validateRoutingRequest(request, metadata);
  const recommendations = parseRoutingResponse({ requestId: 'compatibility', statusCode: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(response)) }, request.candidates);
  console.log(JSON.stringify({ compatible: true, recommendations }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
