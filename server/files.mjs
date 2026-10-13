// Attachments the server stored before they moved into the browser (<dataDir>/files), read for migration.
import fsp from 'node:fs/promises';
import path from 'node:path';

const ID_RE = /^[0-9a-f-]{36}$/;
const dirOf = (dataDir) => path.join(dataDir, 'files');

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
