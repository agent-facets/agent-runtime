# Console design system

The browser console (`packages/ui`) is a chat-style app for running agent sessions. This document is the source of
truth for how it looks and behaves. Read it before changing the console; reuse what is here; when a change needs a
pattern that is not here, add it here in the same change.

The shared code is `packages/ui/src/app/ui.tsx` (recipes, `Status`, `Notice`, `Disclosure`, `Facts`, icons) and
`packages/ui/src/styles.css` (page base, the `short` variant, Markdown prose). Styling is Tailwind utilities only, with
no component library.

## Direction

**ChatGPT's conversation layout, with Linear's restraint for metadata**, in our own neutral palette.

| Reference | What we take from it |
| --- | --- |
| [ChatGPT: conversation and composer](https://mobbin.com/screens/f9fa472b-1f11-45f1-9132-019c2501f56d) | One reading column; unboxed assistant prose; a grey user bubble; a rounded, slightly raised composer in the column; a borderless tinted sidebar with one-line rows and quiet sentence-case group labels |
| [ChatGPT: working state](https://mobbin.com/screens/fc303bbc-5d5f-4ffc-b3ce-065abc9693bc) | Progress is a quiet line, not a panel |
| [Linear: issue detail](https://mobbin.com/screens/f00cc4fb-4083-43fc-a0fb-703a6c4ef771) | Activity as `text · time` lines; small, muted metadata; properties behind the main content |
| [Linear: compact list](https://mobbin.com/screens/fd1b4d88-f021-49a3-98af-4cd3a87e1d29) | Dense rows, subtle selection fill, restrained status colour |

Borrow patterns, never branding. Do not add features a reference has and the runtime does not support. In
particular, the console has **no general message box and no continue or resume control**: the only place the owner
writes into a running session is the answer to a pending question.

## Principles

1. **The conversation leads.** Messages and questions carry the page; bookkeeping is folded or quiet.
2. **Nothing recorded disappears.** Folded is fine; dropped is not. Every event stays reachable in order.
3. **Problems and questions stand out.** Failures (red), uncertain outcomes (amber) and a waiting question (amber)
   are never folded or made quiet.
4. **Words first, colour second.** Every state is written out; colour and dots only reinforce it.
5. **Nothing moves unless asked.** New activity never scrolls the page or takes focus.
6. **Say it once.** A waiting question's prompt, a status or an explanation appears in one place.

## Foundations

### Colour

Neutral is zinc. Light: white canvas, `zinc-50` sidebar, `zinc-200` borders, `zinc-100` hairlines. Dark: `zinc-950`
canvas, `zinc-900` sidebar and surfaces, `zinc-800` borders. Both follow the system setting.

| Meaning | Colour | Used for |
| --- | --- | --- |
| Working | blue | `Working`, `Stopping` status |
| Waiting, needs attention, uncertain | amber | `Waiting for you`, a waiting question, unknown outcomes, sign-in needed |
| Finished, ready | emerald | `Finished`, the `Result` badge, ready capabilities |
| Failed, refused | red | `Failed`, `Interrupted`, refusals, `Stop session` |
| Links and focus | blue | links, the focus ring |

`muted` (`zinc-500` / `zinc-400`) is the only secondary text colour; keep it readable rather than fainter.

### Type

The system font. Conversation prose and text inputs are 16px (`text-base`): inputs stay 16px on phones so they do not
zoom. Controls and lists are 14px (`text-sm`). Metadata, times and section labels are 12px (`text-xs`). Page titles are
24px semibold (`pageTitle`); the session title is 14px semibold. Section labels are sentence case (`sectionTitle`),
never uppercase.

### Space, shape, elevation

A 4px scale, mostly 8, 12, 16, 24 and 32px. Radius: 8px for controls and rows (`rounded-lg`), 12px for cards
(`rounded-xl`), 16px for composers (`rounded-2xl`), 24px for the user bubble (`rounded-3xl`). Shadows only where
something sits above the page: the composers (`shadow-sm`, `shadow-md` while focused), the floating jump button and
the drawer.

### Layout

- **One column.** `column` (`max-w-3xl`, 16px gutters, 24px from `md`) holds every page, the session header, the
  conversation and the answer form, so their edges line up. Never pad outside it.
- **Sidebar.** 256px (`w-64`), tinted, beside the content from `md` (768px); below that it is a drawer.
- **Scrolling.** The frame never scrolls; each view owns its scroll area. Below 600px of height (the `short:`
  variant: a phone in landscape or with its keyboard up), a session page scrolls as one and the answer form follows
  the conversation instead of being docked over it.

## Controls

| Recipe | Use |
| --- | --- |
| `button.primary` | The one main action of a form: `Start session`, `Send answer`, `Connect` |
| `button.secondary` | Other actions: `Retry same start`, `Reconnect`, `Refresh commands` |
| `button.ghost` | Icon buttons and sidebar actions |
| `button.link` | Inline navigation within a page: `View question`, `Answer` |
| `smallButton.*` | Dense places: the session header (`Stop session`), toolbars, server rows |
| `floatingButton` | `Jump to latest` |
| `field`, `label` | Text inputs, selects and their labels (labels wrap their field) |
| `optionRow` | A choice in a question; wraps beside its neighbours |

A `select` also gets an explicit `aria-label`: a wrapping label's text includes the selected option's, so its name
would otherwise change with the selection (and differ between tools).

Buttons are 36px (32px small) and 44px on touch screens. Never append a utility that conflicts with a recipe (a second
height, padding or radius): with no class merging, which one wins is undefined. Add a recipe variant instead.

Every interactive element shows the shared focus ring (`:focus-visible`, blue, 2px offset); inside clipped lists it is
drawn inset. Transitions are short colour or shadow changes and are switched off under reduced motion.

## Surfaces and feedback

- `card`: bordered surface for grouped content (a server). `cardList`: rows separated by hairlines (contributions).
- `composer`: where the owner writes (the start form, the answer form).
- `emptyState`: dashed placeholder for loading, empty or unconfigured content. Always say what is missing.
- `notice(tone)` for text present from the start; `<Notice tone>` for feedback that appears in response to something
  (errors are announced as alerts, everything else politely). Tones: `error`, `uncertain`, `ok`, `info`.
- `Disclosure` / `summaryLine` + `ChevronIcon`: anything most people leave closed (Options, Connection, Details,
  Capabilities, Activity, tool results). A disclosure that needs attention (an invalid limit, a needed sign-in) is
  forced open. Contents stay mounted, so nothing typed is lost.
- `Facts` / `Fact`: labelled values, label above value on phones and beside it from `sm`.
- `Status`: a session state as a dot and its words.

## Patterns

### Sidebar

`New session`, then `Sessions` (newest first), then `Installed capabilities` pinned at the bottom. A session row is two
lines: its first message and how long ago it changed; then its status, provider, start time and short ID. The
execution spec requires all of these, so they are quiet, never removed. The current page has a filled row and
`aria-current="page"`.

On a narrow screen the sidebar is a modal drawer (`role="dialog"`, the rest of the page `inert`). Escape, the close
button and the backdrop return focus to the menu button; choosing a destination moves focus to that page. A session
page carries the menu button in its own header, so a phone shows one bar.

### Start page

A centred `New session` title and one composer: the message (or an installed command and its arguments), then a row
with the Message/Command switch, the model and `Start session` (Ctrl/Cmd+Enter). Below it, `Options` and `Connection`
disclosures and the workspace. A connection form is its own form, never part of the start form.

### Session page

- **Header**: the title (first message), then `Status · provider · model · n/max requests`, both one truncated line;
  `Stop session` while it can be stopped (`Stop` on phones, same accessible name).
- **Meta row**: connection state (`Live`, `Reconnecting…`, `All history loaded`; distinct from the session's status),
  then `Details` and, for a command run, `Capabilities` disclosures.
- **Then**: the state's one-line explanation (not while a question is waiting: the question says so), and a failure
  or interruption with its category and guidance, which is never folded.

### Conversation

In recorded order, never reordered:

- **The owner's message**: a right-aligned grey bubble, its time beneath.
- **Assistant messages**: unboxed Markdown prose under a small `Assistant` label (or the delegate's name) and time; the
  final one has a `Result` badge.
- **Activity**: consecutive routine events by one actor fold into one `Activity · n tool calls · n model requests`
  row: model requests and tool calls that went normally, a call paused to ask a question, and the working and waiting
  status changes. A failure, an uncertain outcome, a question, a delegation, an actor change or any other status
  change ends a fold.
- **Other events**: one line each with the time at the end, as in an activity feed. Status changes, `Stop requested`,
  closed questions and successful delegations are quiet (12px, muted). Problems are red boxes, uncertain outcomes
  amber boxes.
- **Times** are clock times (`formatClock`: the time today, with the date otherwise); the exact time is on hover.

### Questions

A waiting question's prompt appears **once**: in the conversation, as an amber card at its place, with `Waiting for
your answer below.` and `Answer ↓`. The answer form below the conversation shows who is asking, the controls (choices
as `optionRow`s, or a text field with its length limits), `Send answer` and `View question ↑`; it is described by the
prompt (`aria-describedby`), so a screen reader hears the question with the controls. Its choices are not listed again
in the card; once answered, the card lists them with their values, followed by the accepted answer.

If the session's state arrives before its history, the prompt is shown once as a provisional entry after the
conversation, with no time, until the real record replaces it. The form is keyed by the question, so a typed answer
survives history arriving, reconnects and layout changes.

The answer form sits in the column like a reply box, at most 45% of the screen high and scrolling inside. On short
screens it follows the conversation instead.

### Capabilities and connections

The capabilities page uses the same column, title and `Refresh`. Contributions are a `cardList`: name and kind, status
on the right (green ready, amber not allowed, red refused), then ID and origin as metadata, then the description.
Servers are cards: name and connection state, origin, any digest to approve, granted tools, and `Inspect server`
(which starts the server briefly and calls nothing). Long IDs, digests and JSON wrap or scroll within their box.

Provider sign-in panels are numbered steps with one primary action each; a connected provider stays folded away.

## Content

- Say **session** in the interface; the API, routes and stored data say *run*.
- Sentence case everywhere. Name things by what they are (`Stop session`, not `Cancel`).
- Every value from the server is rendered as text, never as HTML. Assistant Markdown is the one exception, rendered
  safely (`Markdown.tsx`: raw HTML shown as text, no images, links open in a new tab).

## Checklist for a console change

- [ ] Uses the recipes and patterns above, or adds the new one here.
- [ ] Lines up with the column; no padding outside it.
- [ ] Nothing recorded becomes unreachable; problems and questions stay prominent; nothing is said twice.
- [ ] Works by keyboard, with a visible focus ring; feedback is announced.
- [ ] Checked on the development deployment in a browser: desktop (1440px), phone (390px), short (390px high), light
      and dark.
- [ ] Behaviour is covered by component tests (`packages/ui/src/app/views.test.tsx`); browser tests stay smoke checks.
