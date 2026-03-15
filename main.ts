import {
	App,
	Editor,
	MarkdownView,
	Notice,
	Plugin,
	TFile,
} from "obsidian";
import { keymap, EditorView } from "@codemirror/view";
import { TodoistAPI } from "./src/api/TodoistAPI";
import { SyncEngine } from "./src/sync/SyncEngine";
import {
	TodoistInlineSettings,
	TodoistInlineSettingTab,
	DEFAULT_SETTINGS,
} from "./src/settings";

// Matches a task line where the tid comment is at the beginning of the content:
// "  - [ ] <!-- tid:xxx --> rest of text"
const TASK_TID_PREFIX_RE = /^(\s*- \[[ xX]\] )(<!-- tid:[a-zA-Z0-9_-]+ --> )/;

function tidEnterHandler(view: EditorView): boolean {
	const { state } = view;
	const sel = state.selection.main;
	if (!sel.empty) return false;
	const line = state.doc.lineAt(sel.from);
	const match = line.text.match(TASK_TID_PREFIX_RE);
	if (!match) return false;
	// Absolute position of the first character after the tid comment
	const tidEnd = line.from + match[1].length + match[2].length;
	if (sel.from < tidEnd) {
		// Cursor is inside the hidden tid — nudge it to after the tid so
		// Enter splits the line at the right place
		view.dispatch({ selection: { anchor: tidEnd } });
	}
	return false; // let Obsidian's default Enter handling proceed
}

const tidProtectionExtension = keymap.of([
	{ key: "Enter", run: tidEnterHandler },
]);

export default class TodoistInlinePlugin extends Plugin {
	settings: TodoistInlineSettings;
	private statusBarItem: HTMLElement | null = null;
	private autoSyncIntervalId: number | null = null;
	private lastSyncTime: Date | null = null;
	private syncing = false;

	async onload() {
		await this.loadSettings();

		// Status bar
		this.statusBarItem = this.addStatusBarItem();
		this.updateStatusBar("Ready");
		this.updateStatusBarVisibility();

		// Commands
		this.addCommand({
			id: "sync-todoist-tasks",
			name: "Sync Todoist tasks (push + pull)",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.syncActiveNote(view.file, editor);
			},
		});

