import { createHash } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  parseHeartbeatSignal,
  redactHeartbeatSignal,
  HeartbeatSignalInputError,
} from '@watchrail/domain';
import {
  HeartbeatCredentialNotFoundError,
  HeartbeatRepository,
  type HeartbeatSignalReceipt,
} from '@watchrail/db';

@Injectable()
export class HeartbeatsService {
  constructor(@Inject(HeartbeatRepository) private readonly heartbeats: HeartbeatRepository) {}

  async receive(token: string, body: unknown): Promise<HeartbeatSignalReceipt> {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) throw heartbeatNotFound();
    try {
      const signal = redactHeartbeatSignal(parseHeartbeatSignal(body));
      const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
      return await this.heartbeats.recordSignal(tokenHash, signal);
    } catch (error) {
      if (error instanceof HeartbeatSignalInputError) {
        throw new BadRequestException({
          code: 'INVALID_HEARTBEAT_SIGNAL',
          message: error.message,
          issues: error.issues,
        });
      }
      if (error instanceof HeartbeatCredentialNotFoundError) throw heartbeatNotFound();
      throw error;
    }
  }
}

function heartbeatNotFound(): NotFoundException {
  return new NotFoundException({
    code: 'HEARTBEAT_NOT_FOUND',
    message: 'Heartbeat endpoint not found.',
  });
}
