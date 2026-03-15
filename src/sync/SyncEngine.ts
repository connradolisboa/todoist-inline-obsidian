import {
	TodoistAPI,
	TodoistTask,
	TodoistSection,
} from "../api/TodoistAPI";
import { parseNote, renderTaskLine, ParsedTask } from "../parser/NoteParser";

export interface SyncResult {
	noteContent: string;
	tasksCreated: number;
	tasksClosed: number;
	tasksReopened: number;
	tasksUpdated: number;
	errors: string[];
}

export class SyncEngine {
	constructor(private api: TodoistAPI) {}

	/**
	 * Full 2-way sync:
	 * 1. Push changes from note → Todoist (new tasks, completion changes, content changes)
	 * 2. Pull latest state from Todoist → rebuild note
	 */
	async sync(noteContent: string, projectId: string): Promise<SyncResult> {
		const result: SyncResult = {
			noteContent,
			tasksCreated: 0,
			tasksClosed: 0,
			tasksReopened: 0,
			tasksUpdated: 0,
			errors: [],
		};

		// Parse current note
		const { tasks: noteTasks, frontmatterLines, preambleLines } =
			parseNote(noteContent);

		// Fetch current Todoist state
		let [todoistTasks, sections] = await Promise.all([
			this.api.getTasks(projectId),
			this.api.getSections(projectId),
		]);

		const taskIdToTodoist = new Map(todoistTasks.map((t) => [t.id, t]));
		const sectionNameToId = new Map(sections.map((s) => [s.name, s.id]));

		// --- Phase 1: Push note → Todoist ---

		// Build a map from line index → task for resolving parent relationships
		const lineToNoteTask = new Map(noteTasks.map((t) => [t.line, t]));

		// Track new tid assignments (line → tid) for tasks we create
		const newTids = new Map<number, string>();

		// Process tasks with existing tids first (updates/completion changes)
		for (const noteTask of noteTasks) {
			if (!noteTask.tid) continue;
			const todoistTask = taskIdToTodoist.get(noteTask.tid);
			if (!todoistTask) continue; // task deleted in Todoist, will be removed on pull

			try {
				// Completion state sync
				if (noteTask.checked && !todoistTask.is_completed) {
					await this.api.closeTask(noteTask.tid);
					result.tasksClosed++;
				} else if (!noteTask.checked && todoistTask.is_completed) {
					await this.api.reopenTask(noteTask.tid);
					result.tasksReopened++;
				}

				// Content or priority changes
				if (
					noteTask.content !== todoistTask.content ||
					noteTask.priority !== todoistTask.priority
				) {
					await this.api.updateTask(noteTask.tid, {
						content: noteTask.content,
						priority: noteTask.priority,
					});
					result.tasksUpdated++;
				}
			} catch (e) {
				result.errors.push(
					`Failed to update task "${noteTask.content}": ${e}`
				);
			}
		}

		// Process new tasks (no tid) — must handle parents first
		// Sort by indent so parents are created before children
		const newTasks = noteTasks
			.filter((t) => !t.tid)
			.sort((a, b) => a.indent - b.indent);

		for (const noteTask of newTasks) {
			try {
				// Resolve section
				let sectionId: string | undefined;
				if (noteTask.sectionName) {
					sectionId = sectionNameToId.get(noteTask.sectionName);
					if (!sectionId) {
						// Create section in Todoist
						const newSection = await this.api.createSection(
							projectId,
							noteTask.sectionName
						);
						sectionNameToId.set(noteTask.sectionName, newSection.id);
						sections.push(newSection);
						sectionId = newSection.id;
					}
				}

				// Resolve parent tid
				let parentId: string | undefined;
				if (noteTask.parentLineIndex !== null) {
					const parentNoteTask = lineToNoteTask.get(
						noteTask.parentLineIndex
					);
					if (parentNoteTask) {
						parentId =
							parentNoteTask.tid ??
							newTids.get(parentNoteTask.line);
					}
				}

				const created = await this.api.createTask({
					content: noteTask.content,
					project_id: projectId,
					section_id: sectionId,
					parent_id: parentId,
					priority: noteTask.priority,
				});

				// If the new task was checked, close it immediately
				if (noteTask.checked) {
					await this.api.closeTask(created.id);
					result.tasksClosed++;
				}

				newTids.set(noteTask.line, created.id);
				result.tasksCreated++;
			} catch (e) {
				result.errors.push(
					`Failed to create task "${noteTask.content}": ${e}`
				);
			}
		}

		// --- Phase 2: Pull Todoist → rebuild note ---
		[todoistTasks, sections] = await Promise.all([
			this.api.getTasks(projectId),
			this.api.getSections(projectId),
		]);

		result.noteContent = this.renderNote(
			frontmatterLines,
			preambleLines,
			todoistTasks,
			sections
		);

		return result;
	}

