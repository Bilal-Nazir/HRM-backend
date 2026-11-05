export function reportDay(value: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const part = (name: string) => parts.find((item) => item.type === name)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function nextReportDay(day: string) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function reportMidnight(day: string, timeZone: string) {
  const target = Date.parse(`${day}T00:00:00Z`);
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(guess));
    const part = (name: string) => Number(parts.find((item) => item.type === name)!.value);
    const observed = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
    const correction = target - observed;
    if (!correction) break;
    guess += correction;
  }
  return new Date(guess);
}

type Timer = { id: string; taskId: string; startedAt: Date | string; endedAt?: Date | string; stopReason?: string };
type TaskEvent = { taskId?: string; createdAt?: Date; action: string };

// Split elapsed time at local midnight and clip it to the requested range.
export function dailyTaskActivity(sessions: Timer[], events: TaskEvent[], from: string, to: string, timeZone: string, now = new Date()) {
  const rangeStart = reportMidnight(from, timeZone).getTime();
  const rangeEnd = reportMidnight(nextReportDay(to), timeZone).getTime();
  const days = new Map<string, Map<string, { taskId: string; seconds: number; sessionIds: Set<string>; events: Set<string>; intervals: { id: string; startedAt: Date; endedAt: Date; seconds: number; running: boolean; stopReason?: string }[] }>>();
  const taskOnDay = (day: string, taskId: string) => {
    if (!days.has(day)) days.set(day, new Map());
    const tasks = days.get(day)!;
    if (!tasks.has(taskId)) tasks.set(taskId, { taskId, seconds: 0, sessionIds: new Set(), events: new Set(), intervals: [] });
    return tasks.get(taskId)!;
  };
  for (const session of sessions) {
    let cursor = Math.max(new Date(session.startedAt).getTime(), rangeStart);
    const end = Math.min(new Date(session.endedAt || now).getTime(), rangeEnd, now.getTime());
    while (cursor < end) {
      const day = reportDay(new Date(cursor), timeZone);
      const stop = Math.min(reportMidnight(nextReportDay(day), timeZone).getTime(), end);
      if (stop <= cursor) break;
      const seconds = Math.max(0, Math.floor((stop - cursor) / 1000));
      const task = taskOnDay(day, session.taskId);
      task.seconds += seconds;
      task.sessionIds.add(session.id);
      task.intervals.push({ id: session.id, startedAt: new Date(cursor), endedAt: new Date(stop), seconds, running: !session.endedAt && stop === end && end === now.getTime(), stopReason: session.stopReason });
      cursor = stop;
    }
  }
  for (const event of events) {
    if (!event.taskId || !event.createdAt) continue;
    const at = new Date(event.createdAt);
    if (at.getTime() < rangeStart || at.getTime() >= rangeEnd) continue;
    taskOnDay(reportDay(at, timeZone), event.taskId).events.add(event.action);
  }
  return [...days].sort(([a], [b]) => b.localeCompare(a)).map(([date, tasks]) => ({
    date,
    taskCount: tasks.size,
    seconds: [...tasks.values()].reduce((sum, task) => sum + task.seconds, 0),
    tasks: [...tasks.values()].map((task) => ({ taskId: task.taskId, seconds: task.seconds, sessionCount: task.sessionIds.size, events: [...task.events], intervals: task.intervals.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime()) })),
  }));
}
