// The button that opens the session drawer on a narrow screen. The frame provides it; a page with its own top bar
// (a session) places it there, so a phone shows one bar rather than two.
import { createContext, type RefObject, useContext } from 'react';
import { cx, MenuIcon, smallButton } from './ui.tsx';

export type Menu = { open: () => void; expanded: boolean; opener: RefObject<HTMLButtonElement | null> };

export const MenuContext = createContext<Menu | undefined>(undefined);

export function MenuButton({ className }: { className?: string }) {
  const menu = useContext(MenuContext);
  if (menu === undefined) return null;
  return (
    <button
      ref={menu.opener}
      type="button"
      className={cx(smallButton.ghost, 'md:hidden', className)}
      aria-label="Open sessions"
      aria-expanded={menu.expanded}
      aria-controls="session-drawer"
      onClick={menu.open}
    >
      <MenuIcon />
    </button>
  );
}
