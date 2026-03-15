import {
	TodoistAPI,
	TodoistTask,
	TodoistSection,
} from "../api/TodoistAPI";
import { parseNote, renderTaskLine } from "../parser/NoteParser";

export interface SyncResult {
	noteContent: string;
	tasksCreated: number;
	tasksClosed: number;
	tasksReopened: number;
	tasksUpdated: number;
	errors: string[];
}

const SECTION_REGEX = /^### (.+)$/;

export class SyncEngine {
	constructor(private api: TodoistAPI) {}

	/**
	 * Full 2-way sync:
	 * 1. Push changes from note → Todoist (new tasks, completion changes, content changes)
	 * 2. Pull latest state from Todoist → update note in-place (preserving non-task lines)
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
		const { tasks: noteTasks } = parseNote(noteContent);

		// Fetch current Todoist state
		let [todoistTasks, sections] = await Promise.all([
			this.api.getTasks(projectId),
			this.api.getSections(projectId),
		]);

		const taskIdToTodoist = new Map(todoistTasks.map((t) => [t.id, t]));
		const sectionNameToId = new Map(sections.map((s) => [s.name, s.id]));

		// --- Phase 1: Push note → Todoist ---

		// Map from line index → ParsedTask for parent lookups
		const lineToNoteTask = new Map(noteTasks.map((t) => [t.line, t]));

		// Tracks new tid assignments (note line index → created Todoist ID)
		const newTids = new Map<number, string>();

		// Process tasks with existing tids first (updates / completion changes)
		for (const noteTask of noteTasks) {
			if (!noteTask.tid) continue;
			const todoistTask = taskIdToTodoist.get(noteTask.tid);
			if (!todoistTask) continue; // deleted in Todoist, handled on pull

			try {
				if (noteTask.checked && !todoistTask.is_completed) {
					await this.api.closeTask(noteTask.tid);
					result.tasksClosed++;
				} else if (!noteTask.checked && todoistTask.is_completed) {
					await this.api.reopenTask(noteTask.tid);
					result.tasksReopened++;
				}

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

		// Process new tasks (no tid) sorted by indent so parents come first
		const newTasks = noteTasks
			.filter((t) => !t.tid)
			.sort((a, b) => a.indent - b.indent);

		for (const noteTask of newTasks) {
			try {
				// Resolve parent — subtasks must not also carry section_id
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

				// Only root tasks (no parent) belong to a section
				let sectionId: string | undefined;
				if (!parentId && noteTask.sectionName) {
					sectionId = sectionNameToId.get(noteTask.sectionName);
					if (!sectionId) {
						const newSection = await this.api.createSection(
							projectId,
							noteTask.sectionName
						);
						sectionNameToId.set(noteTask.sectionName, newSection.id);
						sections.push(newSection);
						sectionId = newSection.id;
					}
				}

				const created = await this.api.createTask({
					content: noteTask.content,
					project_id: projectId,
					section_id: sectionId,
					parent_id: parentId,
					priority: noteTask.priority,
				});

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

		// --- Phase 2: Pull Todoist → update note in-place ---
		[todoistTasks, sections] = await Promise.all([
			this.api.getTasks(projectId),
			this.api.getSections(projectId),
		]);

		result.noteContent = this.updateNoteContent(
			noteContent,
			todoistTasks,
			sections,
			newTids
		);

		return result;
	}

	/**
	 * Pull-only sync: fetch from Todoist and update note in-place.
	 * Non-task lines are preserved; task lines are updated from Todoist.
	 */
	async pull(noteContent: string, projectId: string): Promise<string> {
		const [todoistTasks, sections] = await Promise.all([
			this.api.getTasks(projectId),
			this.api.getSections(projectId),
		]);
		return this.updateNoteContent(
			noteContent,
			todoistTasks,
			sections,
			new Map()
		);
	}

