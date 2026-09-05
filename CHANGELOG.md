# Changelog

## 1.8.0

- Added: "Show tasks in calendar" setting (off by default). When on and Plain Calendar is installed, every task with a `due` date shows up there as a read-only entry - Plain Calendar reads this setting directly, no action needed here beyond turning it on

## 1.7.0

- Changed: Project mode with no project selected no longer shows a "pick a project" hint - it now shows every task grouped by its own resolved project instead (alphabetically, `[[foo]]` and `[[foo|Bar]]` still counted as one project), with a trailing "No project" group for tasks that don't have one. Selecting an actual project from the dropdown still switches to the normal status-grouped, filtered list as before

## 1.6.4

- Added: below ~360px of pane width, the Kanban board switches from horizontally-scrolling columns to full-width columns stacked on top of each other (like a mobile Kanban app), since side-by-side columns stop being usable that narrow no matter how much they shrink

## 1.6.3

- Fixed: the container-query breakpoint from 1.6.2 never actually took effect, because the narrow-width override re-styled `.plain-tasks-view` - the same element that establishes the size container - which browsers restrict. The breakpoint now targets `.plain-tasks-body` and below instead, so the Kanban board's column width, gaps, and padding actually shrink in a narrow pane

## 1.6.2

- Changed: the whole view is now responsive to its own pane width (CSS container queries, not viewport media queries - so a narrow sidebar behaves correctly even in a wide window). Below ~480px the view padding and Kanban column width shrink automatically
- Fixed: long task titles now actually truncate with an ellipsis in both the list and the Kanban board - the title element was missing `flex: 1; min-width: 0`, so the ellipsis rule never had anything to truncate against and titles just overflowed
- Changed: the Kanban board scroll-snaps one column at a time when scrolling/swiping in a narrow pane or on touch, instead of scrolling freely between column boundaries

## 1.6.1

- Fixed: a task note with a purely numeric `title` (e.g. `title: 123`, parsed by YAML as a number rather than a string) crashed the entire view render (`localeCompare is not a function` while sorting), leaving every view mode silently blank with no visible way to create a task either. Titles are now always coerced to a string
- Added: a render failure now shows a Notice instead of silently leaving a blank view, so a future bug like this is diagnosable without devtools access

## 1.6.0

- Added: statuses are now fully configurable in settings - a reorderable list of status IDs, each with a "done" toggle (exactly one is active at a time). The default (`open`, `in-progress`, `blocked`, `done`, with `done` marked as done) matches the old hard-coded set exactly, so existing task notes keep working unchanged without any migration
- Changed: the "All" view mode is now a Kanban board - one column per configured status, in configured order. Drag a card to another column to change its status, or use the right-click menu's new "Change status to…" section as a fallback (a flat list of items rather than a real submenu - see Roadmap for why)
- Changed: Today and Project view modes are still plain lists, but their sections are now the configured statuses (in configured order) instead of the old fixed Overdue/Open/In Progress/Blocked/Done grouping
- Changed: "Overdue" is no longer its own group/column - it's a red accent on the row/card itself (border + red due-date chip), shown regardless of which status section/column the task is actually in, still computed against the real, actual today
- Changed: checking a task's checkbox now toggles between the configured "done" status and the first configured status, instead of hard-coded `open`/`done`; new tasks default to the first configured status
- A task whose `status` doesn't match any configured status (e.g. after renaming/deleting one in settings) is shown under the first configured status without touching the note - only an actual status change rewrites it
- Dragging (or "Change status to…") a not-yet-materialized recurring occurrence to the "done" status completes just that occurrence, same as the checkbox always did; dragging it to any other status changes the whole series' status instead (the master note itself), not just that occurrence - deliberately simple, no new per-occurrence materialization concept for non-done statuses

## 1.5.0

- Changed: removed the "+ New task" toolbar button and the view title above it - creating a task is now done by right-clicking empty space in the list (a context menu with "New task"), matching Plain Calendar's create-from-context approach. The mode-bar (day nav / view switcher) is now the top row of the view

## 1.4.1

- Fixed: navigating to a day other than today in Today mode now actually changes which tasks are shown. Browsing away from the real today switches to an exact-date view (tasks due or scheduled exactly on that day, recurring series only shown when their pattern lands on that day) instead of silently reusing the same rolling backlog every day. Viewing the real today keeps the original behaviour (overdue-or-due-today, plus anything scheduled today) unchanged

## 1.4.0

- Changed: Today mode is now a navigable day instead of a hard-coded "today" - a day-navigation pill (`‹` / Today / `›`) with the selected day's title appears on the left of the mode bar whenever Today mode is active, matching Plain Calendar's toolbar. Tasks due on-or-before, or scheduled for, the selected day are shown; the fixed Overdue/Open/In Progress/Blocked/Done grouping stays relative to the real today, only the pre-filter moves with the selected day. The selected day is transient and resets to the real today on reopen, not persisted in settings
- Changed: the All/Today/Project mode switcher is now styled as a round pill (matching Plain Calendar's segmented control) instead of a square bordered button group

## 1.3.0

- Added: if a task's `project` value doesn't resolve to an existing `type: project` note, saving the task (create or edit, any recurrence scope) always creates one automatically - no confirmation prompt - and rewrites `project` to a clean wikilink to it
  - New note's title comes from the typed value (wikilink alias, else target, else the free text), filename is a kebab-case slug (with a numeric suffix on collision), and frontmatter/body follow the vault's project note template, honestly marked as auto-created and not yet filled in, with a reference back to the task
  - Values that already resolve to a `type: project` note are left as-is
  - Added setting: **Folder for auto-created project notes** (default `projects`) - only decides where new notes are written, detection of existing project notes stays frontmatter-based
- Changed: the project field's hint under the create/edit dialog now previews this ("a new project will be created on save") instead of reading as a save-blocking warning

## 1.2.0

- Added: `project` values are now resolved to real vault files via Obsidian's link resolution (`[[foo]]` and `[[foo|Bar]]` count as the same project), instead of being compared as raw text
- The Project view mode's dropdown deduplicates by resolved file and labels entries with the project note's `title` frontmatter (falling back to the filename); values that don't resolve are still listed and filterable, marked "(not found)"
- Clicking a task's project chip now switches straight into Project mode with that project pre-selected
- Added: native autocomplete (`<datalist>`) for the project field in the create/edit dialog, populated from every note with frontmatter `type: project` - not tied to any specific folder
- Added: a non-blocking hint under the project field when the typed value doesn't resolve to an existing `type: project` note - the task still saves as typed
- Added: **Plain Tasks: Show tasks for this note** command - opens/focuses the task list, switches to Project mode, and filters to the currently active note, even before any task references it

## 1.1.0

- Added: Today and Project view modes for the task list, alongside the existing "All" view - a segmented control switches between them, and Project mode adds a dropdown of the distinct `project` values in the current task set
- The fixed Overdue/Open/In Progress/Blocked/Done grouping is unchanged in every mode; the mode only pre-filters which rows are shown before grouping
- The selected view mode and project selection are persisted in plugin settings and restored when the view is reopened

## 1.0.0

Initial release.

- Fixed grouping: Overdue, Open, In Progress, Blocked, Done
- Tasks stored as plain notes with frontmatter
- Create, edit, and delete tasks from the list (click, right-click, checkbox)
- Recurring tasks anchored on `due` (daily/weekly/monthly/yearly, with optional interval, end date, or occurrence count), with Outlook-style single-occurrence exceptions
- Checking off a recurring task's row always completes just that occurrence, never asks a scope question
- Follows Obsidian's theme and language setting (German/English UI)
