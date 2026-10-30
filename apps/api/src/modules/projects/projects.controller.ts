import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { RequirePermission } from '../../auth/auth.guard.js';
import { PERMISSIONS } from '../../auth/permissions.js';
import type { RequestWithContext } from '../../auth/request-context.js';
import { presentProject } from './projects.presenter.js';
import { ProjectsService } from './projects.service.js';

@Controller('projects')
export class ProjectsController {
  constructor(@Inject(ProjectsService) private readonly projects: ProjectsService) {}

  @Get()
  @RequirePermission(PERMISSIONS.PROJECT_READ)
  async list(@Req() request: RequestWithContext) {
    return {
      data: (await this.projects.list(request.watchrailContext)).map((project) =>
        presentProject(project),
      ),
    };
  }

  @Post()
  @RequirePermission(PERMISSIONS.PROJECT_MANAGE)
  async create(@Req() request: RequestWithContext, @Body() input: unknown) {
    return { data: presentProject(await this.projects.create(request.watchrailContext, input)) };
  }

  @Get(':projectId')
  @RequirePermission(PERMISSIONS.PROJECT_READ)
  async find(
    @Req() request: RequestWithContext,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return { data: presentProject(await this.projects.find(request.watchrailContext, projectId)) };
  }
}
