// The console's frame: the session sidebar beside the current view. On a narrow screen the sidebar is a drawer,
// opened from the top bar and closed by choosing a session, Escape, or the backdrop.
import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../api/client.ts';
import { CapabilitiesPage } from './Capabilities.tsx';
import { Home } from './Home.tsx';
import { RunDetail } from './RunDetail.tsx';
import { useRoute } from './route.ts';
import { Sidebar } from './Sidebar.tsx';
import { button, cx, MenuIcon } from './ui.tsx';

export function App({ client }: { client: ApiClient }) {
  const route = useRoute();
  const [menu, setMenu] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const close = () => setMenu(false);
    window.addEventListener('hashchange', close);
    return () => window.removeEventListener('hashchange', close);
  }, []);
  useEffect(() => {
    if (!menu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMenu(false);
      opener.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  return (
    <div className="flex h-dvh overflow-hidden">
      {menu && (
        <button
          type="button"
          aria-label="Close sessions"
          tabIndex={-1}
          className="fixed inset-0 z-30 bg-zinc-950/40 md:hidden"
          onClick={() => setMenu(false)}
        />
      )}
      <aside
        className={cx(
          'z-40 w-72 shrink-0 border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900',
          'max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:shadow-xl max-md:transition-transform',
          menu ? 'max-md:translate-x-0' : 'max-md:invisible max-md:-translate-x-full',
        )}
      >
        <Sidebar
          client={client}
          activeRunId={route.view === 'run' ? route.runId : undefined}
          onClose={menu ? () => setMenu(false) : undefined}
        />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-200 px-2 md:hidden dark:border-zinc-800">
          <button
            ref={opener}
            type="button"
            className={button.ghost}
            aria-label="Open sessions"
            aria-expanded={menu}
            onClick={() => setMenu(true)}
          >
            <MenuIcon />
          </button>
          <a href="#/" className="text-sm font-semibold">
            Agent runtime
          </a>
        </header>
        <div className="min-h-0 flex-1">
          {route.view === 'run' ? (
            <RunDetail key={route.runId} client={client} runId={route.runId} />
          ) : route.view === 'capabilities' ? (
            <CapabilitiesPage client={client} />
          ) : (
            <Home client={client} />
          )}
        </div>
      </div>
    </div>
  );
}