	/**
	 * Pull-only sync: fetch from Todoist and update note without pushing changes.
	 * Preserves checked state for tasks that exist in both note and Todoist.
	 */
	async pull(
		noteContent: string,
		projectId: string
	): Promise<string> {
		const { tasks: noteTasks, frontmatterLines, preambleLines } =
			parseNote(noteContent);
		const [todoistTasks, sections] = await Promise.all([
			this.api.getTasks(projectId),
			this.api.getSections(projectId),
		]);
		return this.renderNote(
			frontmatterLines,
			preambleLines,
			todoistTasks,
			sections
		);
	}

	private renderNote(
		frontmatterLines: string[],
		preambleLines: string[],
		tasks: TodoistTask[],
		sections: TodoistSection[]
	): string {
		// Group root tasks by section (parent_id == null)
		const sectionBuckets = new Map<string | null, TodoistTask[]>();
		sectionBuckets.set(null, []);
		for (const s of sections) sectionBuckets.set(s.id, []);

		// Build child map and populate section buckets for root tasks
		const childMap = new Map<string, TodoistTask[]>();
		for (const task of tasks) {
			if (task.parent_id) {
				if (!childMap.has(task.parent_id))
					childMap.set(task.parent_id, []);
				childMap.get(task.parent_id)!.push(task);
			} else {
				const bucket = sectionBuckets.get(task.section_id ?? null);
				if (bucket) {
					bucket.push(task);
				} else {
					// Section exists in Todoist but not fetched (edge case)
					sectionBuckets.get(null)!.push(task);
				}
			}
		}

		// Sort by order within each bucket
		for (const bucket of sectionBuckets.values()) {
			bucket.sort((a, b) => a.order - b.order);
		}
		for (const children of childMap.values()) {
			children.sort((a, b) => a.order - b.order);
		}

		const outputLines: string[] = [];

		// Frontmatter
		if (frontmatterLines.length > 0) {
			outputLines.push(...frontmatterLines);
			outputLines.push("");
		}

		// Preamble
		if (preambleLines.length > 0) {
			outputLines.push(...preambleLines);
			outputLines.push("");
		}

		// Unsectioned tasks
		const unsectioned = sectionBuckets.get(null) ?? [];
		for (const task of unsectioned) {
			this.renderTaskTree(task, 0, childMap, outputLines);
		}

		// Sections
		const sortedSections = [...sections].sort(
			(a, b) => a.order - b.order
		);
		for (const section of sortedSections) {
			const sectionTasks = sectionBuckets.get(section.id) ?? [];
			if (outputLines.length > 0 && outputLines[outputLines.length - 1] !== "") {
				outputLines.push("");
			}
			outputLines.push(`### ${section.name}`);
			outputLines.push("");
			for (const task of sectionTasks) {
				this.renderTaskTree(task, 0, childMap, outputLines);
			}
		}

		// Remove trailing blank lines
		while (
			outputLines.length > 0 &&
			outputLines[outputLines.length - 1] === ""
		) {
			outputLines.pop();
		}

		return outputLines.join("\n");
	}

	private renderTaskTree(
		task: TodoistTask,
		indent: number,
		childMap: Map<string, TodoistTask[]>,
		outputLines: string[]
	): void {
		outputLines.push(
			renderTaskLine(
				indent,
				task.is_completed,
				task.content,
				task.priority,
				task.id
			)
		);
		const children = childMap.get(task.id) ?? [];
		for (const child of children) {
			this.renderTaskTree(child, indent + 2, childMap, outputLines);
		}
	}
}
