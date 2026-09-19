import { readFile } from 'node:fs/promises';
import { parseClassificationResponse } from '../dist/index.js';

try {
  const [candidatePath, responsePath, ...extra] = process.argv.slice(2);
  if (!candidatePath || !responsePath || extra.length) throw new Error('Usage: check-compatibility.mjs candidates.json response.json');
  const candidates = JSON.parse(await readFile(candidatePath, 'utf8'));
  if (!Array.isArray(candidates) || candidates.length === 0 || candidates.some((candidate) =>
    !candidate || typeof candidate.serviceId !== 'string' || !candidate.serviceId.trim()
    || typeof candidate.peerId !== 'string' || !/^[0-9a-f]{40}$/i.test(candidate.peerId))) {
    throw new Error('Provide the nonempty candidate array sent to the service');
  }
  const response = { requestId: 'compatibility-check', statusCode: 200, headers: {}, body: await readFile(responsePath) };
  console.log(JSON.stringify({ compatible: true, routes: parseClassificationResponse(response, candidates) }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
