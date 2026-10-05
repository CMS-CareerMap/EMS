# Style Guide — CareerMap Solutions EMS

The look approved by the client on 4 Oct 2026: the logo's colours with a Keka-style
layout. The tokens live in `web/src/index.css` (`@theme`); the everyday pieces in
`web/src/components/ui/`. A page uses those pieces — it does not copy classes from
another page. When the look changes, it changes there.

## Brand

- **Company:** CareerMap Solutions. **Product:** HR & Payroll.
- **Logo:** `web/public/logo-wide.png` in the white top bar, in full colour.
- **Font:** Plus Jakarta Sans (Google Fonts, loaded in `index.html`).
- **Tone:** plain, friendly English. Say what happened and what to do next.

## Colours

| Token | Value | Use |
|---|---|---|
| `brand-600` | `#8B2FE6` (the logo's purple) | Every action: buttons, links, focus rings, the selected tab |
| `bg-logo` | orange → pink → purple → sky | Only where it should catch the eye: the home banner, the line under the active tab, Check In, a readiness button. Used everywhere, it would mean nothing |
| `bg-logo-soft` | the same, pale | A highlighted figure (net pay, the latest payslip) |
| `gray-*` / `slate-*` | tinted towards the logo's plum | Text, borders, page furniture |
| `canvas` | `#F5F3F9` | The page behind the cards |
| `side` | `#1A1029` | The sidebar |

Status tones (`components/ui/tones.js`), the same everywhere — chips, tiles, icons:
`ok` emerald (present, approved, verified), `warn` amber (pending, late), `bad` red
(absent, rejected), `info` sky, `leave` pink (on leave), `brand` purple, `gray` (off,
withdrawn, left).

## Layout

- **Top bar** (white): menu button on a phone, logo, company name, search (Ctrl K),
  bell, the user button ("Signed in as HR" — on a phone, the role alone). The user
  menu has My Profile and Sign Out; Escape closes it.
- **Sidebar** (computer): slim, dark plum, icon above label, the waiting count beside
  a link. **Phone:** a bottom tab bar (`nav` "Pages") with "More", and the Menu drawer.
- **Page:** `PageHeader` — a white band with the page's `h1`, a line under it, its
  buttons, and its tabs (`role="tab"`; one tab is no choice, so none is drawn). The
  open tab is in the address (`?tab=`) so a link or a notice lands on it.
- **Content:** cards on the canvas, `p-4 sm:p-6`. Nothing may scroll the page
  sideways on a 390px phone: a wide table scrolls inside its own box.

## Pieces (`components/ui`)

| Piece | What it is |
|---|---|
| `styles.js` `btn.*` | `primary`, `secondary`, `soft`, `danger`, `dangerOutline`, `ok`, `gradient`, and the small `…Sm` ones for rows; `icon` for an icon button |
| `styles.js` `card`, `field`, `fieldSm`, `fileInput`, `th`, `td` | A card, form fields, a file picker, table head and cells |
| `bits.jsx` `Card` | A white card with a title, a line and a link; a titled card is a region named by its title |
| `bits.jsx` `StatTile` | A figure with its icon; with `onClick` it is a filter button (`aria-pressed`) |
| `bits.jsx` `Chip`, `Avatar`, `Ring`, `EmptyState`, `IconBox`, `CardLink` | Status chip, initials, a progress ring, an empty list, a soft icon square, "Open all ›" |
| `PageHeader`, `Tabs`, `Segmented`, `ProfileCover` | The page band; tabs; a two-or-three-way switch; a profile's cover with avatar, chips and tabs |

Lists and dialogs:
- A query is drawn through `components/DataState.jsx` — an error is never an empty
  list or a zero. A list drawn twice (cards on a phone, a table on a computer) shows
  its error twice; only the visible one counts.
- Dialogs use `components/Dialog.jsx` or `ConfirmDialog.jsx`: `role="dialog"`,
  `aria-modal`, a name, a Close button, Escape closes.
- A column with no heading text gets `aria-label` on its `th` — never an `sr-only`
  span, which widens the page on a phone.

## Icons

Lucide (`lucide-react`). `w-4 h-4` in buttons and rows, `w-5 h-5` in the bars.
Decorative icons carry `aria-hidden="true"`.

## Writing on screen

- Dates through `lib/dates.js`: "4 Oct 2026" everywhere (there is no date format
  setting). Instants on the company's clock.
- Money in Indian grouping, `en-IN`: "₹1,23,456"; payslip figures keep their paise.
- Buttons say what they do ("Approve", "Hand it in"), not "OK".
