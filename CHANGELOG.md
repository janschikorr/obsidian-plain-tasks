# Changelog

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
