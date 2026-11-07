// The console's design kit: the shared Tailwind recipes, status badge, notices, disclosures, facts and the few
// icons it draws. DESIGN_SYSTEM.md at the repository root explains when to use each. Every state is written out in
// words; colour only reinforces it. Recipes are whole class strings, never combined with a conflicting utility:
// when a variant is needed, it gets its own recipe here.
import type { RunStateKind } from '@agent-runtime/contracts';
import { type ReactNode, useState } from 'react';
import { STATE_LABELS } from './format.ts';

export const cx = (...classes: (string | false | undefined)[]) => classes.filter(Boolean).join(' ');

// Layout

/** The one content column: every page, header, conversation and docked form lines up on it. */
export const column = 'mx-auto w-full max-w-3xl px-4 md:px-6';

/** A page's own heading (start page, capabilities). */
export const pageTitle = 'text-2xl font-semibold tracking-tight';

/** A section heading inside a page or panel; spacing is left to the caller. */
export const sectionTitle = 'text-xs font-medium text-zinc-500 dark:text-zinc-400';

/** A section heading with the standard space around it. */
export const subheading = `mt-6 mb-2 ${sectionTitle}`;

// Text

export const muted = 'text-zinc-500 dark:text-zinc-400';

/** Secondary text inside a line (an origin, a digest, an explanation). */
export const hint = `hint ${muted}`;

/** Small metadata: times, identities, counts. */
export const meta = 'text-xs text-zinc-500 dark:text-zinc-400';

/** Inline code and identifiers. */
export const code = 'rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.85em] dark:bg-zinc-800';

// Controls

const CONTROL =
  'inline-flex shrink-0 items-center gap-1.5 rounded-lg font-medium transition-colors motion-reduce:transition-none ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:focus-visible:outline-blue-400 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';
const REGULAR = `${CONTROL} h-9 px-3.5 text-sm pointer-coarse:h-11`;
const SMALL = `${CONTROL} h-8 px-2.5 text-xs pointer-coarse:h-11`;

const TONE = {
  primary: 'bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white',
  secondary:
    'border border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800',
  danger:
    'border border-red-300 bg-white text-red-700 hover:bg-red-50 dark:border-red-900 dark:bg-zinc-950 dark:text-red-400 dark:hover:bg-red-950',
  ghost:
    'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100',
} as const;

type Tone = keyof typeof TONE;
const variants = (size: string) =>
  Object.fromEntries(Object.entries(TONE).map(([tone, classes]) => [tone, `${size} ${classes}`])) as Record<
    Tone,
    string
  >;

/** Buttons at the regular size: 36px, 44px on touch screens. */
export const button = {
  ...variants(REGULAR),
  link: 'rounded text-sm font-medium text-blue-600 hover:underline dark:text-blue-400',
};

/** Buttons for dense places: headers, rows and toolbars. */
export const smallButton = variants(SMALL);

/** A floating, pill-shaped control above scrolling content. */
export const floatingButton = `${CONTROL} h-9 rounded-full border border-zinc-300 bg-white px-3.5 text-sm text-zinc-800 shadow-md hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800`;

export const label = 'block text-sm font-medium text-zinc-700 dark:text-zinc-300';

/** A text field or select inside a label. 16px on small screens, so phones do not zoom into it. */
export const field =
  'mt-1.5 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-base text-zinc-900 shadow-xs sm:text-sm ' +
  'placeholder:text-zinc-400 focus:border-blue-500 focus:outline-2 focus:outline-blue-500/30 aria-invalid:border-red-500 ' +
  'dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500';

/** A selectable option (radio or checkbox inside its label): sized to its label, wrapping with its neighbours. */
export const optionRow =
  'flex max-w-full cursor-pointer items-start gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm hover:bg-zinc-50 pointer-coarse:py-2.5 ' +
  'has-checked:border-zinc-900 has-checked:bg-zinc-50 has-focus-visible:outline-2 has-focus-visible:outline-blue-600 ' +
  'dark:border-zinc-800 dark:hover:bg-zinc-800/60 dark:has-checked:border-zinc-300 dark:has-checked:bg-zinc-800/60';

// Surfaces

/** A bordered surface: composers, server entries, grouped lists. */
export const card = 'rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900';

/** Where the owner writes: the start composer and the answer form. Rounded and slightly raised, like a reply box. */
export const composer =
  'composer rounded-2xl border border-zinc-200 bg-white shadow-sm transition-shadow motion-reduce:transition-none ' +
  'focus-within:border-zinc-300 focus-within:shadow-md dark:border-zinc-700 dark:bg-zinc-900 dark:focus-within:border-zinc-600';

/** A list inside a card, its rows separated by hairlines. */
export const cardList = `${card} divide-y divide-zinc-200 dark:divide-zinc-800`;

/** A placeholder where content will be, or would be: loading, empty or unavailable. */
export const emptyState = `empty rounded-xl border border-dashed border-zinc-300 px-4 py-6 text-center text-sm ${muted} dark:border-zinc-700`;

// Feedback

const NOTICE = {
  error: 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300',
  uncertain:
    'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300',
  ok: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-300',
  info: 'border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300',
} as const;

export type NoticeTone = keyof typeof NOTICE;

export const notice = (tone: NoticeTone) => `notice ${tone} rounded-lg border px-3 py-2 text-sm ${NOTICE[tone]}`;

/**
 * Feedback that appears in response to something: an error is announced at once, anything else politely. For text
 * that is part of the page from the start, use `notice` on a plain element instead.
 */
export function Notice({ tone, className, children }: { tone: NoticeTone; className?: string; children: ReactNode }) {
  return (
    <p role={tone === 'error' ? 'alert' : 'status'} className={cx(notice(tone), className)}>
      {children}
    </p>
  );
}

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
        className={cx('size-2 shrink-0 rounded-full', STATUS_TONE[kind], live && 'motion-safe:animate-pulse')}
      />
      {STATE_LABELS[kind]}
    </span>
  );
}

// Disclosure and facts

/** A disclosure's summary line: quiet, with a turning chevron. Its `<details>` needs the `group` class. */
export const summaryLine =
  'flex w-fit cursor-pointer list-none items-center gap-1.5 rounded text-sm text-zinc-600 select-none hover:text-zinc-900 ' +
  'dark:text-zinc-400 dark:hover:text-zinc-100 [&::-webkit-details-marker]:hidden';

/**
 * A disclosure the owner may open and close, which stays open while `forced`: a value or state that needs attention
 * is never hidden. Its contents stay mounted when closed, so nothing typed or in progress is lost.
 */
export function Disclosure({
  className,
  summary,
  forced = false,
  children,
}: {
  className?: string;
  summary: ReactNode;
  forced?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className={cx('disclosure group', className)}
      open={open || forced}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className={summaryLine}>
        <ChevronIcon />
        {summary}
      </summary>
      <div className="mt-3 w-full">{children}</div>
    </details>
  );
}

/** Labelled values, label beside value on wider screens and above it on phones. */
export function Facts({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <dl
      className={cx(
        'facts grid grid-cols-1 gap-x-6 text-sm sm:grid-cols-[minmax(7rem,max-content)_minmax(0,1fr)] sm:gap-y-2',
        className,
      )}
    >
      {children}
    </dl>
  );
}

export function Fact({ label: name, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <>
      <dt className={muted}>{name}</dt>
      <dd className="mb-2 min-w-0 break-words sm:mb-0" title={title}>
        {children}
      </dd>
    </>
  );
}

// Icons

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
    className="size-3.5 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none"
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
