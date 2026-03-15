export interface TodoistTask {
	id: string;
	content: string;
	description: string;
	priority: number; // 1=P4 (normal), 2=P3, 3=P2, 4=P1 (urgent)
	section_id: string | null;
	parent_id: string | null;
	project_id: string;
	is_completed: boolean;
	order: number;
	labels: string[];
	due?: {
		date: string;
		string: string;
		datetime?: string;
		timezone?: string;
	};
}

export interface TodoistSection {
	id: string;
	project_id: string;
	name: string;
	order: number;
}

export interface TodoistProject {
	id: string;
	name: string;
}

export interface CreateTaskParams {
	content: string;
	project_id: string;
	section_id?: string;
	parent_id?: string;
	priority?: number;
	order?: number;
}

export interface UpdateTaskParams {
	content?: string;
	priority?: number;
	description?: string;
}

type ApiResponse<T> = T[] | { results: T[]; next_cursor?: string | null };

export class TodoistAPI {
	private baseUrl = "https://api.todoist.com/api/v1";
	private token: string;

	constructor(token: string) {
		this.token = token;
	}

	private async request<T>(
		method: string,
		path: string,
		body?: unknown
	): Promise<T> {
		const response = await fetch(`${this.baseUrl}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${this.token}`,
				"Content-Type": "application/json",
			},
			body: body ? JSON.stringify(body) : undefined,
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Todoist API error ${response.status}: ${text}`);
		}

		if (response.status === 204) return undefined as unknown as T;
		return response.json();
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private extractResults(data: any): any[] {
		if (Array.isArray(data)) return data;
		return data?.results ?? [];
	}

	async getTasks(projectId: string): Promise<TodoistTask[]> {
		// Handle cursor-based pagination
		const allTasks: TodoistTask[] = [];
		let cursor: string | null = null;

		do {
			const queryString = cursor
				? `project_id=${projectId}&cursor=${cursor}`
				: `project_id=${projectId}`;
			const data = await this.request<ApiResponse<TodoistTask>>(
				"GET",
				`/tasks?${queryString}`
			);
			const results = this.extractResults(data);
			allTasks.push(...results);
			cursor =
				!Array.isArray(data) && data.next_cursor
					? data.next_cursor
					: null;
		} while (cursor);

		return allTasks;
	}

	async getSections(projectId: string): Promise<TodoistSection[]> {
		const data = await this.request<ApiResponse<TodoistSection>>(
			"GET",
			`/sections?project_id=${projectId}`
		);
		return this.extractResults(data);
	}

	async getProjects(): Promise<TodoistProject[]> {
		const data = await this.request<ApiResponse<TodoistProject>>(
			"GET",
			"/projects"
		);
		return this.extractResults(data);
	}

	async createTask(params: CreateTaskParams): Promise<TodoistTask> {
		return this.request<TodoistTask>("POST", "/tasks", params);
	}

	async updateTask(
		taskId: string,
		params: UpdateTaskParams
	): Promise<TodoistTask> {
		return this.request<TodoistTask>("POST", `/tasks/${taskId}`, params);
	}

	async closeTask(taskId: string): Promise<void> {
		return this.request<void>("POST", `/tasks/${taskId}/close`);
	}

	async reopenTask(taskId: string): Promise<void> {
		return this.request<void>("POST", `/tasks/${taskId}/reopen`);
	}

	async deleteTask(taskId: string): Promise<void> {
		return this.request<void>("DELETE", `/tasks/${taskId}`);
	}

	async createSection(
		projectId: string,
		name: string,
		order?: number
	): Promise<TodoistSection> {
		return this.request<TodoistSection>("POST", "/sections", {
			project_id: projectId,
			name,
			order,
		});
	}
}
