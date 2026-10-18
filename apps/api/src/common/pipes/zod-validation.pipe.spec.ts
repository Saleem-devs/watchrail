import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { ZodValidationPipe } from './zod-validation.pipe.js';

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(z.object({ name: z.string() }).strict(), 'example');

  it('returns the parsed value', () => {
    expect(pipe.transform({ name: 'Watchrail' })).toEqual({ name: 'Watchrail' });
  });

  it('returns a stable validation error without exposing parser internals', () => {
    expect(() => pipe.transform({ name: 'Watchrail', unexpected: true })).toThrowError(
      BadRequestException,
    );

    try {
      pipe.transform({ name: 42 });
    } catch (error) {
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed.',
        fields: {
          example: [{ path: 'name', message: expect.any(String) }],
        },
      });
    }
  });
});
