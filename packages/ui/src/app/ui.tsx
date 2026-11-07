// The console's small design kit: shared Tailwind class strings, status badges and the few icons it draws. Every
// state is written out in words; colour only reinforces it.
import type { RunStateKind } from '@agent-runtime/contracts';
import { STATE_LABELS } from './format.ts';

export const cx = (...classes: (string | false | undefined)[]) => classes.filter(Boolean).join(' ');

const BUTTON =
  'inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg px-3.5 text-sm font-medium transition-colors ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-50';

export const button = {
  primary: `${BUTTON} bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white`,
  secondary: `${BUTTON} border border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800`,
  danger: `${BUTTON} border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950`,
  ghost: `${BUTTON} text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100`,
  link: 'text-sm font-medium text-blue-600 hover:underline dark:text-blue-400',
};

export const field =
  'mt-1.5 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 shadow-xs ' +
  'placeholder:text-zinc-400 focus:border-blue-500 focus:outline-2 focus:outline-blue-500/30 ' +
  'dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100';

export const label = 'block text-sm font-medium text-zinc-700 dark:text-zinc-300';

export const muted = 'text-zinc-500 dark:text-zinc-400';

/** Secondary text inside a line (an origin, a digest, an explanation). */
export const hint = `hint ${muted}`;

/** A section heading inside a panel. */
export const subheading = 'mt-5 mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400';

/** Inline code. */
export const code = 'rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.85em] dark:bg-zinc-800';

export const card = 'rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900';

/** A disclosure's summary line: quiet, with a turning chevron. */
export const summaryLine =
  'flex w-fit cursor-pointer list-none items-center gap-1.5 text-sm text-zinc-600 select-none hover:text-zinc-900 ' +
  'dark:text-zinc-400 dark:hover:text-zinc-100 [&::-webkit-details-marker]:hidden';

const NOTICE = {
  error: 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300',
  uncertain:
    'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300',
  ok: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-300',
  info: 'border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300',
} as const;

export const notice = (tone: keyof typeof NOTICE) =>
  `notice ${tone} rounded-lg border px-3 py-2 text-sm ${NOTICE[tone]}`;

const STATUS_TONE: Record<RunStateKind, string> = {
  working: 'bg-blue-500',
  cancelling: 'bg-blue-500',
  waiting: 'bg-amber-500',
  succeeded: 'bg-emerald-500',
  failed: 'bg-red-500',
  interrupted: 'bg-red-500',
  cancelled: 'bg-zinc-400',
};

const STATUS_TEXT: Record<RunStateKind, string> = {
  working: 'text-blue-700 dark:text-blue-400',
  cancelling: 'text-blue-700 dark:text-blue-400',
  waiting: 'text-amber-700 dark:text-amber-400',
  succeeded: 'text-emerald-700 dark:text-emerald-400',
  failed: 'text-red-700 dark:text-red-400',
  interrupted: 'text-red-700 dark:text-red-400',
  cancelled: 'text-zinc-500 dark:text-zinc-400',
};

/** A session's status: a dot and its name. */
export function Status({ kind, className }: { kind: RunStateKind; className?: string }) {
  const live = kind === 'working' || kind === 'cancelling';
  return (
    <span
      className={cx(`status status-${kind} inline-flex items-center gap-1.5 font-medium`, STATUS_TEXT[kind], className)}
    >
      <span
        aria-hidden="true"
        className={cx('size-2 shrink-0 rounded-full', STATUS_TONE[kind], live && 'animate-pulse')}
      />
      {STATE_LABELS[kind]}
    </span>
  );
}

const icon = 'size-4 shrink-0';

export const PlusIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" className={icon} fill="none" stroke="currentColor" strokeWidth="1.75">
    <path d="M8 3v10M3 8h10" strokeLinecap="round" />
  </svg>
);

export const MenuIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" className={icon} fill="none" stroke="currentColor" strokeWidth="1.75">
    <path d="M2.5 4h11M2.5 8h11M2.5 12h11" strokeLinecap="round" />
  </svg>
);

export const CloseIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" className={icon} fill="none" stroke="currentColor" strokeWidth="1.75">
    <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
  </svg>
);

export const ChevronIcon = () => (
  <svg
    aria-hidden="true"
    viewBox="0 0 16 16"
    className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
  >
    <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const ArrowDownIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" className={icon} fill="none" stroke="currentColor" strokeWidth="1.75">
    <path d="M8 3v10M4 9l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const ArrowUpIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" className={icon} fill="none" stroke="currentColor" strokeWidth="1.75">
    <path d="M8 13V3M4 7l4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
