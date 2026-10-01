// The browser console's static files, served by the runtime itself rather than by Bun's automatic HTML routes, so
// every request for them passes the same request checks as the API. In the built application the console was
// bundled ahead of time beside the server (its manifest lists each file); when running from source it is bundled
// once, in memory, at startup. Only the listed files are served — never the workspace or anything else on disk.
import { basename, join } from 'node:path';
import consoleEntry from '@agent-runtime/ui';
import type { HTMLBundle } from 'bun';

export interface ConsoleFile {
  body: Uint8Array;
  headers: Record<string, string>;
}

/** URL path (`/` for the page) to file. */
export type ConsoleFiles = ReadonlyMap<string, ConsoleFile>;

const SAFE_NAME = /^[A-Za-z0-9._-]{1,128}$/;

function headersFor(contentType: string, page: boolean, etag?: string): Record<string, string> {
  return {
    'content-type': contentType,
    // The page is always revalidated; its scripts and styles have content-hashed names.
    'cache-control': page ? 'no-store' : 'private, max-age=31536000, immutable',
    ...(etag === undefined ? {} : { etag }),
  };
}

const sourceBuilds = new Map<string, Promise<Awaited<ReturnType<typeof Bun.build>>['outputs']>>();

/** One in-memory bundle per entry and process; concurrent callers share it. */
function buildFromSource(entry: string) {
  let pending = sourceBuilds.get(entry);
  if (pending === undefined) {
    pending = Bun.build({ entrypoints: [entry], target: 'browser', minify: true }).then((built) => {
      if (!built.success) throw new Error('the console could not be bundled');
      return built.outputs;
    });
    sourceBuilds.set(entry, pending);
    pending.catch(() => sourceBuilds.delete(entry));
  }
  return pending;
}

export async function loadConsole(bundle: HTMLBundle = consoleEntry): Promise<ConsoleFiles> {
  const files = new Map<string, ConsoleFile>();
  const add = (name: string, body: Uint8Array, contentType: string, etag?: string) => {
    const page = name.endsWith('.html');
    if (!SAFE_NAME.test(name)) throw new Error('unexpected console file name');
    files.set(page ? '/' : `/${name}`, { body, headers: headersFor(contentType, page, etag) });
  };

  if (bundle.files !== undefined) {
    for (const file of bundle.files) {
      const name = basename(file.path);
      add(name, await Bun.file(join(import.meta.dir, name)).bytes(), file.headers['content-type'], file.headers.etag);
    }
  } else {
    for (const output of await buildFromSource(bundle.index)) {
      add(basename(output.path), new Uint8Array(await output.arrayBuffer()), output.type);
    }
  }
  if (!files.has('/')) throw new Error('the console has no page');
  return files;
}
