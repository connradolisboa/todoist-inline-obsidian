// Priority mapping between Todoist (1-4) and Tasks plugin emoji
// Todoist: 4=P1/urgent, 3=P2/high, 2=P3/medium, 1=P4/normal
export const PRIORITY_TO_EMOJI: Record<number, string> = {
	4: "🔺",
	3: "⏫",
	2: "🔼",
};

export const EMOJI_TO_PRIORITY: Record<string, number> = {
	"🔺": 4,
	"⏫": 3,
	"🔼": 2,
	"🔽": 1,
};

// Matches lines like: "  - [ ] Task text" or "- [x] Task text"
const TASK_REGEX = /^(\s*)- \[([ xX])\] (.*)$/;
// Embedded Todoist task ID: <!-- tid:12345678 -->
export const TID_REGEX = /<!-- tid:([a-zA-Z0-9_-]+) -->/;
// Section headings managed by plugin (level 3)
const SECTION_REGEX = /^### (.+)$/;
// Description lines rendered by plugin: {indent}> {text} <!-- sync-desc -->
const SYNC_DESC_REGEX = /^(\t*)> (.*) <!-- sync-desc -->$/;

export interface ParsedTask {
	/** Zero-based line index in the note */
	line: number;
	/** Number of leading spaces (determines nesting level) */
	indent: number;
	checked: boolean;
	/** Cleaned task text (priority emoji and tid comment removed) */
	content: string;
	/** Todoist priority 1-4 parsed from emoji */
	priority: number;
	/** Embedded Todoist task ID, null if new/unsynced */
	tid: string | null;
	/** Name of the ### section this task is under, null if before any section */
	sectionName: string | null;
	/** Line index of the parent task, null for root tasks */
	parentLineIndex: number | null;
}

export interface ParsedSection {
	name: string;
	line: number;
}

export interface ParsedNote {
	/** Frontmatter lines (0..frontmatterEnd-1) */
	frontmatterLines: string[];
	/** Lines before the first task or section heading (after frontmatter) */
	preambleLines: string[];
	tasks: ParsedTask[];
	sections: ParsedSection[];
	/** Line indices of plugin-managed description lines (<!-- sync-desc -->) */
	descriptionLineIndices: Set<number>;
}

export function parseNote(content: string): ParsedNote {
	const lines = content.split("\n");
	const tasks: ParsedTask[] = [];
	const sections: ParsedSection[] = [];
	const descriptionLineIndices = new Set<number>();

	// Extract frontmatter
	let frontmatterEnd = 0;
	if (lines[0] === "---") {
		let i = 1;
		while (i < lines.length && lines[i] !== "---") i++;
		frontmatterEnd = i + 1; // include closing ---
	}
	const frontmatterLines = lines.slice(0, frontmatterEnd);

	// Find where task/section content begins
	let taskAreaStart = frontmatterEnd;
	// Skip blank lines right after frontmatter as preamble
	while (
		taskAreaStart < lines.length &&
		lines[taskAreaStart].trim() === ""
	) {
		taskAreaStart++;
	}

	// Collect preamble: any lines before the first task or section that don't look like tasks/sections
	let preambleEnd = taskAreaStart;
	for (let i = taskAreaStart; i < lines.length; i++) {
		if (TASK_REGEX.test(lines[i]) || SECTION_REGEX.test(lines[i])) {
			preambleEnd = i;
			break;
		}
		preambleEnd = i + 1;
	}
	const preambleLines = lines.slice(taskAreaStart, preambleEnd);

	// Parse tasks and sections
	let currentSection: string | null = null;
	// Stack for tracking parent tasks by indent level
	const indentStack: Array<{ indent: number; lineIndex: number }> = [];

	for (let i = preambleEnd; i < lines.length; i++) {
		const line = lines[i];

		// Description line (plugin-managed)
		if (SYNC_DESC_REGEX.test(line)) {
			descriptionLineIndices.add(i);
			continue;
		}

		// Section heading
		const sectionMatch = line.match(SECTION_REGEX);
		if (sectionMatch) {
			currentSection = sectionMatch[1].trim();
			sections.push({ name: currentSection, line: i });
			indentStack.length = 0;
			continue;
		}

		// Task line
		const taskMatch = line.match(TASK_REGEX);
		if (taskMatch) {
			// Normalize indent to nesting level: count tabs, or divide spaces by 2
			const leading = taskMatch[1];
			const tabCount = (leading.match(/\t/g) ?? []).length;
			const spaceCount = (leading.match(/ /g) ?? []).length;
			const indent = tabCount > 0 ? tabCount : Math.floor(spaceCount / 2);
			const checked =
				taskMatch[2].toLowerCase() === "x";
			let rawContent = taskMatch[3].trim();

			// Extract tid
			const tidMatch = rawContent.match(TID_REGEX);
			const tid = tidMatch ? tidMatch[1] : null;
			rawContent = rawContent.replace(TID_REGEX, "").trim();

			// Extract priority emoji (try longest first to avoid partial match issues)
			let priority = 1;
			for (const [emoji, p] of Object.entries(EMOJI_TO_PRIORITY)) {
				if (rawContent.includes(emoji)) {
					priority = p;
					rawContent = rawContent.replace(emoji, "").trim();
					break;
				}
			}

			// Find parent by unwinding indent stack
			while (
				indentStack.length > 0 &&
				indentStack[indentStack.length - 1].indent >= indent
			) {
				indentStack.pop();
			}
			const parentLineIndex =
				indentStack.length > 0
					? indentStack[indentStack.length - 1].lineIndex
					: null;
			indentStack.push({ indent, lineIndex: i });

			tasks.push({
				line: i,
				indent,
				checked,
				content: rawContent,
				priority,
				tid,
				sectionName: currentSection,
				parentLineIndex,
			});
		}
	}

	return { frontmatterLines, preambleLines, tasks, sections, descriptionLineIndices };
}

export function renderDescriptionLines(indent: number, description: string): string[] {
	if (!description) return [];
	const indentStr = "\t".repeat(indent);
	return description
		.split("\n")
		.map((line) => `${indentStr}> ${line} <!-- sync-desc -->`);
}

export function renderTaskLine(
	indent: number,
	checked: boolean,
	content: string,
	priority: number,
	tid: string | null
): string {
	const spaces = "\t".repeat(indent);
	const checkbox = checked ? "[x]" : "[ ]";
	const priorityEmoji =
		PRIORITY_TO_EMOJI[priority] ? ` ${PRIORITY_TO_EMOJI[priority]}` : "";
	const tidPrefix = tid ? `<!-- tid:${tid} --> ` : "";
	return `${spaces}- ${checkbox} ${tidPrefix}${content}${priorityEmoji}`;
}
