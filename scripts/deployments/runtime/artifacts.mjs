import { link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

function temporaryFile(file) {
  return `${file}.${process.pid}.${Date.now()}.tmp`;
}

export async function writeFileAtomic(file, contents) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = temporaryFile(file);
  try {
    await writeFile(temporary, contents, { flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export async function writeJsonAtomic(file, value) {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeJsonOnce(file, value) {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const existing = await readFile(file, 'utf8');
    if (existing === contents) return;
    throw new Error(`Refusing to overwrite append-only deployment record ${file}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await mkdir(path.dirname(file), { recursive: true });
  const temporary = temporaryFile(file);
  try {
    await writeFile(temporary, contents, { flag: 'wx' });
    try {
      await link(temporary, file);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await readFile(file, 'utf8');
      if (existing !== contents) {
        throw new Error(`Refusing to overwrite append-only deployment record ${file}`);
      }
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