	/**
	 * Update the note content in-place:
	 * - Preserve every line that is not a recognised task line
	 * - Update task lines (with tid) from Todoist data
	 * - Embed newly-created tids into lines for tasks just pushed
	 * - Append new Todoist tasks that are not yet in the note
	 * - Remove lines for tasks that no longer exist in Todoist
	 */
	private updateNoteContent(
		originalContent: string,
		todoistTasks: TodoistTask[],
		sections: TodoistSection[],
		newTids: Map<number, string>
	): string {
		const { tasks: noteTasks } = parseNote(originalContent);
		const lines = originalContent.split("\n");

		const tidToTodoist = new Map(todoistTasks.map((t) => [t.id, t]));
		const sectionNameToId = new Map(sections.map((s) => [s.name, s.id]));

		// Set of Todoist IDs already present in the note
		const noteTaskTids = new Set(
			noteTasks.filter((t) => t.tid).map((t) => t.tid!)
		);

		// Set of Todoist IDs we just created in the push phase — these are
		// handled by embedding their tid into the existing note line, so they
		// must not also be appended as "new tasks from Todoist".
		const newlyCreatedTids = new Set(newTids.values());

		// Build a child map for Todoist tasks NOT in the note (to render new subtrees)
		const newTaskChildMap = new Map<string | null, TodoistTask[]>();
		for (const task of todoistTasks) {
			if (noteTaskTids.has(task.id)) continue;
			if (newlyCreatedTids.has(task.id)) continue;
			const key = task.parent_id ?? null;
			if (!newTaskChildMap.has(key)) newTaskChildMap.set(key, []);
			newTaskChildMap.get(key)!.push(task);
		}
		for (const arr of newTaskChildMap.values())
			arr.sort((a, b) => a.order - b.order);

		// Separate new tasks into:
		//   newRootsBySectionId — root tasks not yet in the note, grouped by section
		//   newSubsByParentTid  — subtasks of existing note tasks, grouped by parent tid
		const newRootsBySectionId = new Map<string | null, TodoistTask[]>();
		const newSubsByParentTid = new Map<string, TodoistTask[]>();

		for (const [parentKey, tasks] of newTaskChildMap.entries()) {
			for (const task of tasks) {
				if (parentKey === null) {
					// Root task not in note
					const sKey = task.section_id ?? null;
					if (!newRootsBySectionId.has(sKey))
						newRootsBySectionId.set(sKey, []);
					newRootsBySectionId.get(sKey)!.push(task);
				} else if (noteTaskTids.has(parentKey)) {
					// Subtask whose parent IS in the note
					if (!newSubsByParentTid.has(parentKey))
						newSubsByParentTid.set(parentKey, []);
					newSubsByParentTid.get(parentKey)!.push(task);
				}
				// else: subtask of another new task — rendered recursively via renderNewTree
			}
		}

		// Recursively render a new task and all its new children
		const renderNewTree = (task: TodoistTask, indent: number): string[] => {
			const result = [
				renderTaskLine(
					indent,
					task.is_completed,
					task.content,
					task.priority,
					task.id
				),
			];
			const children = newTaskChildMap.get(task.id) ?? [];
			for (const child of children) {
				result.push(...renderNewTree(child, indent + 2));
			}
			return result;
		};

		// For each note task, compute the line index of the last task in its
		// subtree (used to know where to append new children from Todoist).
		const lastTaskLineOfSubtree = new Map<number, number>();
		for (const t of noteTasks) lastTaskLineOfSubtree.set(t.line, t.line);
		for (let i = noteTasks.length - 1; i >= 0; i--) {
			const t = noteTasks[i];
			if (t.parentLineIndex !== null) {
				const cur =
					lastTaskLineOfSubtree.get(t.parentLineIndex) ??
					t.parentLineIndex;
				const mine = lastTaskLineOfSubtree.get(t.line) ?? t.line;
				lastTaskLineOfSubtree.set(t.parentLineIndex, Math.max(cur, mine));
			}
		}

		// Per-line decisions: what replaces each line (undefined = keep as-is, null = delete)
		const lineReplacement = new Map<number, string | null>();
		// Lines to insert immediately AFTER a given line index
		const insertAfter = new Map<number, string[]>();

		const addInsertAfter = (lineIdx: number, newLines: string[]) => {
			if (!insertAfter.has(lineIdx)) insertAfter.set(lineIdx, []);
			insertAfter.get(lineIdx)!.push(...newLines);
		};

		for (const noteTask of noteTasks) {
			if (noteTask.tid) {
				const todoistTask = tidToTodoist.get(noteTask.tid);
				if (!todoistTask) {
					// Task no longer exists in Todoist → remove the line
					lineReplacement.set(noteTask.line, null);
				} else {
					// Update line in-place with latest Todoist data
					lineReplacement.set(
						noteTask.line,
						renderTaskLine(
							noteTask.indent,
							todoistTask.is_completed,
							todoistTask.content,
							todoistTask.priority,
							todoistTask.id
						)
					);

					// Append new Todoist subtasks after this task's last child line
					const newSubs = newSubsByParentTid.get(noteTask.tid) ?? [];
					if (newSubs.length > 0) {
						const insertLine =
							lastTaskLineOfSubtree.get(noteTask.line) ??
							noteTask.line;
						addInsertAfter(
							insertLine,
							newSubs.flatMap((sub) =>
								renderNewTree(sub, noteTask.indent + 2)
							)
						);
					}
				}
			} else {
				// New task (no tid): embed tid if the push phase created it
				const newTid = newTids.get(noteTask.line);
				if (newTid) {
					// Use fresh Todoist data if available; fall back to note
					// data if the newly-created task isn't in the GET response
					// yet (Todoist eventual consistency). Either way, the tid
					// must be embedded so the task isn't re-created next sync.
					const todoistTask = tidToTodoist.get(newTid);
					lineReplacement.set(
						noteTask.line,
						renderTaskLine(
							noteTask.indent,
							todoistTask?.is_completed ?? noteTask.checked,
							todoistTask?.content ?? noteTask.content,
							todoistTask?.priority ?? noteTask.priority,
							newTid
						)
					);
				}
				// No action otherwise — leave the line as typed
			}
		}

		// Build output line-by-line, tracking the current section so we know
		// where to append new root tasks from Todoist.
		const output: string[] = [];
		let currentSectionId: string | null = null;
		const seenSectionIds = new Set<string | null>([null]);

		const flushNewRootTasks = (sectionId: string | null) => {
			const roots = newRootsBySectionId.get(sectionId) ?? [];
			for (const task of roots) output.push(...renderNewTree(task, 0));
		};

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const sectionMatch = line.match(SECTION_REGEX);

			if (sectionMatch) {
				// Leaving the current section — append any new root tasks for it
				flushNewRootTasks(currentSectionId);
				currentSectionId =
					sectionNameToId.get(sectionMatch[1].trim()) ?? null;
				seenSectionIds.add(currentSectionId);
				output.push(line);
			} else if (lineReplacement.has(i)) {
				const replacement = lineReplacement.get(i);
				if (replacement !== null && replacement !== undefined) {
					output.push(replacement);
				}
				// null → line deleted, emit nothing
			} else {
				// Non-task line or unrecognised task line — preserve as-is
				output.push(line);
			}

			// Insert new tasks scheduled after this line
			const extra = insertAfter.get(i);
			if (extra) output.push(...extra);
		}

		// Flush new root tasks for the final section
		flushNewRootTasks(currentSectionId);

		// Append entirely new sections from Todoist (not present in the note at all)
		for (const section of [...sections].sort((a, b) => a.order - b.order)) {
			if (seenSectionIds.has(section.id)) continue;
			const roots = newRootsBySectionId.get(section.id) ?? [];
			if (roots.length === 0) continue;
			output.push("");
			output.push(`### ${section.name}`);
			output.push("");
			for (const task of roots) output.push(...renderNewTree(task, 0));
		}

		// Remove trailing blank lines
		while (output.length > 0 && output[output.length - 1] === "")
			output.pop();

		return output.join("\n");
	}
}
