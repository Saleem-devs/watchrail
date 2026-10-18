import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

export class ZodValidationPipe<TSchema extends z.ZodType> implements PipeTransform<
  unknown,
  z.output<TSchema>
> {
  constructor(
    private readonly schema: TSchema,
    private readonly field = 'request',
  ) {}

  transform(value: unknown): z.output<TSchema> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'Request validation failed.',
      fields: {
        [this.field]: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
  }
}
