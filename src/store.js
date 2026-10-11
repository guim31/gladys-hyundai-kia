// -----------------------------------------------------------------------------
// Small JSON persistence under /data, the container's only writable volume.
//
// What survives a restart:
//   - the token set of the account (signing in again at every start would
//     register a new "phone" on the account each time, and the login pages are
//     protected against repeated sign-ins);
//   - per car, the climate setpoint chosen in Gladys (the cloud has no
//     "set temperature" command: it is sent with the next climate start).
// The file holds tokens: it is written with mode 0600, atomically (temporary
// file + rename), and its content is never logged.
// -----------------------------------------------------------------------------

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_DATA_DIR = process.env.DATA_DIR || '/data';
const FILE_NAME = 'hyundai-kia.json';

export function createStore({ dir = DEFAULT_DATA_DIR, debounceMs = 2000, logger } = {}) {
  const file = join(dir, FILE_NAME);
  let data = { version: 1, tokens: null, vehicles: {} };
  let timer = null;
  let writing = Promise.resolve();

  async function load() {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      if (parsed && parsed.version === 1) {
        data = { version: 1, tokens: null, vehicles: {}, ...parsed };
      }
    } catch (err) {
      if (err.code !== 'ENOENT')
        logger?.warn(`Ignoring unreadable ${file}: ${err.code ?? 'invalid JSON'}`);
    }
    return data;
  }

  async function flush() {
    clearTimeout(timer);
    timer = null;
    const content = JSON.stringify(data);
    writing = writing.then(async () => {
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(`${file}.tmp`, content, { mode: 0o600 });
        await chmod(`${file}.tmp`, 0o600);
        await rename(`${file}.tmp`, file);
      } catch (err) {
        logger?.warn(`Could not save ${file}: ${err.code ?? err.message}`);
      }
    });
    return writing;
  }

  function touch() {
    if (!timer) {
      timer = setTimeout(flush, debounceMs);
      timer.unref?.();
    }
  }

  return {
    load,
    flush,
    touch,
    get data() {
      return data;
    },
    /** The token store of the Bluelink client: a new token set is saved at once. */
    tokenStore: {
      get: () => data.tokens ?? null,
      set(tokens) {
        data.tokens = tokens ?? null;
        flush();
      },
    },
  };
}
