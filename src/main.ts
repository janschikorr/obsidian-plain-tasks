import {
	App,
	ItemView,
	Menu,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	WorkspaceLeaf,
	moment,
	normalizePath,
} from "obsidian";

const VIEW_TYPE_TASKS = "plain-tasks-view";

// Which subset of rows the list view shows before applying the fixed
// Overdue/Open/In Progress/Blocked/Done grouping. "all" is the original,
// unfiltered behaviour; "today" and "project" narrow the row set down.
type TaskViewMode = "all" | "today" | "project";

interface TaskSettings {
	tasksFolder: string;
	taskTag: string;
	viewMode: TaskViewMode;
	viewProject: string;
	// Where auto-created project notes are written (see
	// TaskListView.resolveOrCreateProject). Deliberately separate from
	// project *detection*, which stays frontmatter-based (`type: project`,
	// no hard-coded folder) - see getAllProjectFiles.
	projectsFolder: string;
}

const DEFAULT_SETTINGS: TaskSettings = {
	tasksFolder: "Tasks",
	taskTag: "task",
	viewMode: "all",
	viewProject: "",
	projectsFolder: "projects",
};

type TaskStatus = "open" | "in-progress" | "blocked" | "done";
type TaskPriority = "low" | "normal" | "high";

type TaskGroup = "overdue" | "open" | "in-progress" | "blocked" | "done";

interface Task {
	file: TFile;
	title: string;
	status: TaskStatus;
	priority: TaskPriority;
	scheduled?: string; // YYYY-MM-DD
	due?: string; // YYYY-MM-DD, the first/defining occurrence for recurring tasks
	project?: string;
	recurrence?: string; // RRULE-lite, e.g. "FREQ=WEEKLY;INTERVAL=2" - anchored on `due`
	excludedDates?: string[]; // master only: deleted occurrences (like ICS EXDATE)
	seriesPath?: string; // exception only: vault path of the master note this replaces a slot in
	replacesDate?: string; // exception only: the pattern date (YYYY-MM-DD) this note stands in for
}

// Frontmatter of a task note as it comes out of the metadata cache. Field
// names mirror the actual YAML keys - this is the vault's data schema, see
// regeln/vorlagen/aufgabe.md. Do not rename these without a migration: they
// are read/written verbatim against notes that already exist.
interface TaskFrontmatter {
	title?: string;
	tags?: string | string[];
	status?: string;
	priority?: string;
	scheduled?: string;
	due?: string;
	project?: string;
	recurrence?: string;
	excluded?: string[] | string;
	series?: string;
	replaces?: string;
}

function normalizeStatus(raw?: string): TaskStatus {
	const v = String(raw ?? "").toLowerCase();
	if (v === "in-progress" || v === "in_progress" || v === "inprogress") return "in-progress";
	if (v === "blocked") return "blocked";
	if (v === "done") return "done";
	return "open";
}

function normalizePriority(raw?: string): TaskPriority {
	const v = String(raw ?? "").toLowerCase();
	if (v === "high") return "high";
	if (v === "low") return "low";
	return "normal";
}

function parseTask(file: TFile, fm: TaskFrontmatter, requiredTag: string): Task | null {
	const tags = Array.isArray(fm.tags) ? fm.tags : fm.tags ? [fm.tags] : [];
	if (requiredTag && !tags.includes(requiredTag)) return null;

	const excludedDates = Array.isArray(fm.excluded)
		? fm.excluded.map(String)
		: fm.excluded
		? [String(fm.excluded)]
		: undefined;

	const due = fm.due ? String(fm.due).slice(0, 10) : undefined;
	// Recurrence is only meaningful anchored on `due` - if `due` is missing
	// (e.g. hand-edited note), drop a stray `recurrence` field rather than
	// crashing on it later.
	const recurrence = fm.recurrence && due ? String(fm.recurrence) : undefined;

	return {
		file,
		title: fm.title || file.basename,
		status: normalizeStatus(fm.status),
		priority: normalizePriority(fm.priority),
		scheduled: fm.scheduled ? String(fm.scheduled).slice(0, 10) : undefined,
		due,
		project: fm.project ? String(fm.project) : undefined,
		recurrence,
		excludedDates,
		seriesPath: fm.series ? String(fm.series) : undefined,
		replacesDate: fm.replaces ? String(fm.replaces).slice(0, 10) : undefined,
	};
}

// Minimal RRULE-lite subset for recurring tasks: FREQ (required),
// INTERVAL/UNTIL/COUNT (optional). Same syntax as Plain Calendar's
// `recurrence` field, anchored on `due` instead of `date`.
type RecurrenceFreq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

interface RecurrenceRule {
	freq: RecurrenceFreq;
	interval: number;
	until?: string; // YYYY-MM-DD, inclusive
	count?: number;
}

function parseRecurrenceRule(raw: string): RecurrenceRule | null {
	const fields: Record<string, string> = {};
	for (const part of raw.split(";")) {
		const [key, value] = part.split("=");
		if (key && value) fields[key.trim().toUpperCase()] = value.trim();
	}

	const freq = fields.FREQ as RecurrenceFreq;
	if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return null;

	const interval = fields.INTERVAL ? parseInt(fields.INTERVAL, 10) : 1;
	const rule: RecurrenceRule = { freq, interval: interval > 0 ? interval : 1 };

	if (fields.UNTIL) {
		const digits = fields.UNTIL.replace(/T.*$/, "").replace(/-/g, "");
		if (/^\d{8}$/.test(digits)) {
			rule.until = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
		}
	}

	if (fields.COUNT) {
		const count = parseInt(fields.COUNT, 10);
		if (count > 0) rule.count = count;
	}

	return rule;
}

function buildRecurrenceRuleString(rule: RecurrenceRule): string {
	const parts = [`FREQ=${rule.freq}`];
	if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
	if (rule.until) parts.push(`UNTIL=${rule.until}`);
	if (rule.count !== undefined) parts.push(`COUNT=${rule.count}`);
	return parts.join(";");
}

function parseDateKey(key: string): Date {
	const [y, m, d] = key.split("-").map(Number);
	return new Date(y, (m || 1) - 1, d || 1);
}

// Day number relative to the UTC epoch, so differences are exact regardless
// of DST transitions in the local time zone (unlike dividing a raw ms
// difference between two local-midnight Date objects by 86400000).
function dayNumber(d: Date): number {
	return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
}

// Which occurrence of the pattern (0-based) date `d` would be, ignoring
// until/count bounds - null if `d` doesn't land on the pattern at all. Used
// by splitSeriesAt to cap/resume a rule at an exact occurrence without doing
// its own date arithmetic.
function occurrenceIndex(rule: RecurrenceRule, start: Date, d: Date): number | null {
	switch (rule.freq) {
		case "DAILY": {
			const diff = dayNumber(d) - dayNumber(start);
			if (diff % rule.interval !== 0) return null;
			return diff / rule.interval;
		}
		case "WEEKLY": {
			const diff = dayNumber(d) - dayNumber(start);
			const weekSpan = rule.interval * 7;
			if (diff % weekSpan !== 0) return null;
			return diff / weekSpan;
		}
		case "MONTHLY": {
			if (d.getDate() !== start.getDate()) return null;
			const monthDiff = (d.getFullYear() - start.getFullYear()) * 12 + (d.getMonth() - start.getMonth());
			if (monthDiff % rule.interval !== 0) return null;
			return monthDiff / rule.interval;
		}
		case "YEARLY": {
			if (d.getDate() !== start.getDate() || d.getMonth() !== start.getMonth()) return null;
			const yearDiff = d.getFullYear() - start.getFullYear();
			if (yearDiff % rule.interval !== 0) return null;
			return yearDiff / rule.interval;
		}
	}
}

// Inverse of occurrenceIndex: the date of the n-th (0-based) occurrence of
// the pattern starting at `start`.
function occurrenceDateAt(rule: RecurrenceRule, start: Date, index: number): Date {
	switch (rule.freq) {
		case "DAILY":
			return addDays(start, index * rule.interval);
		case "WEEKLY":
			return addDays(start, index * rule.interval * 7);
		case "MONTHLY":
			return addMonths(start, index * rule.interval);
		case "YEARLY":
			return addYears(start, index * rule.interval);
	}
}

// Safety cap on how many occurrences nextVisibleOccurrence will scan through
// before giving up - guards against a pathological/corrupted rule (e.g. a
// zero-length loop) hanging the render, without limiting any realistic use.
const MAX_OCCURRENCE_SCAN = 10000;

interface SeriesIndex {
	exceptionsBySeriesDate: Map<string, Map<string, Task>>; // master path -> replacesDate -> exception
	exceptionsBySeries: Map<string, Task[]>; // master path -> all its exceptions
	mastersByPath: Map<string, Task>;
}

function buildSeriesIndex(tasks: Task[]): SeriesIndex {
	const exceptionsBySeriesDate = new Map<string, Map<string, Task>>();
	const exceptionsBySeries = new Map<string, Task[]>();
	const mastersByPath = new Map<string, Task>();

	for (const task of tasks) {
		if (task.recurrence) mastersByPath.set(task.file.path, task);
		if (task.seriesPath && task.replacesDate) {
			if (!exceptionsBySeriesDate.has(task.seriesPath)) exceptionsBySeriesDate.set(task.seriesPath, new Map());
			exceptionsBySeriesDate.get(task.seriesPath)!.set(task.replacesDate, task);
			if (!exceptionsBySeries.has(task.seriesPath)) exceptionsBySeries.set(task.seriesPath, []);
			exceptionsBySeries.get(task.seriesPath)!.push(task);
		}
	}

	return { exceptionsBySeriesDate, exceptionsBySeries, mastersByPath };
}

