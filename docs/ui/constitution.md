# Stonehush UI Constitution

Status: v0.1 baseline

This document defines observable layout, interaction, motion, theme, responsive, and accessibility behavior. Implementations may change as long as these contracts remain true.

## 1. Shell anatomy

The application shell has four sidebar regions:

1. A fixed header with brand, optional environment/status badge, and mobile toggle.
2. A fixed quick-action area with command search, primary create action, and scope/filter control.
3. The only vertically scrollable sidebar area, containing work lists.
4. A fixed footer with status notices and Settings.

The main workspace uses one shared inset layout: a flex column with `min-width: 0`, its own background and static grain, and stable geometry across routes.

The bottom console is part of the shared shell and contains Advisor, Activity, and Raw output.

## 2. Sidebar geometry and persistence

### Desktop

- The desktop breakpoint is 768 px.
- The sidebar is fixed on the left and reserves an equal layout gap.
- Collapse moves the full sidebar off canvas.
- Default width: 256 px.
- Minimum width: 208 px.
- Maximum width: `max(208px, viewport width - 640px)`.
- Collapse and expand animate `width`, `left`, and `right` for 200 ms linear.
- A separate fixed toggle remains available while the sidebar is hidden.
- The resize rail changes width. A separate toggle handles collapse.

Desktop and mobile open states are independent.

### Mobile

- The sidebar is a modal sheet with full viewport width.
- It respects safe areas and browser/window controls.
- Navigation closes the sheet.
- Labels remain visible and tooltips add shortcut help.

### Resize contract

Resize begins only for the primary pointer while the desktop sidebar is open.

- Capture the pointer for the full gesture.
- Apply width updates at most once per animation frame.
- Disable layout transitions during the gesture.
- Use the `col-resize` cursor and disable text selection.
- After movement beyond 2 px, suppress the click following the gesture.
- On pointer up, pointer cancel, or unmount, release capture and restore temporary styles.
- Clamp every restored and dragged value to the current viewport bounds.

Width and open state are stored locally. Restore both before first paint to avoid layout flash. Expiring open-state storage may use a seven-day lifetime; width remains until explicitly reset.

## 3. Bottom console

- Default height: 320 px.
- Minimum expanded height: 220 px.
- Maximum: 60% of viewport height.
- Collapsed form: compact status bar.
- Height persists locally and is clamped when viewport size changes.
- On mobile, the console opens as a full-screen sheet.
- Resize follows the same pointer-capture, animation-frame, cleanup, and reduced-motion rules as the sidebar.

## 4. Navigation and list hierarchy

Lists use consistent density:

- Primary or in-progress entities use content-rich cards.
- Parked, completed, or historical entities use compact rows.
- Secondary groups use collapsible shelves with item counts.
- The current route item remains visible even when its shelf is closed or it falls outside the paginated history tail.
- History initially shows 10 rows and loads explicit batches of 25 through `Show more`.
- Changing scope or filter resets deep pagination.
- Keyboard traversal order matches visual order.
- Jump navigation and multi-selection use the rendered visual order.
- Long lists may use `content-visibility: auto` with an appropriate intrinsic size.

Stonehush maps this hierarchy to active runs or current work as cards, queued or paused work in a shelf, and completed or reviewed work as compact history. Domain language comes from Stonehush contracts.

## 5. Row surface model

Surface priority is strict:

1. Current route: `sidebar-row-active`.
2. Multi-selected: `sidebar-row-selected`.
3. Hover or keyboard focus: `sidebar-row-hover`.
4. Background work: muted foreground, restored to normal contrast on interaction.

The surface communicates interaction state. Operational status is communicated through text, icon, and accessible status content rather than a special background color.

### Card row

A card is approximately 78 px tall and contains:

- scope/context plus status or age;
- title;
- compact metadata.

### Compact row

A compact row is 36 px on pointer-based desktop and at least 44 px on touch/mobile. It contains icon, title, and compact metadata or action.

### Row interaction

- Hover actions also appear through `focus-within`.
- Touch layouts keep relevant row actions visible.
- An open popover pins its row actions until it closes.
- Rows render the actions available for their current capability set.
- Supported lifecycle actions expose their reverse operation.
- Route-active and multi-selected remain separate states.
- Moving an entity between card and compact sections changes the animated element identity so it exits and enters instead of flying through unrelated content.
- Prefer native links and buttons. Composite interactive rows require explicit keyboard and event-isolation behavior.

## 6. Fast execution and warning contract

Stonehush warnings use a single-step flow.

- Routine T0/T1 actions start directly.
- An outside-saved-scope, unusually large, or T2/T3/T4-labelled action shows at most one warning before the run.
- The primary action is always `Continue` for every representable action.
- `Add to scope & run` is an optional secondary action when saved scope is relevant.
- `Cancel` remains available as a quiet secondary action.
- The warning summarizes target, plugin, action, and why it appeared. Detailed normalized targets and options are expandable rather than blocking the primary path.
- One acknowledgment covers the whole run, including later DNS answers and redirect hops.
- `Always continue warnings for this engagement` enables the fast CTF path and can be reversed in engagement settings.
- One acknowledgment covers the complete action.
- Scope mismatch keeps the Run button enabled.
- The dialog places initial focus predictably, supports Enter to continue and Escape to cancel, and keeps verbose target data in an expandable region.
- Timeline and run details record the warning acknowledgment.

