# Stonehush v5 workflow decision

Continued product and UI iteration on merged PR #44. The approved mock remains the visual source of truth. Its prototype logic is not automatically product logic.

## Chosen model

Engagement-first workspace (Model A, reviewed hybrid). The operator works inside one engagement at a time. The sidebar is the engagement list. The stage header is current context and the few real actions. The main workspace is the selected engagement. The bottom console is shell-global and later binds to the current engagement. Global destinations stay visible.

## Journeys

1. First run: empty sidebar and Engagements empty state; create with supported fields only; record appears and is selected without reload.
2. Select: Overview shows real metadata.
3. Targets/scope, runs, evidence, findings, notes, report, advisor: listed as the intended next work. Activating any of them announces “Not connected yet.”
4. Archive / reopen: real mutations using expectedRevision. Rows move Active ↔ Archived.
5. Stale / offline: shell stays mounted; recoverable banners; revision conflict refreshes the list.

## Prototype improvements

One object named engagement. Lifecycle is only active/archived + reopen. Search is a local filter. Create uses CreateEngagementRequestSchema only. No seeded fake runs. Global nav stays visible. Upcoming v0.1 surfaces are discoverable in one place. Console stays shell-global. Constitution 768/44/320 geometry is kept.

## Reviewer dispositions

Keep the engagement spine and drop scaffold theater. No fake Continue, warning dialogs, or metric tiles. Search is an honest local filter. Scope/New run are visible and explicitly not connected. Console is not a fake stream. Snoozed/Settled/seeded data are rejected. Invented destination routers and mock persistence were rejected because they teach a false product model.
