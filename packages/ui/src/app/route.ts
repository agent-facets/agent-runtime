// Hash routes, so the server only ever serves one page: `#/` starts a session, `#/runs/<id>` shows one, and
// `#/capabilities` lists what is installed. The session list is always beside them.
import { useEffect, useState } from 'react';

export type Route = { view: 'home' } | { view: 'run'; runId: string } | { view: 'capabilities' };

export function parseRoute(hash: string): Route {
  if (hash === CAPABILITIES_HREF) return { view: 'capabilities' };
  const match = /^#\/runs\/([0-9a-f-]{36})$/.exec(hash);
  return match?.[1] === undefined ? { view: 'home' } : { view: 'run', runId: match[1] };
}

export const runHref = (runId: string) => `#/runs/${runId}`;

export const CAPABILITIES_HREF = '#/capabilities';

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const update = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return route;
}