## 7. Motion

Motion is bounded and communicates state:

- Sidebar geometry: 200 ms linear.
- Sheet and dialog: 200 ms ease-in-out.
- List add, remove, and reorder: 150 ms ease-out.
- Collapsible height: 200 ms.
- One-shot acknowledgement: approximately 180 ms ease-out.
- Active resize disables transitions and uses animation-frame-bounded updates.
- Status animation runs only while real work is active and is stepped or duty-cycled.
- Skeletons appear only for real loading and match the shape of expected content.

With `prefers-reduced-motion`, list auto-animation, working/status animation, shimmer, and nonessential transforms or fades become static. Geometry changes may become immediate. A shared policy applies this behavior across components.

Decorative surfaces stay static when application state is unchanged.

## 8. Theme and tokens

Colors are semantic roles and components consume those shared tokens.

Required roles:

- background and foreground;
- card and popover;
- muted and accent;
- primary;
- border, input, and ring;
- destructive, info, success, and warning;
- sidebar base, foreground, muted foreground, control, hover, active, selected, and border.

Brand rules:

- Workspace primary uses emerald around hue 145.
- Sidebar uses cooler pine/teal around hue 168.
- Light primary: `oklch(0.55 0.18 145)`.
- Dark primary: `oklch(0.78 0.21 145)`.
- Base radius: 10 px; the radius scale derives from it.
- Glass blur: 12 px and only for transient overlays such as tooltips, popovers, and dialogs.
- Grain is a static texture on its owning surface.

Theme preference is `light`, `dark`, or `system`, with `system` as default. Apply it before mount, follow OS changes in system mode, synchronize changes across tabs, and temporarily suppress transitions during a theme switch.

Typography:

- DM Sans Variable for interface text.
- JetBrains Mono for IPs, ports, hashes, durations, counts, and technical identifiers.

Icons use Lucide, normally at 16 px. Decorative icons are hidden from assistive technology. Icon-only controls always have an accessible name and an effective 44 by 44 px target.

## 9. Responsive and touch behavior

- Mobile layouts use full-screen sheets designed for touch.
- Desktop-only resize affordances appear only where pointer precision and viewport width support them.
- Compact rows grow to at least 44 px on touch/mobile.
- All icon controls provide a minimum 44 by 44 px hit area, including pseudo-element expansion where appropriate.
- Navigation and top controls respect safe areas.
- Every row action is available through hover, focus, and touch.

## 10. Accessibility and keyboard contract

- Sidebar toggles expose `aria-pressed`, a clear accessible name, and shortcut help.
- Modal sheets have accessible title and description, visually hidden when necessary.
- Collapsible shelf triggers are native buttons with `aria-expanded`.
- Rows prefer native links or buttons.
- A required composite row supports Enter and Space, while nested actions stop propagation.
- Inline rename focuses and selects on entry; Enter commits, Escape cancels, and blur commits.
- Status combines text with its visual treatment.
- Live regions announce stable state changes while ticking durations stay outside them.
- Hover actions are reachable by keyboard focus.
- Visual jump badges are `aria-hidden`; shortcut help exists in a discoverable registry.
- Global sidebar shortcuts run before editor shortcuts but ignore regions marked with `data-keybinding-capture`.
- Jump hints appear only for the exact modifier chord.
- Focus indicators use the semantic ring token and remain visible in every theme.

## 11. Loading, empty, stale, and error states

### Loading

- Preserve the stable shell and already known data during background refresh.
- Initial loading uses shape-matched skeletons rather than a blank page.
- A loading container provides `role="status"`, `aria-live="polite"`, and a visually hidden label.
- Spinners appear only for a real pending operation.

### Empty

- A primary-page empty state uses a centered title, short explanation, and one primary action.
- A sidebar empty state uses compact local copy and a local action.
- No-data and no-results-for-current-filter are different states with different text.

### Stale and error

- Background errors preserve still-valid stale data.
- Recoverable command failures use a toast or inline banner with retry where meaningful.
- Page failures show a clear title, message, and primary retry action.
- Fatal root failures provide a retry boundary, reload action, and collapsed technical details.
- Error rendering redacts secrets and raw command flags and treats markup as untrusted text.

## 12. Component-gallery acceptance

Before domain pages are built, the gallery demonstrates:

- desktop and mobile shell;
- open, collapsed, resized, and persisted sidebar states;
- console expansion, collapse, resize, and mobile sheet;
- card and compact rows in active, selected, hover/focus, background, and status states;
- shelves, filtering, history pagination, and current-route preservation;
- direct T1 execution, one-click warning continuation, engagement auto-continue, and cancellation;
- light, dark, and system themes;
- keyboard-only and touch interactions;
- normal and reduced motion;
- loading, empty, filtered-empty, stale, recoverable-error, and fatal-error states.

Appearance changes require before/after screenshots. Motion, resizing, persistence, or timing changes require a short recording from the branch under review.
