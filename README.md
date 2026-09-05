# ✅ Plain Tasks

![CI](https://github.com/janschikorr/obsidian-plain-tasks/actions/workflows/ci.yml/badge.svg)
![Latest release](https://img.shields.io/github/v/release/janschikorr/obsidian-plain-tasks?sort=semver&label=release)
![License](https://img.shields.io/github/license/janschikorr/obsidian-plain-tasks)

A minimal task list for Obsidian. One fixed grouping — Overdue, Open, In Progress, Blocked, Done — for your own task notes. No databases, no boards, no project-management UI to configure.

## 🤔 Why

Existing task plugins tend to come with their own query language, kanban boards, or a whole project/database layer bolted on. Plain Tasks does one thing: show and manage tasks that live as plain notes in your vault, sister plugin to [Plain Calendar](https://github.com/janschikorr/obsidian-plain-calendar).

## ✨ Features

- 📋 **One fixed grouping** — Overdue, Open, In Progress, Blocked, Done, always in that order
- 🔀 **All / Today / Project view modes** — a switcher above the list narrows down which rows are shown before they're grouped; the grouping itself never changes
- 🔗 **Real project links** — `project` resolves to actual vault files (via Obsidian's link resolution), with autocomplete against notes tagged `type: project` and a not-blocking hint when a value doesn't resolve; click a project chip to jump straight into that project's filtered view
- 📄 **Tasks are notes** — every task is a regular markdown file with frontmatter, so it's just as searchable, linkable, and versionable as the rest of your vault
- ☑️ **Checkbox in the list** — check off a task right from the list, no need to open the note
- 🔁 **Recurring tasks** — daily/weekly/monthly/yearly, anchored on the **due** date, with an optional interval, end date, or occurrence count
- ➡️ Checking off a recurring task's row always completes just that one occurrence — never a "which occurrences?" prompt, that's only asked when editing or deleting a series row
- 🌗 Follows Obsidian's theme (light/dark, accent color) and language setting (German/English UI; more languages can be added easily)

## 📦 Installation

Plain Tasks is intentionally small and not in Obsidian's community plugin store, so it's installed either through BRAT or by hand.

> **Requirements:** Obsidian 1.12.0 or newer.

### 🚀 Via BRAT (recommended)

BRAT auto-updates the plugin whenever a new release comes out, so you don't have to repeat the manual steps below.

1. Open **Settings → Community plugins → Browse**, search for **BRAT** (*Obsidian42 - BRAT*), install it, and enable it.
2. Open the command palette (`Ctrl/Cmd + P`) and run **BRAT: Add a beta plugin for testing**.
3. Paste the repository `janschikorr/obsidian-plain-tasks` (or the full URL `https://github.com/janschikorr/obsidian-plain-tasks`) and confirm.
4. Go to **Settings → Community plugins** and enable **Plain Tasks**.

### 🛠️ Manual

Use this if you don't want BRAT installed, or want to pin a specific version.

1. Open the [releases page](https://github.com/janschikorr/obsidian-plain-tasks/releases) and download `main.js`, `manifest.json`, and `styles.css` from the release you want (usually [the latest](https://github.com/janschikorr/obsidian-plain-tasks/releases/latest)).
2. In your vault, create the folder `.obsidian/plugins/plain-tasks/` if it doesn't exist yet, and copy the three files into it.
3. Reload Obsidian (or **Settings → Community plugins → reload**) so it picks up the new plugin folder.
4. Go to **Settings → Community plugins** and enable **Plain Tasks**.

Updating later means repeating all four steps with the new release's files.

## 🖱️ Usage

Open the task list via the ribbon icon or the **Open tasks** command.

- ☑️ Click the checkbox → complete (or reopen) a task
- ✏️ Click a task row → edit it; right-click it → edit/delete
- ➕ **New task** button in the toolbar → create a task

### 🔀 View modes

A segmented control above the list switches between three view modes. In every mode, the fixed Overdue/Open/In Progress/Blocked/Done grouping stays exactly as-is — the mode only decides which rows make it into that grouping in the first place:

- **All** — every task, the original unfiltered behaviour
- **Today** — only tasks due today-or-earlier (so overdue tasks stay visible) or scheduled for today; a `done` task only shows up here if it was actually due/scheduled today, not just any overdue-and-done task
- **Project** — a dropdown next to the switcher lists every distinct project among the currently loaded tasks, resolved to real vault files via Obsidian's own link resolution (so `[[foo]]` and `[[foo|Bar]]` count as the same project) and labelled with the project note's `title` frontmatter, or its filename if that's missing. Values that don't resolve to a file are still listed, marked "(not found)", and matched by exact text. With no project selected (or none existing yet), the list shows a hint instead of an error

The chosen mode and project selection are remembered in the plugin's settings and restored the next time the view opens.

Clicking a task's project chip switches straight into Project mode with that project pre-selected - no need to go through the dropdown.

### 🔗 Jump from a note to its tasks

Run **Plain Tasks: Show tasks for this note** (command palette) while any markdown note is open: it opens/focuses the task list, switches to Project mode, and selects the active note as the project filter - even if no task points at it yet, in which case you'll see the "no tasks" hint.

## 📝 Task notes

Each task is stored as a note with this frontmatter:

```yaml
---
title: <title>
tags:
  - task
status: open           # open | in-progress | blocked | done
priority: normal        # low | normal | high
scheduled: <YYYY-MM-DD>  # optional
due: <YYYY-MM-DD>        # optional
project: <text>          # optional, usually a wikilink like [[project-note]], see below
recurrence: <FREQ=...>   # optional, only valid together with `due`, see below
---
```

### 🔗 Project field

`project` is stored as a raw wikilink string (e.g. `[[job-applications]]` or `[[job-applications|Bewerbungen]]`), exactly like a normal Obsidian link - it's not migrated or rewritten by the plugin. In the create/edit dialog, the project field offers native autocomplete against every note in the vault with frontmatter `type: project` (folder location doesn't matter); picking a suggestion inserts `[[<filename>]]`. If what you typed doesn't resolve to an existing `type: project` note, a small hint appears under the field - the task is still saved as typed, nothing is blocked.

### 🔁 Recurring tasks

In the create/edit dialog, **Repeat** is a dropdown (None/Daily/Weekly/Monthly/Yearly), only available once a **due** date is set — recurrence is always anchored on `due`. Pick anything but None and two more controls appear: an **Interval** ("every N days/weeks/months/years") and an **Ends** dropdown (Never / on a date / after a number of occurrences).

Under the hood this is stored in `recurrence` as an RRULE-lite string (same syntax as Plain Calendar's `recurrence` field):

- `FREQ=DAILY|WEEKLY|MONTHLY|YEARLY` (required)
- `INTERVAL=<n>` — every n-th unit (default 1)
- `UNTIL=<YYYY-MM-DD>` — last occurrence (inclusive)
- `COUNT=<n>` — total number of occurrences

`due` is the first occurrence — the note with a `recurrence` field is the series' master note. Unlike Plain Calendar, a recurring task never shows more than one row at a time: the list always collapses a series down to its **next open occurrence** (the earliest one that isn't done yet, which may already be overdue).

- ☑️ **Checking the box** on a series row always completes just that occurrence — a small exception note is created (or, if one already exists for that date, updated) with `status: done`. The series itself keeps going; the row updates to the next occurrence on the next render.
- ✏️➡️🗑️ **Editing or deleting** a series row asks what the change applies to, Outlook's classic three-way choice:
  - 1️⃣ **This task only** — creates (or edits) a separate note for just that one occurrence, without touching the rest of the series. Deleting this way adds the date to the master's `excluded` list instead of leaving a stray file.
  - ➡️ **This and all following** — splits the series at that date: the existing master note ends right before it, a new master note continues the same pattern from there on.
  - 🔗 **The entire series** — edits or deletes the master note itself (deleting also removes every single-occurrence note that overrides it).

## ⚙️ Settings

- 📁 **Folder for task notes** — where task notes are stored (default: `Tasks`)
- 🏷️ **Tag for tasks** — the frontmatter tag that marks a note as a task (default: `task`)

## 🗺️ Roadmap

Known limitations, kept simple on purpose:

- `project` resolves to real vault files and has autocomplete, but it's still a single-value filter, not a real grouping level (no dedicated "group by project" view).
- No free-text search, and no filtering beyond the All/Today/Project view modes.

## 📄 License

[MIT](LICENSE)
