// Files attached to requests (form-data file parts, binary bodies) live in <dataDir>/files.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const ID_RE = /^[0-9a-f-]{36}$/;
const dirOf = (dataDir) => path.join(dataDir, 'files');

export async function storeFile(dataDir, { name, type, data }) {
  const id = randomUUID();
  await fsp.mkdir(dirOf(dataDir), { recursive: true });
  const meta = { id, name: name || 'file', type: type || 'application/octet-stream', size: data.length, createdAt: Date.now() };
  await fsp.writeFile(path.join(dirOf(dataDir), id), data);
  await fsp.writeFile(path.join(dirOf(dataDir), `${id}.json`), JSON.stringify(meta));
  return meta;
}

export async function readStoredFile(dataDir, id) {
  if (!ID_RE.test(id)) throw new Error(`Invalid file id "${id}"`);
  try {
    const [data, meta] = await Promise.all([
      fsp.readFile(path.join(dirOf(dataDir), id)),
      fsp.readFile(path.join(dirOf(dataDir), `${id}.json`), 'utf8'),
    ]);
    return { data, meta: JSON.parse(meta) };
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`Attached file ${id} no longer exists; select the file again`);
    throw err;
  }
}