// Reduces a recurring master to the single occurrence that should be shown
// in the list: the earliest occurrence (by pattern order, so it may already
// be overdue) that isn't excluded and doesn't already have a `done`
// exception. If that occurrence has a non-done exception (a single-occurrence
// edit), the exception's own fields are used for display instead of the
// master's. Returns null once the rule is exhausted (until/count) without
// finding any open occurrence.
function nextVisibleOccurrence(master: Task, index: SeriesIndex, todayKey: string): { date: string; exception?: Task } | null {
	const rule = parseRecurrenceRule(master.recurrence ?? "");
	if (!rule || !master.due) return null;
	const start = parseDateKey(master.due);
	const exceptionsByDate = index.exceptionsBySeriesDate.get(master.file.path);

	for (let idx = 0; idx < MAX_OCCURRENCE_SCAN; idx++) {
		if (rule.count !== undefined && idx >= rule.count) return null;
		const key = toDateKey(occurrenceDateAt(rule, start, idx));
		if (rule.until && key > rule.until) return null;
		if (master.excludedDates?.includes(key)) continue;
		const exception = exceptionsByDate?.get(key);
		if (exception?.status === "done") continue;
		return { date: key, exception };
	}
	return null;
}

// One row in the task list: either a standalone task, a materialized
// exception note, or an occurrence generated by a master's pattern. `master`
// is the series' master task for "exception"/"master" kinds, so edit/delete
// handlers can act on the series regardless of which row was clicked.
interface TaskRow {
	display: Task;
	effectiveDue?: string;
	kind: "single" | "master" | "exception";
	master?: Task;
}

// Whether a recurring master's pattern lands exactly on `dateKey` - used by
// buildTaskRowsForDay (the navigable day view), as opposed to
// nextVisibleOccurrence which ignores the calendar date entirely and always
// resolves to the single earliest still-open occurrence (used by the "all"/
// "project" views and by the real-today case of the day view, see render()).
function occurrenceOnDate(master: Task, index: SeriesIndex, dateKey: string): { date: string; exception?: Task } | null {
	const rule = parseRecurrenceRule(master.recurrence ?? "");
	if (!rule || !master.due) return null;
	const start = parseDateKey(master.due);
	const d = parseDateKey(dateKey);
	if (dayNumber(d) < dayNumber(start)) return null;
	if (rule.until && dateKey > rule.until) return null;

	const idx = occurrenceIndex(rule, start, d);
	if (idx === null) return null;
	if (rule.count !== undefined && idx >= rule.count) return null;
	if (master.excludedDates?.includes(dateKey)) return null;

	const exception = index.exceptionsBySeriesDate.get(master.file.path)?.get(dateKey);
	return { date: dateKey, exception };
}

// Row set for the navigable day view when browsing away from the real
// today: unlike buildTaskRows (which always collapses a series to its single
// next open occurrence, regardless of any date), this only includes a
// series' occurrence when the pattern actually lands on `dateKey`, and only
// includes standalone tasks/exceptions that are due or scheduled exactly on
// that date - so the list genuinely changes as you navigate, instead of
// showing the same rolling backlog on every day.
function buildTaskRowsForDay(tasks: Task[], index: SeriesIndex, dateKey: string): TaskRow[] {
	const rows: TaskRow[] = [];
	const usedExceptionPaths = new Set<string>();

	for (const master of index.mastersByPath.values()) {
		const occ = occurrenceOnDate(master, index, dateKey);
		if (!occ) continue;
		if (occ.exception) {
			rows.push({ display: occ.exception, effectiveDue: occ.date, kind: "exception", master });
			usedExceptionPaths.add(occ.exception.file.path);
		} else {
			rows.push({ display: { ...master, due: occ.date }, effectiveDue: occ.date, kind: "master", master });
		}
	}

	for (const task of tasks) {
		if (task.recurrence) continue; // handled via mastersByPath above
		if (task.seriesPath) {
			if (usedExceptionPaths.has(task.file.path)) continue;
			const effectiveDue = task.due ?? task.replacesDate;
			if (effectiveDue === dateKey) {
				rows.push({
					display: task,
					effectiveDue,
					kind: "exception",
					master: index.mastersByPath.get(task.seriesPath),
				});
			}
			continue;
		}
		if (task.due === dateKey || task.scheduled === dateKey) {
			rows.push({ display: task, effectiveDue: task.due, kind: "single" });
		}
	}

	return rows;
}

function buildTaskRows(tasks: Task[], index: SeriesIndex, todayKey: string): TaskRow[] {
	const rows: TaskRow[] = [];
	const usedExceptionPaths = new Set<string>();

	for (const master of index.mastersByPath.values()) {
		const next = nextVisibleOccurrence(master, index, todayKey);
		if (!next) continue;
		if (next.exception) {
			rows.push({ display: next.exception, effectiveDue: next.date, kind: "exception", master });
			usedExceptionPaths.add(next.exception.file.path);
		} else {
			rows.push({ display: { ...master, due: next.date }, effectiveDue: next.date, kind: "master", master });
		}
	}

	for (const task of tasks) {
		if (task.recurrence) continue; // handled via mastersByPath above
		if (task.seriesPath) {
			if (usedExceptionPaths.has(task.file.path)) continue; // already shown as the master's next occurrence
			rows.push({
				display: task,
				effectiveDue: task.due ?? task.replacesDate,
				kind: "exception",
				master: index.mastersByPath.get(task.seriesPath),
			});
			continue;
		}
		rows.push({ display: task, effectiveDue: task.due, kind: "single" });
	}

	return rows;
}

// `project` is a free-text field that may contain a wikilink (e.g.
// "[[Projects/Foo|Foo Bar]]"). For display of a value that failed to resolve
// to a real file we want the readable target text, not the raw markup or the
// alias - anything that isn't a bare wikilink (plain free text) is shown as-is.
function projectDisplayText(raw: string): string {
	const match = raw.match(/^\[\[(.+)\]\]$/);
	if (!match) return raw;
	const inner = match[1];
	const pipeIdx = inner.indexOf("|");
	return pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner;
}

// Frontmatter of a project note as it comes out of the metadata cache - only
// the fields Plain Tasks actually reads (see rules/templates/project.md in
// the vault for the full schema, which this plugin doesn't own).
interface ProjectFrontmatter {
	title?: string;
	type?: string;
}

// Resolves a `project` frontmatter value (a wikilink like "[[ziel]]" or
// "[[ziel|Alias]]", or plain free text as a fallback) to a real vault file via
// Obsidian's own link resolution, so two different-looking links to the same
// note are recognised as the same project. Returns null if nothing resolves
// (typo, deleted note, or genuinely free-text project name).
function resolveProjectFile(app: App, raw: string | undefined, sourcePath: string): TFile | null {
	if (!raw) return null;
	const match = raw.match(/^\[\[([^\]|]+)(\|[^\]]+)?\]\]$/);
	const linktext = match ? match[1] : raw;
	return app.metadataCache.getFirstLinkpathDest(linktext, sourcePath);
}

// Whether a resolved file is itself a project note (frontmatter `type:
// project`) - a link can resolve to *some* file without that file being a
// project (e.g. a stray link to an unrelated note).
function isProjectFile(app: App, file: TFile): boolean {
	const fm = app.metadataCache.getFileCache(file)?.frontmatter as ProjectFrontmatter | undefined;
	return fm?.type === "project";
}

// Display text for a resolved project file: its frontmatter `title` if set,
// otherwise the filename without extension.
function projectDisplayForFile(app: App, file: TFile): string {
	const fm = app.metadataCache.getFileCache(file)?.frontmatter as ProjectFrontmatter | undefined;
	return fm?.title ? String(fm.title) : file.basename;
}

// Every markdown file in the vault whose frontmatter marks it as `type:
// project` - deliberately not scoped to any hard-coded folder (that folder
// has already been renamed once), only the frontmatter field decides.
function getAllProjectFiles(app: App): TFile[] {
	return app.vault.getMarkdownFiles().filter((file) => isProjectFile(app, file));
}

// Human-readable title implied by a `project` field's raw text, used both to
// name an auto-created project note and to preview that name in the
// create/edit dialog's hint (see TaskListView.resolveOrCreateProject and
// buildTaskFields). For a wikilink, that's the alias if given, else the
// target; for anything else (plain free text) it's the text itself.
function extractProjectTitle(raw: string): string {
	const match = raw.match(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/);
	if (!match) return raw;
	return match[2] ?? match[1];
}

// Kebab-cases a title into a filename-safe slug for an auto-created project
// note (lowercase, non-alphanumeric runs collapsed to a single "-", trimmed).
// Falls back to "project" if that leaves nothing usable (e.g. a title made
// entirely of punctuation/emoji).
function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "project";
}

// One distinct project among the currently loaded tasks, grouped by the
// *resolved* file (not the raw string) so "[[foo]]" and "[[foo|Bar]]" count as
// the same project. `key` is what's stored in settings.viewProject and
// compared against in filtering: the resolved file's path when resolvable,
// otherwise the raw project text as a string-equality fallback.
interface ProjectOption {
	key: string;
	file: TFile | null;
	display: string;
}

function projectOptionFor(app: App, raw: string, sourcePath: string): ProjectOption {
	const file = resolveProjectFile(app, raw, sourcePath);
	if (file) return { key: file.path, file, display: projectDisplayForFile(app, file) };
	return { key: raw, file: null, display: `${projectDisplayText(raw)} (${t("projectNotFoundSuffix")})` };
}

// Distinct project options across the currently loaded tasks, alphabetically
// sorted by their readable display text.
function distinctProjectOptions(app: App, tasks: Task[]): ProjectOption[] {
	const byKey = new Map<string, ProjectOption>();
	for (const task of tasks) {
		if (!task.project) continue;
		const option = projectOptionFor(app, task.project, task.file.path);
		if (!byKey.has(option.key)) byKey.set(option.key, option);
	}
	return Array.from(byKey.values()).sort((a, b) => a.display.localeCompare(b.display));
}

// Builds a ProjectOption for a `key` that isn't among distinctProjectOptions
// (e.g. the "virtual" project selected via the "show tasks for this note"
// command, before any task references it yet).
function projectOptionForKey(app: App, key: string): ProjectOption {
	const file = app.vault.getAbstractFileByPath(key);
	if (file instanceof TFile) return { key, file, display: projectDisplayForFile(app, file) };
	return { key, file: null, display: `${projectDisplayText(key)} (${t("projectNotFoundSuffix")})` };
}

