import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type TodoistInlinePlugin from "../main";
import { TodoistAPI } from "./api/TodoistAPI";

export interface TodoistInlineSettings {
	/** Todoist API token */
	apiToken: string;
	/** Frontmatter property key used to identify the Todoist project */
	projectIdProperty: string;
	/** Enable automatic background sync */
	autoSync: boolean;
	/** Auto-sync interval in minutes */
	syncIntervalMinutes: number;
	/** Show status bar item */
	showStatusBar: boolean;
	/** Confirm before deleting tasks that are removed from the note */
	confirmDelete: boolean;
}

export const DEFAULT_SETTINGS: TodoistInlineSettings = {
	apiToken: "",
	projectIdProperty: "todoist_project_id",
	autoSync: false,
	syncIntervalMinutes: 5,
	showStatusBar: true,
	confirmDelete: true,
};

export class TodoistInlineSettingTab extends PluginSettingTab {
	private plugin: TodoistInlinePlugin;

	constructor(app: App, plugin: TodoistInlinePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Todoist Inline Settings" });

		// --- API Token ---
		new Setting(containerEl)
			.setName("Todoist API token")
			.setDesc(
				"Your Todoist API token. Find it in Todoist → Settings → Integrations → Developer."
			)
			.addText((text) => {
				text
					.setPlaceholder("Enter your API token")
					.setValue(this.plugin.settings.apiToken)
					.onChange(async (value) => {
						this.plugin.settings.apiToken = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
				text.inputEl.style.width = "100%";
			})
			.addButton((btn) => {
				btn.setButtonText("Test").onClick(async () => {
					if (!this.plugin.settings.apiToken) {
						new Notice("Please enter an API token first.");
						return;
					}
					try {
						const api = new TodoistAPI(this.plugin.settings.apiToken);
						const projects = await api.getProjects();
						new Notice(
							`Connected! Found ${projects.length} project(s).`
						);
					} catch (e) {
						new Notice(`Connection failed: ${e}`);
					}
				});
			});

		// --- Project ID property ---
		new Setting(containerEl)
			.setName("Frontmatter property name")
			.setDesc(
				'The YAML frontmatter property that holds the Todoist project ID. Default: "todoist_project_id".'
			)
			.addText((text) =>
				text
					.setPlaceholder("todoist_project_id")
					.setValue(this.plugin.settings.projectIdProperty)
					.onChange(async (value) => {
						this.plugin.settings.projectIdProperty =
							value.trim() || "todoist_project_id";
						await this.plugin.saveSettings();
					})
			);

		// --- Auto-sync ---
		containerEl.createEl("h3", { text: "Sync" });

		new Setting(containerEl)
			.setName("Auto-sync")
			.setDesc(
				"Automatically sync the active note with Todoist on a timer."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoSync)
					.onChange(async (value) => {
						this.plugin.settings.autoSync = value;
						await this.plugin.saveSettings();
						this.plugin.restartAutoSync();
					})
			);

		new Setting(containerEl)
			.setName("Sync interval (minutes)")
			.setDesc("How often to auto-sync. Minimum 1 minute.")
			.addSlider((slider) =>
				slider
					.setLimits(1, 60, 1)
					.setValue(this.plugin.settings.syncIntervalMinutes)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.syncIntervalMinutes = value;
						await this.plugin.saveSettings();
						this.plugin.restartAutoSync();
					})
			);

		// --- Status bar ---
		containerEl.createEl("h3", { text: "Display" });

		new Setting(containerEl)
			.setName("Show status bar")
			.setDesc("Show last sync time and status in the status bar.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showStatusBar)
					.onChange(async (value) => {
						this.plugin.settings.showStatusBar = value;
						await this.plugin.saveSettings();
						this.plugin.updateStatusBarVisibility();
					})
			);
	}
}
