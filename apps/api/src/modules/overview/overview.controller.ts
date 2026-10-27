import { Controller, Get, Inject, Req } from '@nestjs/common';
import { RequirePermission } from '../../auth/auth.guard.js';
import { PERMISSIONS } from '../../auth/permissions.js';
import type { RequestWithContext } from '../../auth/request-context.js';
import { responseTimeOverviewResponse } from './overview.presenter.js';
import { OverviewService } from './overview.service.js';

@Controller('overview')
export class OverviewController {
  constructor(@Inject(OverviewService) private readonly overview: OverviewService) {}

  @Get('response-times')
  @RequirePermission(PERMISSIONS.CHECK_READ)
  async responseTimes(@Req() request: RequestWithContext) {
    return {
      data: responseTimeOverviewResponse(
        await this.overview.responseTimes(request.watchrailContext),
      ),
    };
  }
}