// Whether `row`'s project matches the selected project filter `key` - via the
// resolved file when the row's project resolves to one, otherwise via exact
// string equality as a fallback for genuinely unresolvable/free-text values.
function rowMatchesProject(app: App, row: TaskRow, key: string): boolean {
	const raw = row.display.project;
	if (!raw) return false;
	const file = resolveProjectFile(app, raw, row.display.file.path);
	return file ? file.path === key : raw === key;
}

// Vorfilter for the "today" view mode: due today-or-earlier (so overdue tasks
// aren't hidden) or scheduled for today. Done rows are the exception - they
// only qualify if they were actually due/scheduled *today* (not merely
// overdue-and-done), so the today view doesn't silently fill up with old
// completed occurrences. Uses the row's effective (recurrence-resolved) due
// date, not the series master's original `due`.
function matchesToday(row: TaskRow, todayKey: string): boolean {
	const due = row.effectiveDue;
	const scheduled = row.display.scheduled;
	if (row.display.status === "done") {
		return due === todayKey || scheduled === todayKey;
	}
	return (due !== undefined && due <= todayKey) || scheduled === todayKey;
}

function groupFor(row: TaskRow, todayKey: string): TaskGroup {
	if (row.display.status === "done") return "done";
	if (row.effectiveDue && row.effectiveDue < todayKey) return "overdue";
	if (row.display.status === "in-progress") return "in-progress";
	if (row.display.status === "blocked") return "blocked";
	return "open";
}

const GROUP_ORDER: TaskGroup[] = ["overdue", "open", "in-progress", "blocked", "done"];

