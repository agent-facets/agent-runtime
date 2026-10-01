// Hash routes, so the server only ever serves one page: `#/` lists runs, `#/runs/<id>` shows one.
import { useEffect, useState } from 'react';

export type Route = { view: 'home' } | { view: 'run'; runId: string };

export function parseRoute(hash: string): Route {
  const match = /^#\/runs\/([0-9a-f-]{36})$/.exec(hash);
  return match?.[1] === undefined ? { view: 'home' } : { view: 'run', runId: match[1] };
}

export const runHref = (runId: string) => `#/runs/${runId}`;

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const update = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return route;
}
