# Changelog

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
