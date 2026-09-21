import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { MonitorRepository, type MonitorRecord } from '@watchrail/db';
import { createMonitor, MonitorInputError } from '@watchrail/domain';
import type { CreateMonitorCommand } from '@watchrail/domain';
import type { RequestContext } from './request-context.js';

@Injectable()
export class MonitorsService {
  constructor(@Inject(MonitorRepository) private readonly monitors: MonitorRepository) {}

  async create(context: RequestContext, command: CreateMonitorCommand): Promise<MonitorRecord> {
    try {
      const monitor = createMonitor(command);
      return await this.monitors.create(context.organizationId, monitor);
    } catch (error) {
      if (error instanceof MonitorInputError) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: error.message,
          fields: error.fields,
        });
      }
      throw error;
    }
  }

  list(context: RequestContext): Promise<MonitorRecord[]> {
    return this.monitors.listForOrganization(context.organizationId);
  }
}
