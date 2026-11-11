export const historyFieldLabels: Record<string, string> = {
  title: "Title", description: "Description", priority: "Priority", assigneeEmployeeIds: "Assignees",
  parentStoryId: "Parent story", startDate: "Scheduled start", dueDate: "Due date", estimatedHours: "Estimated hours", labels: "Labels", durationMinutes: "Task duration (minutes)",
};

export function sameHistoryValue(left: unknown, right: unknown): boolean {
  const normalize = (value: unknown): unknown => {
    if (value === undefined || value === null || value === "") return null;
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return [...value].map(String).sort();
    return value;
  };
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

export function taskHistoryChanges(entry: { action: string; changes?: Record<string, any> }, people: Map<string, string>, statuses: Map<string, string>, parents: Map<string, string>) {
  const changes = entry.changes || {};
  const display = (field: string, value: unknown): string => {
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)) return "None";
    if (field === "assigneeEmployeeIds" && Array.isArray(value)) return value.map((id) => people.get(String(id)) || "Former team member").join(", ");
    if (field === "parentStoryId") return parents.get(String(value)) || "Former story";
    if (value instanceof Date) return value.toISOString();
    return Array.isArray(value) ? value.join(", ") : String(value);
  };
  if (["task.status_changed", "task.auto_completed", "task.auto_paused"].includes(entry.action)) return [{ field: "status", label: "Status", before: String(changes.from || statuses.get(changes.fromStatusId) || "Unknown status"), after: String(changes.to || statuses.get(changes.toStatusId) || "Unknown status") + (entry.action === "task.auto_completed" ? " (Auto done)" : entry.action === "task.auto_paused" ? " (Auto paused)" : "") }];
  if (entry.action === "task.updated") return Object.keys(changes.after || {}).filter((field) => !sameHistoryValue(changes.before?.[field], changes.after[field])).map((field) => ({ field, label: historyFieldLabels[field] || field, before: display(field, changes.before?.[field]), after: display(field, changes.after[field]) }));
  return [];
}
