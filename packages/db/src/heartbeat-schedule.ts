import { CronExpressionParser } from 'cron-parser';
import type { HeartbeatSchedule } from '@watchrail/domain';

export function nextHeartbeatDeadline(schedule: HeartbeatSchedule, after: Date): Date {
  if (schedule.type === 'INTERVAL') {
    return new Date(after.getTime() + (schedule.intervalSeconds + schedule.graceSeconds) * 1_000);
  }
  const next = CronExpressionParser.parse(schedule.expression, {
    currentDate: after,
    tz: schedule.timezone,
  })
    .next()
    .toDate();
  return new Date(next.getTime() + schedule.graceSeconds * 1_000);
}
