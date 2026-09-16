// Ordering rules for the task board render.
export interface Task {
  id: number;
  priority: number;
  label: string;
}

export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => a.priority - b.priority || a.id - b.id);
}
