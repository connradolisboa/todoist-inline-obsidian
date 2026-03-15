import { App, SuggestModal } from "obsidian";
import { TodoistProject } from "../api/TodoistAPI";

export class ProjectSuggestModal extends SuggestModal<TodoistProject> {
	private projects: TodoistProject[];
	private onSelect: (project: TodoistProject) => Promise<void>;

	constructor(
		app: App,
		projects: TodoistProject[],
		onSelect: (project: TodoistProject) => Promise<void>
	) {
		super(app);
		this.projects = projects;
		this.onSelect = onSelect;
		this.setPlaceholder("Search Todoist projects…");
	}

	getSuggestions(query: string): TodoistProject[] {
		const q = query.toLowerCase();
		return this.projects.filter((p) =>
			p.name.toLowerCase().includes(q)
		);
	}

	renderSuggestion(project: TodoistProject, el: HTMLElement): void {
		el.createEl("div", { text: project.name, cls: "todoist-project-name" });
		el.createEl("small", {
			text: `ID: ${project.id}`,
			cls: "todoist-project-id",
		});
	}

	async onChooseSuggestion(
		project: TodoistProject,
		_evt: MouseEvent | KeyboardEvent
	): Promise<void> {
		await this.onSelect(project);
	}
}
