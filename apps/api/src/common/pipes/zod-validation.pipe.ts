import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

export class ZodValidationPipe<TSchema extends z.ZodType> implements PipeTransform<
  unknown,
  z.output<TSchema>
> {
  constructor(
    private readonly schema: TSchema,
    private readonly field = 'request',
    private readonly fieldForIssue?: (issue: { readonly path: PropertyKey[] }) => string,
  ) {}

  transform(value: unknown): z.output<TSchema> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    const fields: Record<string, string[]> = {};
    for (const issue of result.error.issues) {
      const field = this.fieldForIssue?.(issue) ?? this.field;
      const path = issue.path.join('.');
      (fields[field] ??= []).push(path ? `${path}: ${issue.message}` : issue.message);
    }

    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'Request validation failed.',
      fields,
    });
  }
}
