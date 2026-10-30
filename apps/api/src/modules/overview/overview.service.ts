import { Inject, Injectable } from '@nestjs/common';
import { CheckHistoryRepository } from '@watchrail/db';
import type { RequestContext } from '../../auth/request-context.js';

@Injectable()
export class OverviewService {
  constructor(@Inject(CheckHistoryRepository) private readonly history: CheckHistoryRepository) {}

  responseTimes(context: RequestContext, projectId: string) {
    return this.history.responseTimeOverview(context.organizationId, new Date(), projectId);
  }
}
