import { describe, expect, it } from 'vitest';
import {
  InvalidProbeCoordinatorContractError,
  parseProbeLeaseReference,
  parseProbeResultSubmissionReference,
} from './probe-coordinator.js';

const assignmentId = '11111111-1111-4111-8111-111111111111';
const attemptId = '22222222-2222-4222-8222-222222222222';
const configurationVersionId = '33333333-3333-4333-8333-333333333333';
const organizationId = '44444444-4444-4444-8444-444444444444';
const locationId = '55555555-5555-4555-8555-555555555555';
const claimToken = 'A'.repeat(43);

describe('probe coordinator contracts', () => {
  it('parses the immutable lease identity and compatibility versions', () => {
    expect(
      parseProbeLeaseReference({
        contractVersion: 1,
        organizationId,
        locationId,
        assignmentId,
        attemptId,
        attemptNumber: 2,
        claimToken,
        configurationVersionId,
        configurationVersionNumber: 7,
        executionPolicyVersion: 'http-v1',
        requiredEngineVersion: 'watchrail-http-v1',
        leaseExpiresAt: '2026-10-12T10:00:00.000Z',
      }),
    ).toMatchObject({ attemptId, attemptNumber: 2, configurationVersionNumber: 7 });
  });

  it('rejects expired-shape ambiguity and unknown fields', () => {
    expect(() =>
      parseProbeLeaseReference({
        contractVersion: 1,
        organizationId,
        locationId,
        assignmentId,
        attemptId,
        attemptNumber: 0,
        claimToken,
        configurationVersionId,
        configurationVersionNumber: 7,
        executionPolicyVersion: 'http-v1',
        requiredEngineVersion: 'watchrail-http-v1',
        leaseExpiresAt: 'not-a-time',
      }),
    ).toThrow(InvalidProbeCoordinatorContractError);
  });

  it('parses a result reference without accepting a claim secret in the body', () => {
    expect(
      parseProbeResultSubmissionReference({
        contractVersion: 1,
        assignmentId,
        attemptId,
        attemptNumber: 2,
        engineVersion: 'watchrail-http-v1',
      }),
    ).toEqual({
      contractVersion: 1,
      assignmentId,
      attemptId,
      attemptNumber: 2,
      engineVersion: 'watchrail-http-v1',
    });
  });
});