function toDateKey(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

function addDays(d: Date, n: number): Date {
	const copy = new Date(d);
	copy.setDate(copy.getDate() + n);
	return copy;
}

function addMonths(d: Date, n: number): Date {
	const copy = new Date(d);
	copy.setMonth(copy.getMonth() + n);
	return copy;
}

function addYears(d: Date, n: number): Date {
	const copy = new Date(d);
	copy.setFullYear(copy.getFullYear() + n);
	return copy;
}

// Month names come from Obsidian's own moment instance, which is already set
// to the app's language (see currentLang below for the two supported UI
// languages) - matches Plain Calendar's monthNames/shortWeekdayLabel helpers.
function monthNames(): string[] {
	return moment.months();
}

function shortWeekdayLabel(d: Date): string {
	return moment(d).format("dd");
}

// Title shown next to the day-navigation pill in the "today" view mode - same
// format as Plain Calendar's day-mode title.
function titleForDate(d: Date): string {
	return `${shortWeekdayLabel(d)}, ${d.getDate()}. ${monthNames()[d.getMonth()]} ${d.getFullYear()}`;
}

// UI language: German only when Obsidian's moment locale is "de", English
// otherwise (not full i18n, just these two languages). The frontmatter field
// names (title/status/priority/scheduled/due/...) are unaffected by this -
// they're the vault's data schema, not UI text, see regeln/vorlagen/aufgabe.md.
const TRANSLATIONS = {
	de: {
		groupOverdue: "Überfällig",
		groupOpen: "Offen",
		groupInProgress: "In Arbeit",
		groupBlocked: "Blockiert",
		groupDone: "Erledigt",
		newTask: "Neue Aufgabe",
		editTask: "Aufgabe bearbeiten",
		titleLabel: "Titel",
		titlePlaceholder: "Kurzbeschreibung",
		statusLabel: "Status",
		statusOpen: "Offen",
		statusInProgress: "In Arbeit",
		statusBlocked: "Blockiert",
		statusDone: "Erledigt",
		priorityLabel: "Priorität",
		priorityLow: "Niedrig",
		priorityNormal: "Normal",
		priorityHigh: "Hoch",
		scheduledLabel: "Geplant für",
		dueLabel: "Fällig am",
		projectLabel: "Projekt",
		projectPlaceholder: "Freitext, z. B. Projektname",
		recurrenceLabel: "Wiederholung",
		recurrenceNone: "Keine",
		recurrenceDaily: "Täglich",
		recurrenceWeekly: "Wöchentlich",
		recurrenceMonthly: "Monatlich",
		recurrenceYearly: "Jährlich",
		recurrenceIntervalLabel: "Intervall",
		recurrenceIntervalDescPrefix: "z. B. 2 = alle 2",
		recurrenceUnitDaily: "Tage",
		recurrenceUnitWeekly: "Wochen",
		recurrenceUnitMonthly: "Monate",
		recurrenceUnitYearly: "Jahre",
		recurrenceEndLabel: "Endet",
		recurrenceEndNever: "Nie",
		recurrenceEndUntil: "Am Datum",
		recurrenceEndCount: "Nach Anzahl",
		recurrenceUntilLabel: "Enddatum",
		recurrenceCountLabel: "Anzahl Wiederholungen",
		create: "Anlegen",
		save: "Speichern",
		cancel: "Abbrechen",
		select: "Auswählen",
		delete: "Löschen",
		openNote: "Notiz öffnen",
		edit: "Bearbeiten",
		newTaskButton: "+ Neue Aufgabe",
		errorTitleMissing: "Titel fehlt",
		errorScheduledFormat: "Geplant für muss im Format YYYY-MM-DD sein",
		errorDueFormat: "Fällig am muss im Format YYYY-MM-DD sein",
		errorRecurrenceIntervalFormat: "Intervall muss eine Zahl ≥ 1 sein",
		errorRecurrenceUntilFormat: "Enddatum muss im Format YYYY-MM-DD sein",
		errorRecurrenceCountFormat: "Anzahl Wiederholungen muss eine Zahl ≥ 1 sein",
		errorRecurrenceNeedsDue: "Wiederholung braucht ein Fälligkeitsdatum",
		errorCreateFailed: "Aufgabe konnte nicht angelegt werden",
		errorSaveFailed: "Aufgabe konnte nicht gespeichert werden",
		errorDeleteFailed: "Aufgabe konnte nicht gelöscht werden",
		openTasks: "Aufgaben öffnen",
		taskListViewName: "Aufgaben",
		settingsFolderName: "Ordner für Aufgaben-Notizen",
		settingsFolderDesc: "Pfad relativ zum Vault, z. B. Tasks",
		settingsTagName: "Tag für Aufgaben",
		settingsTagDesc: "Frontmatter-Tag, der eine Notiz als Aufgabe kennzeichnet",
		settingsProjectsFolderName: "Ordner für automatisch angelegte Projekt-Notizen",
		settingsProjectsFolderDesc: "Pfad relativ zum Vault, z. B. projects. Betrifft nur neu angelegte Projekt-Notizen, nicht die Erkennung bestehender.",
		scopeQuestionTitle: "Diese Änderung betrifft…",
		scopeThisTask: "Nur diese Aufgabe",
		scopeThisTaskDesc: "Erstellt eine Ausnahme, alle anderen Vorkommen der Serie bleiben unverändert.",
		scopeThisAndFollowing: "Diese und alle folgenden",
		scopeThisAndFollowingDesc: "Teilt die Serie an diesem Datum, frühere Vorkommen bleiben unverändert.",
		scopeSeries: "Die ganze Serie",
		scopeSeriesDesc: "Ändert das Muster für alle Vorkommen der Serie.",
		emptyState: "Keine Aufgaben in diesem Ordner.",
		viewModeAll: "Alle",
		viewModeToday: "Heute",
		viewModeProject: "Projekt",
		todayButton: "Heute",
		projectFilterPlaceholder: "Projekt wählen…",
		projectEmptyState: "Wähle ein Projekt aus, um Aufgaben zu sehen.",
		projectNotFoundSuffix: "nicht gefunden",
		projectWillCreateHint: 'Neues Projekt „{title}" wird beim Speichern angelegt',
		projectCreatedNotice: 'Projekt „{title}" angelegt',
		showTasksForNote: "Plain Tasks: Aufgaben zu dieser Notiz anzeigen",
	},
	en: {
		groupOverdue: "Overdue",
		groupOpen: "Open",
		groupInProgress: "In Progress",
		groupBlocked: "Blocked",
		groupDone: "Done",
		newTask: "New task",
		editTask: "Edit task",
		titleLabel: "Title",
		titlePlaceholder: "Short description",
		statusLabel: "Status",
		statusOpen: "Open",
		statusInProgress: "In progress",
		statusBlocked: "Blocked",
		statusDone: "Done",
		priorityLabel: "Priority",
		priorityLow: "Low",
		priorityNormal: "Normal",
		priorityHigh: "High",
		scheduledLabel: "Scheduled",
		dueLabel: "Due",
		projectLabel: "Project",
		projectPlaceholder: "Free text, e.g. project name",
		recurrenceLabel: "Repeat",
		recurrenceNone: "None",
		recurrenceDaily: "Daily",
		recurrenceWeekly: "Weekly",
		recurrenceMonthly: "Monthly",
		recurrenceYearly: "Yearly",
		recurrenceIntervalLabel: "Interval",
		recurrenceIntervalDescPrefix: "e.g. 2 = every 2",
		recurrenceUnitDaily: "days",
		recurrenceUnitWeekly: "weeks",
		recurrenceUnitMonthly: "months",
		recurrenceUnitYearly: "years",
		recurrenceEndLabel: "Ends",
		recurrenceEndNever: "Never",
		recurrenceEndUntil: "On date",
		recurrenceEndCount: "After a number of times",
		recurrenceUntilLabel: "End date",
		recurrenceCountLabel: "Number of occurrences",
		create: "Create",
		save: "Save",
		cancel: "Cancel",
		select: "Select",
		delete: "Delete",
		openNote: "Open note",
		edit: "Edit",
		newTaskButton: "+ New task",
		errorTitleMissing: "Title is missing",
		errorScheduledFormat: "Scheduled must be in YYYY-MM-DD format",
		errorDueFormat: "Due must be in YYYY-MM-DD format",
		errorRecurrenceIntervalFormat: "Interval must be a number ≥ 1",
		errorRecurrenceUntilFormat: "End date must be in YYYY-MM-DD format",
		errorRecurrenceCountFormat: "Number of occurrences must be a number ≥ 1",
		errorRecurrenceNeedsDue: "Repeat requires a due date",
		errorCreateFailed: "Could not create task",
		errorSaveFailed: "Could not save task",
		errorDeleteFailed: "Could not delete task",
		openTasks: "Open tasks",
		taskListViewName: "Tasks",
		settingsFolderName: "Folder for task notes",
		settingsFolderDesc: "Path relative to the vault, e.g. Tasks",
		settingsTagName: "Tag for tasks",
		settingsTagDesc: "Frontmatter tag that marks a note as a task",
		settingsProjectsFolderName: "Folder for auto-created project notes",
		settingsProjectsFolderDesc: "Path relative to the vault, e.g. projects. Only affects newly created project notes, not detection of existing ones.",
		scopeQuestionTitle: "This change applies to…",
		scopeThisTask: "This task only",
		scopeThisTaskDesc: "Creates an exception; every other occurrence in the series stays unchanged.",
		scopeThisAndFollowing: "This and all following tasks",
		scopeThisAndFollowingDesc: "Splits the series at this date; earlier occurrences stay unchanged.",
		scopeSeries: "The entire series",
		scopeSeriesDesc: "Changes the pattern for every occurrence in the series.",
		emptyState: "No tasks in this folder.",
		viewModeAll: "All",
		viewModeToday: "Today",
		viewModeProject: "Project",
		todayButton: "Today",
		projectFilterPlaceholder: "Choose a project…",
		projectEmptyState: "Select a project to see tasks.",
		projectNotFoundSuffix: "not found",
		projectWillCreateHint: 'A new project "{title}" will be created on save',
		projectCreatedNotice: 'Project "{title}" created',
		showTasksForNote: "Plain Tasks: Show tasks for this note",
	},
} as const;

type TranslationKey = keyof (typeof TRANSLATIONS)["de"];

function currentLang(): "de" | "en" {
	return moment.locale().toLowerCase().startsWith("de") ? "de" : "en";
}

function t(key: TranslationKey): string {
	return TRANSLATIONS[currentLang()][key];
}

// In-memory form state for the create/edit dialogs. English field names are
// fine here - the mapping to frontmatter keys happens explicitly wherever a
// note is read or written (see parseTask and the frontmatter builders below).
type RecurrenceEndType = "never" | "until" | "count";

interface TaskFormValues {
	title: string;
	status: TaskStatus;
	priority: TaskPriority;
	scheduled: string;
	due: string;
	project: string;
	recurrenceFreq: "" | RecurrenceFreq;
	recurrenceInterval: string; // numeric text, e.g. "2" for "every 2 weeks"
	recurrenceEndType: RecurrenceEndType;
	recurrenceUntil: string; // YYYY-MM-DD, only used when recurrenceEndType === "until"
	recurrenceCount: string; // numeric text, only used when recurrenceEndType === "count"
}

// Turns the structured recurrence fields back into the RRULE-lite string
// stored in frontmatter (INTERVAL is omitted when it's just 1, the default).
function combineRecurrence(values: TaskFormValues): string {
	if (!values.recurrenceFreq) return "";
	const parts = [`FREQ=${values.recurrenceFreq}`];

	const interval = parseInt(values.recurrenceInterval, 10);
	if (interval > 1) parts.push(`INTERVAL=${interval}`);

	if (values.recurrenceEndType === "until" && values.recurrenceUntil) {
		parts.push(`UNTIL=${values.recurrenceUntil}`);
	}
	if (values.recurrenceEndType === "count" && values.recurrenceCount) {
		parts.push(`COUNT=${values.recurrenceCount}`);
	}

	return parts.join(";");
}

function validateTaskFormValues(values: TaskFormValues): string | null {
	if (!values.title.trim()) return t("errorTitleMissing");
	if (values.scheduled && !/^\d{4}-\d{2}-\d{2}$/.test(values.scheduled)) return t("errorScheduledFormat");
	if (values.due && !/^\d{4}-\d{2}-\d{2}$/.test(values.due)) return t("errorDueFormat");

	if (values.recurrenceFreq) {
		if (!values.due) return t("errorRecurrenceNeedsDue");
		const interval = parseInt(values.recurrenceInterval, 10);
		if (!(interval >= 1)) return t("errorRecurrenceIntervalFormat");
		if (values.recurrenceEndType === "until" && !/^\d{4}-\d{2}-\d{2}$/.test(values.recurrenceUntil)) {
			return t("errorRecurrenceUntilFormat");
		}
		if (values.recurrenceEndType === "count" && !(parseInt(values.recurrenceCount, 10) >= 1)) {
			return t("errorRecurrenceCountFormat");
		}
	}

	return null;
}

const RECURRENCE_UNIT_KEYS: Record<RecurrenceFreq, TranslationKey> = {
	DAILY: "recurrenceUnitDaily",
	WEEKLY: "recurrenceUnitWeekly",
	MONTHLY: "recurrenceUnitMonthly",
	YEARLY: "recurrenceUnitYearly",
};

// The interval/end-date/end-count fields only make sense once a frequency is
// chosen, and which of them apply depends on the chosen end type - so this
// sub-section is cleared and rebuilt on every relevant change instead of
// being static like the fields above it.
function renderRecurrenceDetails(container: HTMLElement, values: TaskFormValues, rerender: () => void) {
	container.empty();
	if (!values.recurrenceFreq) return;

	new Setting(container)
		.setName(t("recurrenceIntervalLabel"))
		.setDesc(`${t("recurrenceIntervalDescPrefix")} ${t(RECURRENCE_UNIT_KEYS[values.recurrenceFreq])}`)
		.addText((text) => {
			text.inputEl.type = "number";
			text.inputEl.min = "1";
			text.setValue(values.recurrenceInterval).onChange((v) => (values.recurrenceInterval = v.trim()));
		});

	new Setting(container).setName(t("recurrenceEndLabel")).addDropdown((dropdown) => {
		dropdown
			.addOption("never", t("recurrenceEndNever"))
			.addOption("until", t("recurrenceEndUntil"))
			.addOption("count", t("recurrenceEndCount"))
			.setValue(values.recurrenceEndType)
			.onChange((v) => {
				values.recurrenceEndType = v as RecurrenceEndType;
				rerender();
			});
	});

	if (values.recurrenceEndType === "until") {
		new Setting(container).setName(t("recurrenceUntilLabel")).addText((text) => {
			text.inputEl.type = "date";
			text.setValue(values.recurrenceUntil).onChange((v) => (values.recurrenceUntil = v.trim()));
		});
	}

	if (values.recurrenceEndType === "count") {
		new Setting(container).setName(t("recurrenceCountLabel")).addText((text) => {
			text.inputEl.type = "number";
			text.inputEl.min = "1";
			text.setValue(values.recurrenceCount).onChange((v) => (values.recurrenceCount = v.trim()));
		});
	}
}

// Populates a native <datalist> with every project note in the vault
// (frontmatter `type: project`) so the project text field gets browser-native
// autocomplete without a new dependency. Option value is the wikilink to
// insert on selection, option text/label is the readable display name.
function buildProjectDatalist(app: App, contentEl: HTMLElement, datalistId: string) {
	const datalist = contentEl.createEl("datalist", { attr: { id: datalistId } });
	for (const file of getAllProjectFiles(app)) {
		const label = projectDisplayForFile(app, file);
		datalist.createEl("option", { attr: { value: `[[${file.basename}]]`, label }, text: label });
	}
}

function buildTaskFields(
	app: App,
	contentEl: HTMLElement,
	values: TaskFormValues,
	sourcePath: string,
	opts: { showRecurrence?: boolean } = {}
) {
	new Setting(contentEl).setName(t("titleLabel")).addText((text) => {
		text.setValue(values.title).setPlaceholder(t("titlePlaceholder")).onChange((v) => (values.title = v));
		text.inputEl.focus();
	});

	new Setting(contentEl).setName(t("statusLabel")).addDropdown((dropdown) => {
		dropdown
			.addOption("open", t("statusOpen"))
			.addOption("in-progress", t("statusInProgress"))
			.addOption("blocked", t("statusBlocked"))
			.addOption("done", t("statusDone"))
			.setValue(values.status)
			.onChange((v) => (values.status = v as TaskStatus));
	});

	new Setting(contentEl).setName(t("priorityLabel")).addDropdown((dropdown) => {
		dropdown
			.addOption("low", t("priorityLow"))
			.addOption("normal", t("priorityNormal"))
			.addOption("high", t("priorityHigh"))
			.setValue(values.priority)
			.onChange((v) => (values.priority = v as TaskPriority));
	});

	new Setting(contentEl).setName(t("scheduledLabel")).addText((text) => {
		text.inputEl.type = "date";
		text.setValue(values.scheduled).onChange((v) => (values.scheduled = v.trim()));
	});

	new Setting(contentEl).setName(t("dueLabel")).addText((text) => {
		text.inputEl.type = "date";
		text.setValue(values.due).onChange((v) => (values.due = v.trim()));
	});

	const datalistId = `plain-tasks-project-list-${Math.random().toString(36).slice(2)}`;
	new Setting(contentEl).setName(t("projectLabel")).addText((text) => {
		text.setValue(values.project).setPlaceholder(t("projectPlaceholder"));
		text.inputEl.setAttribute("list", datalistId);
		text.onChange((v) => {
			values.project = v.trim();
			updateProjectWarning();
		});
		text.inputEl.addEventListener("blur", () => updateProjectWarning());
	});
	buildProjectDatalist(app, contentEl, datalistId);

	// Info hint, not an error: an unresolved value is never rejected, it just
	// means resolveOrCreateProject will create a matching project note on
	// save (see TaskListView.resolveOrCreateProject) instead of leaving free
	// text in place.
	const projectWarning = contentEl.createDiv({ cls: "plain-tasks-field-warning" });
	const updateProjectWarning = () => {
		projectWarning.empty();
		if (!values.project) {
			projectWarning.removeClass("is-visible");
			return;
		}
		const file = resolveProjectFile(app, values.project, sourcePath);
		if (!file || !isProjectFile(app, file)) {
			const title = extractProjectTitle(values.project);
			projectWarning.setText(t("projectWillCreateHint").replace("{title}", title));
			projectWarning.addClass("is-visible");
		} else {
			projectWarning.removeClass("is-visible");
		}
	};
	updateProjectWarning();

	if (opts.showRecurrence === false) return;

	new Setting(contentEl).setName(t("recurrenceLabel")).addDropdown((dropdown) => {
		dropdown
			.addOption("", t("recurrenceNone"))
			.addOption("DAILY", t("recurrenceDaily"))
			.addOption("WEEKLY", t("recurrenceWeekly"))
			.addOption("MONTHLY", t("recurrenceMonthly"))
			.addOption("YEARLY", t("recurrenceYearly"))
			.setValue(values.recurrenceFreq)
			.onChange((v) => {
				values.recurrenceFreq = v as TaskFormValues["recurrenceFreq"];
				rerenderDetails();
			});
	});

	const recurrenceDetails = contentEl.createDiv();
	const rerenderDetails = () => renderRecurrenceDetails(recurrenceDetails, values, rerenderDetails);
	rerenderDetails();
}

class NewTaskModal extends Modal {
	private values: TaskFormValues;
	private onSubmit: (values: TaskFormValues) => void;

	constructor(app: App, onSubmit: (values: TaskFormValues) => void) {
		super(app);
		this.values = {
			title: "",
			status: "open",
			priority: "normal",
			scheduled: "",
			due: "",
			project: "",
			recurrenceFreq: "",
			recurrenceInterval: "1",
			recurrenceEndType: "never",
			recurrenceUntil: "",
			recurrenceCount: "",
		};
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		this.setTitle(t("newTask"));
		buildTaskFields(this.app, contentEl, this.values, "");

		new Setting(contentEl)
			.addButton((btn) => btn.setButtonText(t("cancel")).onClick(() => this.close()))
			.addButton((btn) =>
				btn
					.setButtonText(t("create"))
					.setCta()
					.onClick(() => {
						const error = validateTaskFormValues(this.values);
						if (error) {
							new Notice(error);
							return;
						}
						this.close();
						this.onSubmit(this.values);
					})
			);
	}

	onClose() {
		this.contentEl.empty();
	}
}

class EditTaskModal extends Modal {
	private values: TaskFormValues;
	private allowRecurrence: boolean;
	private sourcePath: string;
	private onSave: (values: TaskFormValues) => void;
	private onOpenNote: () => void;
	private onDelete: () => void;

	constructor(
		app: App,
		task: Task,
		callbacks: { onSave: (values: TaskFormValues) => void; onOpenNote: () => void; onDelete: () => void },
		allowRecurrence = true
	) {
		super(app);
		const rule = task.recurrence ? parseRecurrenceRule(task.recurrence) : null;
		this.values = {
			title: task.title,
			status: task.status,
			priority: task.priority,
			scheduled: task.scheduled ?? "",
			due: task.due ?? "",
			project: task.project ?? "",
			recurrenceFreq: rule?.freq ?? "",
			recurrenceInterval: String(rule?.interval ?? 1),
			recurrenceEndType: rule?.until ? "until" : rule?.count ? "count" : "never",
			recurrenceUntil: rule?.until ?? "",
			recurrenceCount: rule?.count ? String(rule.count) : "",
		};
		this.allowRecurrence = allowRecurrence;
		this.sourcePath = task.file.path;
		this.onSave = callbacks.onSave;
		this.onOpenNote = callbacks.onOpenNote;
		this.onDelete = callbacks.onDelete;
	}

	onOpen() {
		const { contentEl } = this;
		this.setTitle(t("editTask"));
		buildTaskFields(this.app, contentEl, this.values, this.sourcePath, { showRecurrence: this.allowRecurrence });

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText(t("delete"))
					.setWarning()
					.onClick(() => {
						this.close();
						this.onDelete();
					})
			)
			.addButton((btn) =>
				btn.setButtonText(t("openNote")).onClick(() => {
					this.close();
					this.onOpenNote();
				})
			)
			.addButton((btn) => btn.setButtonText(t("cancel")).onClick(() => this.close()))
			.addButton((btn) =>
				btn
					.setButtonText(t("save"))
					.setCta()
					.onClick(() => {
						const error = validateTaskFormValues(this.values);
						if (error) {
							new Notice(error);
							return;
						}
						this.close();
						this.onSave(this.values);
					})
			);
	}

	onClose() {
		this.contentEl.empty();
	}
}

