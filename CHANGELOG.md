# Changelog

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
