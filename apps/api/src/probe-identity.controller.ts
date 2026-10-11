import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { ProbeAgentRecord, ProbeLocationRecord } from '@watchrail/db';
import type { ProbeMachineRequest } from './probe-machine-auth.js';
import { ProbeMachineAuthGuard } from './probe-machine-auth.js';
import { ProbeIdentityService } from './probe-identity.service.js';
import type { RequestWithContext } from './request-context.js';

@Controller('probe-locations')
export class ProbeLocationsController {
  constructor(@Inject(ProbeIdentityService) private readonly probes: ProbeIdentityService) {}

  @Post()
  async create(@Req() request: RequestWithContext, @Body() body: unknown) {
    return {
      data: locationResponse(await this.probes.createLocation(request.watchrailContext, body)),
    };
  }

  @Get()
  async list(@Req() request: RequestWithContext) {
    return {
      data: (await this.probes.listLocations(request.watchrailContext)).map(locationResponse),
    };
  }

  @Patch(':locationId/status')
  async setStatus(
    @Req() request: RequestWithContext,
    @Param('locationId', ParseUUIDPipe) locationId: string,
    @Body() body: unknown,
  ) {
    return {
      data: locationResponse(
        await this.probes.setLocationStatus(request.watchrailContext, locationId, body),
      ),
    };
  }

  @Post(':locationId/enrollments')
  @Header('Cache-Control', 'no-store')
  async issueEnrollment(
    @Req() request: RequestWithContext,
    @Param('locationId', ParseUUIDPipe) locationId: string,
    @Body() body: unknown,
  ) {
    const issued = await this.probes.issueEnrollment(request.watchrailContext, locationId, body);
    return {
      data: {
        id: issued.enrollment.id,
        locationId: issued.enrollment.locationId,
        agentName: issued.enrollment.agentName,
        expiresAt: issued.enrollment.expiresAt.toISOString(),
        token: issued.token,
      },
    };
  }
}

@Controller('probe-enrollments')
export class ProbeEnrollmentsController {
  constructor(@Inject(ProbeIdentityService) private readonly probes: ProbeIdentityService) {}

  @Post(':enrollmentId/revoke')
  @HttpCode(204)
  async revoke(
    @Req() request: RequestWithContext,
    @Param('enrollmentId', ParseUUIDPipe) enrollmentId: string,
  ) {
    await this.probes.revokeEnrollment(request.watchrailContext, enrollmentId);
  }
}

@Controller('probe-agents')
export class ProbeAgentsController {
  constructor(@Inject(ProbeIdentityService) private readonly probes: ProbeIdentityService) {}

  @Get()
  async list(@Req() request: RequestWithContext) {
    return { data: (await this.probes.listAgents(request.watchrailContext)).map(agentResponse) };
  }

  @Post(':agentId/revoke')
  @HttpCode(204)
  async revoke(
    @Req() request: RequestWithContext,
    @Param('agentId', ParseUUIDPipe) agentId: string,
  ) {
    await this.probes.revokeAgent(request.watchrailContext, agentId);
  }
}

@Controller('probe-machine')
export class ProbeMachineController {
  constructor(@Inject(ProbeIdentityService) private readonly probes: ProbeIdentityService) {}

  @Post('enroll')
  async enroll(@Body() body: unknown) {
    const enrolled = await this.probes.enroll(body);
    return { data: { ...machineResponse(enrolled.identity), credential: enrolled.credential } };
  }

  @Get('me')
  @UseGuards(ProbeMachineAuthGuard)
  me(@Req() request: ProbeMachineRequest) {
    return { data: machineResponse(request.probeMachineIdentity) };
  }

  @Post('credentials/rotate')
  @UseGuards(ProbeMachineAuthGuard)
  async rotate(@Req() request: ProbeMachineRequest) {
    const rotated = await this.probes.rotate(request.probeMachineIdentity);
    return { data: { ...machineResponse(rotated.identity), credential: rotated.credential } };
  }
}

function locationResponse(location: ProbeLocationRecord) {
  return {
    id: location.id,
    name: location.name,
    slug: location.slug,
    status: location.status,
    createdAt: location.createdAt.toISOString(),
    updatedAt: location.updatedAt.toISOString(),
  };
}

function agentResponse(agent: ProbeAgentRecord) {
  return {
    id: agent.id,
    locationId: agent.locationId,
    name: agent.name,
    status: agent.status,
    lastHeartbeatAt: agent.lastHeartbeatAt?.toISOString() ?? null,
    engineVersion: agent.engineVersion,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
  };
}

function machineResponse(identity: ProbeMachineRequest['probeMachineIdentity']) {
  return {
    agentId: identity.agentId,
    organizationId: identity.organizationId,
    locationId: identity.locationId,
    credentialVersion: identity.credentialVersion,
  };
}