// Asks which occurrences of a series a change applies to - Outlook's classic
// three-way choice, same as Plain Calendar. Only shown when editing/deleting
// a series row (see TaskListView.isPartOfSeries); standalone tasks skip
// straight to editing/deleting. Never shown for the checkbox itself -
// checking off a series row always means "just this occurrence".
class ScopeChoiceModal extends Modal {
	private onChoose: (scope: "this" | "following" | "series") => void;

	constructor(app: App, onChoose: (scope: "this" | "following" | "series") => void) {
		super(app);
		this.onChoose = onChoose;
	}

	onOpen() {
		const { contentEl } = this;
		this.setTitle(t("scopeQuestionTitle"));

		const choose = (scope: "this" | "following" | "series") => {
			this.close();
			this.onChoose(scope);
		};

		new Setting(contentEl)
			.setName(t("scopeThisTask"))
			.setDesc(t("scopeThisTaskDesc"))
			.addButton((btn) => btn.setButtonText(t("select")).setCta().onClick(() => choose("this")));
		new Setting(contentEl)
			.setName(t("scopeThisAndFollowing"))
			.setDesc(t("scopeThisAndFollowingDesc"))
			.addButton((btn) => btn.setButtonText(t("select")).onClick(() => choose("following")));
		new Setting(contentEl)
			.setName(t("scopeSeries"))
			.setDesc(t("scopeSeriesDesc"))
			.addButton((btn) => btn.setButtonText(t("select")).onClick(() => choose("series")));
	}

	onClose() {
		this.contentEl.empty();
	}
}

class TaskListView extends ItemView {
	plugin: PlainTasksPlugin;
	private tasks: Task[] = [];
	private seriesIndex: SeriesIndex = { exceptionsBySeriesDate: new Map(), exceptionsBySeries: new Map(), mastersByPath: new Map() };
	// Which day the "today" view mode is showing - transient (not persisted in
	// settings), defaults to the real today on every open, same as Plain
	// Calendar's `anchor`. Only affects the "today" mode's pre-filter (see
	// filterRowsForMode/matchesToday); the Overdue/Open/In Progress/Blocked/Done
	// grouping itself always stays relative to the real today.
	private viewDate: string = toDateKey(new Date());

	constructor(leaf: WorkspaceLeaf, plugin: PlainTasksPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE_TASKS;
	}

	getDisplayText() {
		return t("taskListViewName");
	}

	getIcon() {
		return "list-checks";
	}

	async onOpen() {
		this.viewDate = toDateKey(new Date());
		await this.render();
	}

	private navigateDay(dir: 1 | -1) {
		this.viewDate = toDateKey(addDays(parseDateKey(this.viewDate), dir));
		this.render();
	}

	private goToday() {
		this.viewDate = toDateKey(new Date());
		this.render();
	}

	async onClose() {
		this.containerEl.empty();
	}

	private loadTasks(): Task[] {
		const folder = normalizePath(this.plugin.settings.tasksFolder);
		const tag = this.plugin.settings.taskTag;
		const tasks: Task[] = [];

		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!file.path.startsWith(folder + "/") && file.path !== folder) {
				continue;
			}
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as TaskFrontmatter | undefined;
			if (!fm) continue;

