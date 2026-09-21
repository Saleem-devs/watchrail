import { desc, eq } from 'drizzle-orm';
import type { NewMonitor } from '@watchrail/domain';
import type { WatchrailDatabase } from './client.js';
import { monitors, type MonitorRecord } from './schema.js';

export class MonitorRepository {
  constructor(private readonly db: WatchrailDatabase) {}

  async create(organizationId: string, monitor: NewMonitor): Promise<MonitorRecord> {
    const [created] = await this.db
      .insert(monitors)
      .values({ organizationId, ...monitor })
      .returning();

    if (!created) throw new Error('The monitor insert returned no record.');
    return created;
  }

  async listForOrganization(organizationId: string): Promise<MonitorRecord[]> {
    return this.db
      .select()
      .from(monitors)
      .where(eq(monitors.organizationId, organizationId))
      .orderBy(desc(monitors.createdAt));
  }
}
