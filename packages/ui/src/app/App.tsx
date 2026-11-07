// The console's frame: the session sidebar beside the current view. On a narrow screen the sidebar is a modal
// drawer, opened from the menu button in the top bar (a session's own, or the frame's). While it is open the rest
// of the page is inert; Escape, its close button and the backdrop return focus to the menu button, and choosing a
// destination moves focus to that destination.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiClient } from '../api/client.ts';
import { CapabilitiesPage } from './Capabilities.tsx';
import { Home } from './Home.tsx';
import { MenuButton, MenuContext } from './menu.tsx';
import { RunDetail } from './RunDetail.tsx';
import { useRoute } from './route.ts';
import { Sidebar } from './Sidebar.tsx';
import { cx } from './ui.tsx';

/** Where the sidebar stops being a drawer: Tailwind's `md`. */
const WIDE = '(min-width: 48rem)';

export function App({ client }: { client: ApiClient }) {
  const route = useRoute();
  const [menu, setMenu] = useState(false);
  const menuOpen = useRef(false);
  const opener = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  menuOpen.current = menu;
  const openMenu = useCallback(() => setMenu(true), []);
  const menuControl = useMemo(() => ({ open: openMenu, expanded: menu, opener }), [openMenu, menu]);

  const close = useCallback((returnFocus: boolean) => {
    setMenu(false);
    // After the page behind the drawer stops being inert: an inert element refuses focus.
    if (returnFocus) requestAnimationFrame(() => opener.current?.focus());
  }, []);

  // Choosing a destination from the drawer (even the page already shown) closes it and lands on that destination.
  const navigated = useCallback(() => {
    if (!menuOpen.current) return;
    menuOpen.current = false;
    setMenu(false);
    requestAnimationFrame(() => content.current?.focus({ preventScroll: true }));
  }, []);

  useEffect(() => {
    window.addEventListener('hashchange', navigated);
    const wide = window.matchMedia(WIDE);
    const resized = () => {
      if (wide.matches) setMenu(false);
    };
    wide.addEventListener('change', resized);
    return () => {
      window.removeEventListener('hashchange', navigated);
      wide.removeEventListener('change', resized);
    };
  }, [navigated]);
  useEffect(() => {
    if (!menu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu, close]);

  return (
    <div className="flex h-dvh overflow-hidden">
      {menu && (
        <button
          type="button"
          aria-label="Close sessions"
          tabIndex={-1}
          className="fixed inset-0 z-30 bg-zinc-950/40 md:hidden"
          onClick={() => close(true)}
        />
      )}
      <aside
        id="session-drawer"
        // A modal dialog only while it is an open drawer; beside the page it is plain navigation.
        {...(menu ? { role: 'dialog', 'aria-modal': true, 'aria-label': 'Sessions' } : {})}
        className={cx(
          'z-40 w-64 shrink-0 border-r border-zinc-100 bg-zinc-50 dark:border-zinc-800/60 dark:bg-zinc-900',
          'max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:max-w-[85vw] max-md:shadow-xl max-md:transition-transform max-md:motion-reduce:transition-none',
          menu ? 'max-md:translate-x-0' : 'max-md:invisible max-md:-translate-x-full',
        )}
      >
        <Sidebar
          client={client}
          activeRunId={route.view === 'run' ? route.runId : undefined}
          capabilitiesActive={route.view === 'capabilities'}
          onClose={menu ? () => close(true) : undefined}
          onNavigate={navigated}
        />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col" inert={menu}>
        <MenuContext value={menuControl}>
          {/* A session has its own top bar, which carries the menu button. */}
          {route.view !== 'run' && (
            <header className="flex h-12 shrink-0 items-center gap-1 border-b border-zinc-100 px-2 md:hidden dark:border-zinc-800/60">
              <MenuButton />
              <a href="#/" className="rounded px-1 text-sm font-semibold">
                Agent runtime
              </a>
            </header>
          )}
          <div ref={content} tabIndex={-1} className="min-h-0 flex-1 focus:outline-none">
            {route.view === 'run' ? (
              <RunDetail key={route.runId} client={client} runId={route.runId} />
            ) : route.view === 'capabilities' ? (
              <CapabilitiesPage client={client} />
            ) : (
              <Home client={client} />
            )}
          </div>
        </MenuContext>
      </div>
    </div>
  );
}