			const task = parseTask(file, fm, tag);
			if (task) tasks.push(task);
		}

		return tasks;
	}

	// Creates the target folder if it's missing. Only swallows the harmless
	// case where a second, near-simultaneous call already created it - any
	// other error (e.g. missing write permissions) is rethrown.
	private async ensureFolder(folderPath: string) {
		if (this.app.vault.getAbstractFileByPath(folderPath)) return;
		try {
			await this.app.vault.createFolder(folderPath);
		} catch (err) {
			if (!this.app.vault.getAbstractFileByPath(folderPath)) throw err;
		}
	}

	// The metadata cache is not immediately up to date after
	// vault.create()/processFrontMatter() - reading it right away would miss
	// the new/changed task or show stale data. Wait for the cache's
	// "changed" event for this file (with a timeout as a safety net) before
	// re-rendering.
	private waitForMetadata(file: TFile): Promise<void> {
		return new Promise((resolve) => {
			let settled = false;
			const ref = this.app.metadataCache.on("changed", (changedFile) => {
				if (changedFile.path === file.path && !settled) {
					settled = true;
					this.app.metadataCache.offref(ref);
					resolve();
				}
			});
			setTimeout(() => {
				if (!settled) {
					settled = true;
					this.app.metadataCache.offref(ref);
					resolve();
				}
			}, 1500);
		});
	}

	private safeFileName(title: string, prefix?: string): string {
		const safeName = title.replace(/[\\/:*?"<>|#^[\]]/g, "").trim();
		return prefix ? `${prefix}-${safeName}.md` : `${safeName}.md`;
	}

	private async createNote(fields: {
		title: string;
		status: TaskStatus;
		priority: TaskPriority;
		scheduled?: string;
		due?: string;
		project?: string;
		recurrence?: string;
		excludedDates?: string[];
		seriesPath?: string;
		replacesDate?: string;
	}): Promise<TFile> {
		const folderPath = normalizePath(this.plugin.settings.tasksFolder);
		await this.ensureFolder(folderPath);
		const today = toDateKey(new Date());
		const prefix = fields.due ?? fields.scheduled ?? today;
		const path = normalizePath(`${folderPath}/${this.safeFileName(fields.title, prefix)}`);

		let frontmatter =
			`---\n` +
			`title: ${fields.title}\n` +
			`tags:\n  - ${this.plugin.settings.taskTag}\n` +
			`status: ${fields.status}\n` +
			`priority: ${fields.priority}\n`;
		if (fields.scheduled) frontmatter += `scheduled: ${fields.scheduled}\n`;
		if (fields.due) frontmatter += `due: ${fields.due}\n`;
		if (fields.project) frontmatter += `project: ${fields.project}\n`;
		if (fields.recurrence) frontmatter += `recurrence: ${fields.recurrence}\n`;
		if (fields.excludedDates?.length) {
			frontmatter += `excluded:\n${fields.excludedDates.map((d) => `  - ${d}`).join("\n")}\n`;
		}
		if (fields.seriesPath) frontmatter += `series: ${fields.seriesPath}\n`;
		if (fields.replacesDate) frontmatter += `replaces: ${fields.replacesDate}\n`;
		frontmatter += `dateCreated: ${today}\ndateModified: ${today}\n---\n\n`;
		frontmatter += `## Timeline\n\n- ${today}: Angelegt (Quelle: plain-tasks)\n`;

		const file = await this.app.vault.create(path, frontmatter);
		await this.waitForMetadata(file);
		return file;
	}

	// Resolves a task's `project` field to a real project note, auto-creating
	// one when needed - Plain Tasks never leaves `project` as unresolved free
	// text once a task is saved through the dialog. `taskRef` identifies the
	// task the new note should point back to: `basename` (no extension) for a
	// real wikilink in the note body, `title` for the human-readable mentions.
	//
	// - Empty/undefined `raw` -> undefined (no project set, nothing created).
	// - `raw` already resolves to a `type: project` file -> `raw` unchanged
	//   (existing project, including its alias if any - nothing to do).
	// - Otherwise (nothing resolved, or resolved to a non-project file) -> a
	//   new project note is created under `projectsFolder` and its wikilink is
	//   returned instead.
	//
	// On failure to create the note, the error is logged and surfaced via
	// Notice, and the original `raw` text is returned unchanged so saving the
	// task itself never fails because of this.
	private async resolveOrCreateProject(raw: string, taskRef: { basename: string; title: string }): Promise<string | undefined> {
		if (!raw) return undefined;

		const existing = resolveProjectFile(this.app, raw, "");
		if (existing && isProjectFile(this.app, existing)) return raw;

		const title = extractProjectTitle(raw);
		const baseSlug = slugify(title);
		const folderPath = normalizePath(this.plugin.settings.projectsFolder);

		try {
			await this.ensureFolder(folderPath);

			let slug = baseSlug;
			let suffix = 2;
			while (this.app.vault.getAbstractFileByPath(normalizePath(`${folderPath}/${slug}.md`))) {
				slug = `${baseSlug}-${suffix}`;
				suffix++;
			}

			const today = toDateKey(new Date());
			const content =
				`---\n` +
				`id: project-${slug}\n` +
				`type: project\n` +
				`title: ${title}\n` +
				`status: active\n` +
				`created: ${today}\n` +
				`updated: ${today}\n` +
				`references: []\n` +
				`---\n\n` +
				`## Current State\n` +
				`Automatically created by Plain Tasks from a task reference. Not yet filled in.\n\n` +
				`## Missing Context\n` +
				`Goal, current state, and next steps have not been captured yet.\n\n` +
				`## Sources / References\n` +
				`- Task: [[${taskRef.basename}]] (auto-created by plain-tasks)\n\n` +
				`## Timeline\n` +
				`- ${today}: File automatically created by plain-tasks, referenced from task "${taskRef.title}" (source: plain-tasks)\n`;

			await this.app.vault.create(normalizePath(`${folderPath}/${slug}.md`), content);
			new Notice(t("projectCreatedNotice").replace("{title}", title));
			return `[[${slug}]]`;
		} catch (err) {
			console.error("Plain Tasks:", err);
			new Notice(t("errorCreateFailed"));
			return raw;
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private async updateFrontmatter(file: TFile, mutate: (fm: any) => void, errorMsg: string) {
		try {
			await this.app.fileManager.processFrontMatter(file, mutate);
			await this.waitForMetadata(file);
			this.render();
		} catch (err) {
			console.error("Plain Tasks:", err);
			new Notice(errorMsg);
		}
	}

	private createTask() {
		new NewTaskModal(this.app, async (values) => {
			try {
				// The task note is created first (without `project`) so a possible
				// auto-created project note can link back to a task file that
				// actually exists yet - see resolveOrCreateProject.
				const file = await this.createNote({
					title: values.title,
					status: values.status,
					priority: values.priority,
					scheduled: values.scheduled || undefined,
					due: values.due || undefined,
					recurrence: combineRecurrence(values) || undefined,
				});
				const project = await this.resolveOrCreateProject(values.project, { basename: file.basename, title: values.title });
				if (project) {
					await this.app.fileManager.processFrontMatter(file, (fm) => {
						fm.project = project;
					});
					await this.waitForMetadata(file);
				}
				this.render();
			} catch (err) {
				console.error("Plain Tasks:", err);
				new Notice(t("errorCreateFailed"));
			}
		}).open();
	}

	private async openTask(file: TFile) {
		await this.app.workspace.getLeaf(false).openFile(file);
	}

	private openEditModalFor(
		task: Task,
		opts: { allowRecurrence: boolean; onSave: (values: TaskFormValues) => void; onDelete: () => void }
	) {
		new EditTaskModal(
			this.app,
			task,
			{ onSave: opts.onSave, onOpenNote: () => this.openTask(task.file), onDelete: opts.onDelete },
			opts.allowRecurrence
		).open();
	}

	private isPartOfSeries(row: TaskRow): boolean {
		return row.kind !== "single";
	}

	private editRow(row: TaskRow) {
		if (!this.isPartOfSeries(row)) {
			this.editSingleTask(row.display);
			return;
		}
		new ScopeChoiceModal(this.app, (scope) => {
			if (scope === "this") this.editThisOccurrence(row);
			else if (scope === "following") this.editThisAndFollowing(row);
			else this.editSeries(row);
		}).open();
	}

	private deleteRow(row: TaskRow) {
		if (!this.isPartOfSeries(row)) {
			this.deleteSingleTask(row.display);
			return;
		}
		new ScopeChoiceModal(this.app, (scope) => {
			if (scope === "this") this.deleteThisOccurrence(row);
			else if (scope === "following") this.deleteThisAndFollowing(row);
			else this.deleteSeries(row);
		}).open();
	}

	private editSingleTask(task: Task) {
		this.openEditModalFor(task, {
			allowRecurrence: true,
			onSave: async (values) => {
				const project = await this.resolveOrCreateProject(values.project, { basename: task.file.basename, title: values.title });
				await this.updateFrontmatter(
					task.file,
					(fm) => {
						fm.title = values.title;
						fm.status = values.status;
						fm.priority = values.priority;
						fm.scheduled = values.scheduled || undefined;
						fm.due = values.due || undefined;
						fm.project = project;
						fm.recurrence = combineRecurrence(values) || undefined;
						fm.dateModified = toDateKey(new Date());
					},
					t("errorSaveFailed")
				);
			},
			onDelete: () => this.deleteSingleTask(task),
		});
	}

	private async deleteSingleTask(task: Task) {
		try {
			await this.app.fileManager.trashFile(task.file);
			this.render();
		} catch (err) {
			console.error("Plain Tasks:", err);
			new Notice(t("errorDeleteFailed"));
		}
	}

	// Checking off a series row never asks the scope question - it always
	// means "just this occurrence". For an already-materialized exception,
	// toggle its own status; for a pattern-generated occurrence, create a new
	// exception note with status: done that overrides just this slot.
	private async toggleDone(row: TaskRow) {
		if (!this.isPartOfSeries(row)) {
			const nextStatus: TaskStatus = row.display.status === "done" ? "open" : "done";
			await this.updateFrontmatter(
				row.display.file,
				(fm) => {
					fm.status = nextStatus;
					fm.dateModified = toDateKey(new Date());
				},
				t("errorSaveFailed")
			);
			return;
		}

		if (row.kind === "exception") {
			const nextStatus: TaskStatus = row.display.status === "done" ? "open" : "done";
			await this.updateFrontmatter(
				row.display.file,
				(fm) => {
					fm.status = nextStatus;
					fm.dateModified = toDateKey(new Date());
				},
				t("errorSaveFailed")
			);
			return;
		}

		// kind === "master": materialize a done exception for this occurrence.
		const master = row.master!;
		try {
			await this.createNote({
				title: master.title,
				status: "done",
				priority: master.priority,
				project: master.project,
				due: row.effectiveDue,
				seriesPath: master.file.path,
				replacesDate: row.effectiveDue,
			});
			this.render();
		} catch (err) {
			console.error("Plain Tasks:", err);
			new Notice(t("errorCreateFailed"));
		}
	}

	// "Nur diese Aufgabe": for an already-materialized exception, edit its own
	// note; for a pattern-generated occurrence, create a new exception note
	// that overrides just this slot (see createNote's series/replaces).
	private editThisOccurrence(row: TaskRow) {
		if (row.kind === "exception") {
			this.openEditModalFor(row.display, {
				allowRecurrence: false,
				onSave: async (values) => {
					const project = await this.resolveOrCreateProject(values.project, {
						basename: row.display.file.basename,
						title: values.title,
					});
					await this.updateFrontmatter(
						row.display.file,
						(fm) => {
							fm.title = values.title;
							fm.status = values.status;
							fm.priority = values.priority;
							fm.scheduled = values.scheduled || undefined;
							fm.due = values.due || undefined;
							fm.project = project;
							fm.dateModified = toDateKey(new Date());
						},
						t("errorSaveFailed")
					);
				},
				onDelete: () => this.deleteThisOccurrence(row),
			});
			return;
		}

		const master = row.master!;
		const seed: Task = { ...master, due: row.effectiveDue, recurrence: undefined };
		this.openEditModalFor(seed, {
			allowRecurrence: false,
			onSave: async (values) => {
				try {
					// See createTask: the exception note is created first (without
					// `project`) so an auto-created project note can link back to a
					// task file that actually exists.
					const file = await this.createNote({
						title: values.title,
						status: values.status,
						priority: values.priority,
						scheduled: values.scheduled || undefined,
						due: values.due || undefined,
						seriesPath: master.file.path,
						replacesDate: row.effectiveDue,
					});
					const project = await this.resolveOrCreateProject(values.project, { basename: file.basename, title: values.title });
					if (project) {
						await this.app.fileManager.processFrontMatter(file, (fm) => {
							fm.project = project;
						});
						await this.waitForMetadata(file);
					}
					this.render();
				} catch (err) {
					console.error("Plain Tasks:", err);
					new Notice(t("errorCreateFailed"));
				}
			},
			onDelete: () => this.deleteThisOccurrence(row),
		});
	}

	private async addExclusion(master: Task, date: string) {
		await this.app.fileManager.processFrontMatter(master.file, (fm) => {
			const list: string[] = Array.isArray(fm.excluded) ? fm.excluded : fm.excluded ? [fm.excluded] : [];
			if (!list.includes(date)) list.push(date);
			list.sort();
			fm.excluded = list;
			fm.dateModified = toDateKey(new Date());
		});
		await this.waitForMetadata(master.file);
	}

	// "Nur diese Aufgabe" löschen: an existing exception note is deleted
	// outright, but its replacesDate must still be excluded on the master -
	// otherwise the pattern would regenerate that occurrence right away.
	private async deleteThisOccurrence(row: TaskRow) {
		try {
			if (row.kind === "exception") {
				const master = row.master;
				await this.app.fileManager.trashFile(row.display.file);
				if (master) await this.addExclusion(master, row.display.replacesDate ?? row.effectiveDue ?? "");
			} else if (row.kind === "master" && row.master && row.effectiveDue) {
				await this.addExclusion(row.master, row.effectiveDue);
			}
			this.render();
		} catch (err) {
			console.error("Plain Tasks:", err);
			new Notice(t("errorDeleteFailed"));
		}
	}

	private editSeries(row: TaskRow) {
		const master = row.master;
		if (!master) return;
		this.openEditModalFor(master, {
			allowRecurrence: true,
			onSave: async (values) => {
				const project = await this.resolveOrCreateProject(values.project, { basename: master.file.basename, title: values.title });
				await this.updateFrontmatter(
					master.file,
					(fm) => {
						fm.title = values.title;
						fm.status = values.status;
						fm.priority = values.priority;
						fm.scheduled = values.scheduled || undefined;
						fm.due = values.due || undefined;
						fm.project = project;
						fm.recurrence = combineRecurrence(values) || undefined;
						fm.dateModified = toDateKey(new Date());
					},
					t("errorSaveFailed")
				);
			},
			onDelete: () => this.deleteSeries(row),
		});
	}

	private async deleteSeries(row: TaskRow) {
		const master = row.master;
		if (!master) return;
		try {
			const exceptions = this.seriesIndex.exceptionsBySeries.get(master.file.path) ?? [];
			for (const exc of exceptions) {
				await this.app.fileManager.trashFile(exc.file);
			}
			await this.app.fileManager.trashFile(master.file);
			this.render();
		} catch (err) {
			console.error("Plain Tasks:", err);
			new Notice(t("errorDeleteFailed"));
		}
	}

	// Splits a recurring series at occurrence date `splitDate`: caps the
	// existing master to end just before it (via an exact occurrence count,
	// so no date arithmetic is needed) and creates a new master note starting
	// at `splitDate` that continues the same pattern. Exceptions and excluded
	// dates on/after `splitDate` move to the new master so they stay attached
	// to the right note. Returns null if `splitDate` is the series' first
	// occurrence - there's nothing to split off, the caller should treat that
	// as a whole-series operation instead.
	private async splitSeriesAt(master: Task, splitDate: string): Promise<Task | null> {
		const rule = parseRecurrenceRule(master.recurrence ?? "");
		if (!rule || !master.due) return null;
		const start = parseDateKey(master.due);
		const idx = occurrenceIndex(rule, start, parseDateKey(splitDate));
		if (idx === null || idx <= 0) return null;

		await this.app.fileManager.processFrontMatter(master.file, (fm) => {
			fm.recurrence = buildRecurrenceRuleString({ freq: rule.freq, interval: rule.interval, count: idx });
			fm.excluded = (master.excludedDates ?? []).filter((d) => d < splitDate);
			fm.dateModified = toDateKey(new Date());
		});
		await this.waitForMetadata(master.file);

		const newRule: RecurrenceRule = {
			freq: rule.freq,
			interval: rule.interval,
			until: rule.until,
			count: rule.count !== undefined ? rule.count - idx : undefined,
		};
		const newFile = await this.createNote({
			title: master.title,
			status: master.status,
			priority: master.priority,
			project: master.project,
			due: splitDate,
			recurrence: buildRecurrenceRuleString(newRule),
			excludedDates: (master.excludedDates ?? []).filter((d) => d >= splitDate),
		});

		const exceptions = this.seriesIndex.exceptionsBySeries.get(master.file.path) ?? [];
		for (const exc of exceptions) {
			if ((exc.replacesDate ?? "") >= splitDate) {
				await this.app.fileManager.processFrontMatter(exc.file, (fm) => {
					fm.series = newFile.path;
					fm.dateModified = toDateKey(new Date());
				});
				await this.waitForMetadata(exc.file);
			}
		}

		const fm = this.app.metadataCache.getFileCache(newFile)?.frontmatter as TaskFrontmatter | undefined;
		return fm ? parseTask(newFile, fm, this.plugin.settings.taskTag) : null;
	}

	private async editThisAndFollowing(row: TaskRow) {
		const master = row.master;
		if (!master || !row.effectiveDue) return;
		try {
			const newMaster = await this.splitSeriesAt(master, row.effectiveDue);
			if (!newMaster) {
				this.editSeries(row);
				return;
			}
			this.render();
			this.openEditModalFor(newMaster, {
				allowRecurrence: true,
				onSave: async (values) => {
					const project = await this.resolveOrCreateProject(values.project, {
						basename: newMaster.file.basename,
						title: values.title,
					});
					await this.updateFrontmatter(
						newMaster.file,
						(fm) => {
							fm.title = values.title;
							fm.status = values.status;
							fm.priority = values.priority;
							fm.scheduled = values.scheduled || undefined;
							fm.due = values.due || undefined;
							fm.project = project;
							fm.recurrence = combineRecurrence(values) || undefined;
							fm.dateModified = toDateKey(new Date());
						},
						t("errorSaveFailed")
					);
				},
				onDelete: () =>
					this.deleteSeries({ display: newMaster, effectiveDue: newMaster.due, kind: "master", master: newMaster }),
			});
		} catch (err) {
			console.error("Plain Tasks:", err);
			new Notice(t("errorSaveFailed"));
		}
	}

	private async deleteThisAndFollowing(row: TaskRow) {
		const master = row.master;
		if (!master || !master.due || !row.effectiveDue) return;
		const rule = parseRecurrenceRule(master.recurrence ?? "");
		if (!rule) return;
		const start = parseDateKey(master.due);
		const idx = occurrenceIndex(rule, start, parseDateKey(row.effectiveDue));
		if (idx === null || idx <= 0) {
			await this.deleteSeries(row);
			return;
		}
		try {
			await this.app.fileManager.processFrontMatter(master.file, (fm) => {
				fm.recurrence = buildRecurrenceRuleString({ freq: rule.freq, interval: rule.interval, count: idx });
				fm.excluded = (master.excludedDates ?? []).filter((d) => d < row.effectiveDue!);
				fm.dateModified = toDateKey(new Date());
			});
			await this.waitForMetadata(master.file);

			const exceptions = this.seriesIndex.exceptionsBySeries.get(master.file.path) ?? [];
			for (const exc of exceptions) {
				if ((exc.replacesDate ?? "") >= row.effectiveDue) {
					await this.app.fileManager.trashFile(exc.file);
				}
			}
			this.render();
		} catch (err) {
			console.error("Plain Tasks:", err);
			new Notice(t("errorDeleteFailed"));
		}
	}

	private showRowContextMenu(e: MouseEvent, row: TaskRow) {
		e.preventDefault();
		e.stopPropagation();
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle(t("edit"))
				.setIcon("pencil")
				.onClick(() => this.editRow(row))
		);
		menu.addItem((item) =>
			item
				.setTitle(t("delete"))
				.setIcon("trash")
				.onClick(() => this.deleteRow(row))
		);
		menu.showAtMouseEvent(e);
	}

	// Applies the view mode as a pre-filter on the full row set, before the
	// fixed Overdue/Open/In Progress/Blocked/Done grouping runs. "all" is a
	// no-op; "today"/"project" narrow the rows shown, they never change how
	// the surviving rows are grouped.
	private filterRowsForMode(rows: TaskRow[]): TaskRow[] {
		const mode = this.plugin.settings.viewMode;
		if (mode === "today") return rows.filter((row) => matchesToday(row, this.viewDate));
		if (mode === "project") {
			const project = this.plugin.settings.viewProject;
			if (!project) return [];
			return rows.filter((row) => rowMatchesProject(this.app, row, project));
		}
		return rows;
	}

	private async setViewMode(mode: TaskViewMode) {
		if (this.plugin.settings.viewMode === mode) return;
		this.plugin.settings.viewMode = mode;
		await this.plugin.saveSettings();
		this.render();
	}

	private async setViewProject(project: string) {
		if (this.plugin.settings.viewProject === project) return;
		this.plugin.settings.viewProject = project;
		await this.plugin.saveSettings();
		this.render();
	}

	// Switches straight to project mode with `project` pre-selected in one
	// settings write - used by the project chip and the "show tasks for this
	// note" command, which shouldn't need a detour through the dropdown.
	async selectProject(project: string) {
		this.plugin.settings.viewMode = "project";
		this.plugin.settings.viewProject = project;
		await this.plugin.saveSettings();
		this.render();
	}

	// Day-navigation pill (‹ / today / ›) plus the currently selected day's
	// title - only rendered while the "today" view mode is active, same
	// layout as Plain Calendar's toolbar nav group.
	private renderDayNav(container: HTMLElement) {
		const nav = container.createDiv({ cls: "plain-tasks-nav" });
		const navPill = nav.createDiv({ cls: "plain-tasks-pill" });
		navPill.createEl("button", { text: "‹" }).onclick = () => this.navigateDay(-1);
		navPill.createEl("button", { text: t("todayButton") }).onclick = () => this.goToday();
		navPill.createEl("button", { text: "›" }).onclick = () => this.navigateDay(1);
		nav.createEl("span", { cls: "plain-tasks-nav-title", text: titleForDate(parseDateKey(this.viewDate)) });
	}

	private renderModeBar(container: HTMLElement, options: ProjectOption[]) {
		const bar = container.createDiv({ cls: "plain-tasks-mode-bar" });

		const left = bar.createDiv({ cls: "plain-tasks-mode-bar-left" });
		if (this.plugin.settings.viewMode === "today") this.renderDayNav(left);

		const right = bar.createDiv({ cls: "plain-tasks-mode-bar-right" });
		const switcher = right.createDiv({ cls: "plain-tasks-pill" });

		const modes: { mode: TaskViewMode; label: TranslationKey }[] = [
			{ mode: "all", label: "viewModeAll" },
			{ mode: "today", label: "viewModeToday" },
			{ mode: "project", label: "viewModeProject" },
		];

		for (const { mode, label } of modes) {
			const isActive = this.plugin.settings.viewMode === mode;
			const btn = switcher.createEl("button", {
				text: t(label),
				cls: "plain-tasks-mode-btn" + (isActive ? " is-active" : ""),
			});
			btn.onclick = () => this.setViewMode(mode);
		}

		if (this.plugin.settings.viewMode === "project") {
			const select = right.createEl("select", { cls: "plain-tasks-project-select" });
			select.createEl("option", { text: t("projectFilterPlaceholder"), value: "" });

			const current = this.plugin.settings.viewProject;
			const allOptions =
				current && !options.some((o) => o.key === current)
					? [...options, projectOptionForKey(this.app, current)].sort((a, b) => a.display.localeCompare(b.display))
					: options;

			for (const option of allOptions) {
				select.createEl("option", { text: option.display, value: option.key });
			}
			select.value = allOptions.some((o) => o.key === current) ? current : "";
			select.onchange = () => this.setViewProject(select.value);
		}
	}

	private render() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("plain-tasks-view");

		this.tasks = this.loadTasks();
		this.seriesIndex = buildSeriesIndex(this.tasks);
		const todayKey = toDateKey(new Date());

		// Browsing to a day other than the real today switches to an exact-date
		// row set (buildTaskRowsForDay) so the list actually changes as you
		// navigate; viewing the real today keeps the original rolling
		// backlog/triage behaviour (buildTaskRows + matchesToday) unchanged.
		const rows =
			this.plugin.settings.viewMode === "today" && this.viewDate !== todayKey
				? buildTaskRowsForDay(this.tasks, this.seriesIndex, this.viewDate)
				: this.filterRowsForMode(buildTaskRows(this.tasks, this.seriesIndex, todayKey));

		const toolbar = container.createDiv({ cls: "plain-tasks-toolbar" });
		toolbar.createEl("span", { cls: "plain-tasks-title", text: t("taskListViewName") });
		const newBtn = toolbar.createEl("button", { text: t("newTaskButton"), cls: "plain-tasks-new-btn" });
		newBtn.onclick = () => this.createTask();

		this.renderModeBar(container, distinctProjectOptions(this.app, this.tasks));

		const body = container.createDiv({ cls: "plain-tasks-body" });

		if (rows.length === 0) {
			const emptyText = this.plugin.settings.viewMode === "project" ? t("projectEmptyState") : t("emptyState");
			body.createDiv({ cls: "plain-tasks-empty", text: emptyText });
			return;
		}

		const grouped = new Map<TaskGroup, TaskRow[]>();
		for (const group of GROUP_ORDER) grouped.set(group, []);
		for (const row of rows) grouped.get(groupFor(row, todayKey))!.push(row);

		for (const group of grouped.values()) {
			group.sort((a, b) => {
				const ad = a.effectiveDue ?? "9999-99-99";
				const bd = b.effectiveDue ?? "9999-99-99";
				if (ad !== bd) return ad < bd ? -1 : 1;
				return a.display.title.localeCompare(b.display.title);
			});
		}

		const groupLabelKey: Record<TaskGroup, TranslationKey> = {
			overdue: "groupOverdue",
			open: "groupOpen",
			"in-progress": "groupInProgress",
			blocked: "groupBlocked",
			done: "groupDone",
		};

		for (const group of GROUP_ORDER) {
			const rowsInGroup = grouped.get(group)!;
			if (rowsInGroup.length === 0) continue;

			const section = body.createDiv({ cls: `plain-tasks-group plain-tasks-group-${group}` });
			section.createDiv({ cls: "plain-tasks-group-head", text: `${t(groupLabelKey[group])} (${rowsInGroup.length})` });

			const list = section.createDiv({ cls: "plain-tasks-list" });
			for (const row of rowsInGroup) {
				this.renderRow(list, row);
			}
		}
	}

	// The project chip resolves the row's `project` value to a real file (see
	// resolveProjectFile) to decide its label and click behaviour: clicking it
	// always switches straight into project mode filtered to this project,
	// whether or not it resolved - an unresolved value still works as an
	// exact-text filter, just visually marked as such.
	private renderProjectChip(meta: HTMLElement, project: string, sourcePath: string) {
		const file = resolveProjectFile(this.app, project, sourcePath);
		const key = file ? file.path : project;
		const display = file ? projectDisplayForFile(this.app, file) : `${projectDisplayText(project)} (${t("projectNotFoundSuffix")})`;
		const chip = meta.createSpan({
			cls: "plain-tasks-chip plain-tasks-chip-project" + (file ? "" : " plain-tasks-chip-project-unresolved"),
			text: display,
		});
		chip.onclick = (e) => {
			e.stopPropagation();
			this.selectProject(key);
		};
	}

	private renderRow(parent: HTMLElement, row: TaskRow) {
		const item = parent.createDiv({ cls: `plain-tasks-item plain-tasks-priority-${row.display.priority}` });

		const checkbox = item.createEl("input", { type: "checkbox", cls: "plain-tasks-checkbox" });
		checkbox.checked = row.display.status === "done";
		checkbox.onclick = (e) => {
			e.stopPropagation();
			this.toggleDone(row);
		};

		const main = item.createDiv({ cls: "plain-tasks-item-main" });
		const titleRow = main.createDiv({ cls: "plain-tasks-item-title-row" });
		if (row.kind !== "single") titleRow.createSpan({ cls: "plain-tasks-recurrence-marker", text: "↻" });
		titleRow.createSpan({ cls: "plain-tasks-item-title", text: row.display.title });

		const meta = main.createDiv({ cls: "plain-tasks-item-meta" });
		if (row.effectiveDue) meta.createSpan({ cls: "plain-tasks-chip plain-tasks-chip-date", text: row.effectiveDue });
		if (row.display.project) this.renderProjectChip(meta, row.display.project, row.display.file.path);

		item.onclick = () => this.editRow(row);
		item.oncontextmenu = (e) => this.showRowContextMenu(e, row);
	}
}

class TaskSettingTab extends PluginSettingTab {
	plugin: PlainTasksPlugin;

	constructor(app: App, plugin: PlainTasksPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName(t("settingsFolderName"))
			.setDesc(t("settingsFolderDesc"))
			.addText((text) =>
				text.setValue(this.plugin.settings.tasksFolder).onChange(async (value) => {
					this.plugin.settings.tasksFolder = value.trim() || DEFAULT_SETTINGS.tasksFolder;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName(t("settingsTagName"))
			.setDesc(t("settingsTagDesc"))
			.addText((text) =>
				text.setValue(this.plugin.settings.taskTag).onChange(async (value) => {
					this.plugin.settings.taskTag = value.trim() || DEFAULT_SETTINGS.taskTag;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName(t("settingsProjectsFolderName"))
			.setDesc(t("settingsProjectsFolderDesc"))
			.addText((text) =>
				text.setValue(this.plugin.settings.projectsFolder).onChange(async (value) => {
					this.plugin.settings.projectsFolder = value.trim() || DEFAULT_SETTINGS.projectsFolder;
					await this.plugin.saveSettings();
				})
			);
	}
}

export default class PlainTasksPlugin extends Plugin {
	settings: TaskSettings;

	async onload() {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_TASKS, (leaf) => new TaskListView(leaf, this));

		this.addRibbonIcon("list-checks", t("openTasks"), () => this.activateView());

		this.addCommand({
			id: "open-tasks",
			name: t("openTasks"),
			callback: () => this.activateView(),
		});

		// Deliberately available for any markdown file, not just `type:
		// project` notes or a specific folder - a note can be a valid task
		// filter target even before any task references it yet (see
		// TaskListView.selectProject / the ProjectOption "virtual entry"
		// handling in renderModeBar).
		this.addCommand({
			id: "show-tasks-for-note",
			name: t("showTasksForNote"),
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) {
					this.activateView().then((view) => view.selectProject(file.path));
				}
				return true;
			},
		});

		this.addSettingTab(new TaskSettingTab(this.app, this));
	}

	onunload() {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_TASKS);
	}

	async activateView(): Promise<TaskListView> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_TASKS)[0];
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: VIEW_TYPE_TASKS, active: true });
		}
		workspace.revealLeaf(leaf);
		return leaf.view as TaskListView;
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
