import { App, Modal, Notice } from "obsidian";
import { TodoistAPI, TodoistTask, UpdateTaskParams } from "../api/TodoistAPI";

export class TaskEditModal extends Modal {
	private tid: string;
	private api: TodoistAPI;
	private onSaved: () => Promise<void>;

	// Form state (updated by inputs)
	private content = "";
	private description = "";
	private dueString = "";
	private deadlineDate = "";
	private priority = 1;

	// Original values for change detection
	private originalContent = "";
	private originalDescription = "";
	private originalDueString = "";
	private originalDeadlineDate = "";
	private originalPriority = 1;

	constructor(
		app: App,
		api: TodoistAPI,
		tid: string,
		onSaved: () => Promise<void>
	) {
		super(app);
		this.api = api;
		this.tid = tid;
		this.onSaved = onSaved;
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.addClass("todoist-edit-modal");
		contentEl.createEl("h2", { text: "Edit Task" });

		const loadingEl = contentEl.createEl("p", { text: "Loading…" });

		let task: TodoistTask;
		try {
			task = await this.api.getTask(this.tid);
		} catch (e) {
			loadingEl.setText(`Failed to load task: ${e}`);
			return;
		}

		loadingEl.remove();

		this.content = task.content;
		this.description = task.description ?? "";
		this.dueString = task.due?.string ?? "";
		this.deadlineDate = task.deadline?.date ?? "";
		this.priority = task.priority;

		this.originalContent = this.content;
		this.originalDescription = this.description;
		this.originalDueString = this.dueString;
		this.originalDeadlineDate = this.deadlineDate;
		this.originalPriority = this.priority;

		this.buildForm();
	}

	private buildForm() {
		const { contentEl } = this;

		// --- Task name ---
		contentEl.createEl("label", { text: "Task name" });
		const contentInput = contentEl.createEl("input", {
			type: "text",
			value: this.content,
		});
		contentInput.style.cssText = "width:100%;margin-bottom:12px;";
		contentInput.addEventListener("input", () => {
			this.content = contentInput.value;
		});

		// --- Description ---
		contentEl.createEl("label", { text: "Description" });
		const descArea = contentEl.createEl("textarea");
		descArea.value = this.description;
		descArea.rows = 4;
		descArea.style.cssText =
			"width:100%;resize:vertical;margin-bottom:12px;";
		descArea.addEventListener("input", () => {
			this.description = descArea.value;
		});

		// --- Due date ---
		contentEl.createEl("label", { text: 'Due date (e.g. "tomorrow", "next Monday")' });
		const dueInput = contentEl.createEl("input", {
			type: "text",
			value: this.dueString,
		});
		dueInput.style.cssText = "width:100%;margin-bottom:12px;";
		dueInput.setAttribute("placeholder", 'e.g. "tomorrow", "next Monday at 3pm"');
		dueInput.addEventListener("input", () => {
			this.dueString = dueInput.value;
		});

		// --- Deadline ---
		contentEl.createEl("label", { text: "Deadline" });
		const deadlineInput = contentEl.createEl("input", { type: "date" });
		deadlineInput.value = this.deadlineDate;
		deadlineInput.style.cssText = "width:100%;margin-bottom:12px;";
		deadlineInput.addEventListener("input", () => {
			this.deadlineDate = deadlineInput.value;
		});

		// --- Priority ---
		contentEl.createEl("label", { text: "Priority" });
		const priorityRow = contentEl.createDiv({
			cls: "todoist-priority-row",
		});
		priorityRow.style.cssText =
			"display:flex;gap:8px;margin-bottom:16px;margin-top:4px;";

		const PRIORITIES = [
			{ label: "P1 🔺", value: 4 },
			{ label: "P2 ⏫", value: 3 },
			{ label: "P3 🔼", value: 2 },
			{ label: "P4", value: 1 },
		];

		const priorityBtns: HTMLButtonElement[] = [];
		for (const p of PRIORITIES) {
			const btn = priorityRow.createEl("button", { text: p.label });
			btn.style.cssText = "flex:1;";
			if (this.priority === p.value) {
				btn.addClass("mod-cta");
			}
			btn.addEventListener("click", () => {
				this.priority = p.value;
				priorityBtns.forEach((b) => b.removeClass("mod-cta"));
				btn.addClass("mod-cta");
			});
			priorityBtns.push(btn);
		}

		// --- Action buttons ---
		const btnRow = contentEl.createDiv();
		btnRow.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";

		const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());

		const saveBtn = btnRow.createEl("button", {
			text: "Save",
			cls: "mod-cta",
		});
		saveBtn.addEventListener("click", () => this.save(saveBtn));

		// Focus the content input
		contentInput.focus();
		contentInput.select();
	}

	private async save(saveBtn: HTMLButtonElement) {
		const params: UpdateTaskParams = {};

		if (this.content !== this.originalContent)
			params.content = this.content;
		if (this.description !== this.originalDescription)
			params.description = this.description;
		if (this.dueString !== this.originalDueString)
			params.due_string = this.dueString;
		if (this.deadlineDate !== this.originalDeadlineDate)
			params.deadline_date = this.deadlineDate;
		if (this.priority !== this.originalPriority)
			params.priority = this.priority;

		if (Object.keys(params).length === 0) {
			this.close();
			return;
		}

		saveBtn.disabled = true;
		saveBtn.setText("Saving…");

		try {
			await this.api.updateTask(this.tid, params);
			this.close();
			await this.onSaved();
		} catch (e) {
			new Notice(`Todoist Inline: Failed to save task — ${e}`);
			saveBtn.disabled = false;
			saveBtn.setText("Save");
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