		this.addCommand({
			id: "pull-todoist-tasks",
			name: "Pull Todoist tasks (overwrite from Todoist)",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.pullActiveNote(view.file, editor);
			},
		});

		this.addCommand({
			id: "open-todoist-project-selector",
			name: "Set Todoist project for this note",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.selectProject(view.file, editor);
			},
		});

		// Ribbon icon
		this.addRibbonIcon(
			"refresh-cw",
			"Sync Todoist tasks",
			(evt: MouseEvent) => {
				const view =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (view) {
					this.syncActiveNote(view.file, view.editor);
				} else {
					new Notice("No active Markdown note.");
				}
			}
		);

		// Settings tab
		this.addSettingTab(new TodoistInlineSettingTab(this.app, this));

		// Protect tid comments from being split off their task line
		this.registerEditorExtension(tidProtectionExtension);

		// Start auto-sync if enabled
		this.restartAutoSync();
	}

	onunload() {
		this.stopAutoSync();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// ----- Auto-sync -----

	restartAutoSync() {
		this.stopAutoSync();
		if (!this.settings.autoSync || !this.settings.apiToken) return;

		const intervalMs = this.settings.syncIntervalMinutes * 60 * 1000;
		this.autoSyncIntervalId = window.setInterval(() => {
			const view =
				this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view?.file) {
				this.syncActiveNote(view.file, view.editor, true);
			}
		}, intervalMs);
		this.registerInterval(this.autoSyncIntervalId);
	}

	private stopAutoSync() {
		if (this.autoSyncIntervalId !== null) {
			window.clearInterval(this.autoSyncIntervalId);
			this.autoSyncIntervalId = null;
		}
	}

	// ----- Status bar -----

	updateStatusBarVisibility() {
		if (!this.statusBarItem) return;
		this.statusBarItem.style.display = this.settings.showStatusBar
			? ""
			: "none";
	}

	private updateStatusBar(message: string) {
		if (!this.statusBarItem) return;
		this.statusBarItem.setText(`Todoist: ${message}`);
	}

	// ----- Sync helpers -----

	private getProjectId(file: TFile): string | null {
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache?.frontmatter) return null;
		const val = cache.frontmatter[this.settings.projectIdProperty];
		if (!val) return null;
		return String(val);
	}

	private getApi(): TodoistAPI | null {
		if (!this.settings.apiToken) {
			new Notice(
				"Todoist Inline: No API token configured. Go to Settings → Todoist Inline."
			);
			return null;
		}
		return new TodoistAPI(this.settings.apiToken);
	}

	async syncActiveNote(
		file: TFile | null,
		editor: Editor,
		silent = false
	) {
		if (!file) {
			if (!silent) new Notice("No active file.");
			return;
		}
		const projectId = this.getProjectId(file);
		if (!projectId) {
			if (!silent) {
				new Notice(
					`Todoist Inline: No "${this.settings.projectIdProperty}" property found in frontmatter.`
				);
			}
			return;
		}
		const api = this.getApi();
		if (!api) return;

		if (this.syncing) {
			if (!silent) new Notice("Todoist Inline: Sync already in progress.");
			return;
		}
		this.syncing = true;
		this.updateStatusBar("Syncing…");

		try {
			const engine = new SyncEngine(api);
			const currentContent = editor.getValue();
			const result = await engine.sync(currentContent, projectId);

			if (result.errors.length > 0) {
				new Notice(
					`Todoist Inline: Sync completed with errors:\n${result.errors.join("\n")}`
				);
			} else if (!silent) {
				new Notice(
					`Todoist Inline: Synced — ${result.tasksCreated} created, ${result.tasksClosed} closed, ${result.tasksReopened} reopened, ${result.tasksUpdated} updated.`
				);
			}

			// Update editor content only if changed
			if (result.noteContent !== currentContent) {
				const cursor = editor.getCursor();
				editor.setValue(result.noteContent);
				editor.setCursor(cursor);
			}

			this.lastSyncTime = new Date();
			this.updateStatusBar(
				`Last sync ${this.lastSyncTime.toLocaleTimeString()}`
			);
		} catch (e) {
			new Notice(`Todoist Inline: Sync failed — ${e}`);
			this.updateStatusBar("Sync failed");
		} finally {
			this.syncing = false;
		}
	}

	async pullActiveNote(file: TFile | null, editor: Editor) {
		if (!file) {
			new Notice("No active file.");
			return;
		}
		const projectId = this.getProjectId(file);
		if (!projectId) {
			new Notice(
				`Todoist Inline: No "${this.settings.projectIdProperty}" property found in frontmatter.`
			);
			return;
		}
		const api = this.getApi();
		if (!api) return;

		if (this.syncing) {
			new Notice("Todoist Inline: Sync already in progress.");
			return;
		}
		this.syncing = true;
		this.updateStatusBar("Pulling…");

		try {
			const engine = new SyncEngine(api);
			const currentContent = editor.getValue();
			const newContent = await engine.pull(currentContent, projectId);

			if (newContent !== currentContent) {
				const cursor = editor.getCursor();
				editor.setValue(newContent);
				editor.setCursor(cursor);
			}

			this.lastSyncTime = new Date();
			this.updateStatusBar(
				`Last sync ${this.lastSyncTime.toLocaleTimeString()}`
			);
			new Notice("Todoist Inline: Pulled latest tasks from Todoist.");
		} catch (e) {
			new Notice(`Todoist Inline: Pull failed — ${e}`);
			this.updateStatusBar("Pull failed");
		} finally {
			this.syncing = false;
		}
	}

	async selectProject(file: TFile | null, editor: Editor) {
		if (!file) {
			new Notice("No active file.");
			return;
		}
		const api = this.getApi();
		if (!api) return;

		let projects;
		try {
			projects = await api.getProjects();
		} catch (e) {
			new Notice(`Todoist Inline: Failed to fetch projects — ${e}`);
			return;
		}

		// Build a simple modal-like selector using a Notice + prompt
		// For a full modal, we use the Obsidian SuggestModal
		const { ProjectSuggestModal } = await import(
			"./src/ui/ProjectSuggestModal"
		);
		const modal = new ProjectSuggestModal(this.app, projects, async (project) => {
			await this.setProjectFrontmatter(file, project.id);
			new Notice(
				`Todoist Inline: Linked to project "${project.name}" (${project.id}).`
			);
			// Immediately pull tasks
			await this.pullActiveNote(file, editor);
		});
		modal.open();
	}

	private async setProjectFrontmatter(
		file: TFile,
		projectId: string
	): Promise<void> {
		const content = await this.app.vault.read(file);
		const propKey = this.settings.projectIdProperty;

		// Check if frontmatter exists (starts with ---)
		const fmMatch = content.match(/^---\n([\s\S]*?)\n---(\n|$)/);
		if (fmMatch) {
			const fmBody = fmMatch[1];
			const propRegex = new RegExp(`^${propKey}:.*$`, "m");
			let newFmBody: string;

			if (propRegex.test(fmBody)) {
				newFmBody = fmBody.replace(
					propRegex,
					`${propKey}: "${projectId}"`
				);
			} else {
				newFmBody = `${fmBody}\n${propKey}: "${projectId}"`;
			}

			const newContent = content.replace(
				/^---\n[\s\S]*?\n---(\n|$)/,
				`---\n${newFmBody}\n---$1`
			);
			await this.app.vault.modify(file, newContent);
		} else {
			// No frontmatter — prepend one
			const newContent = `---\n${propKey}: "${projectId}"\n---\n\n${content}`;
			await this.app.vault.modify(file, newContent);
		}
	}
}
