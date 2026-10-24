import type { Monitor, CurrentCheck } from './types';

export function formatPercent(value: number | null | undefined): string {
  return value == null ? '—' : `${value.toFixed(2)}%`;
}


export function statusPolicyLabel(policy: Monitor['statusPolicy']): string {
  return policy.type === 'ANY_2XX' ? 'any 2xx' : `status ${policy.statusCodes.join(', ')}`;
}

export function statusPolicyFromForm(formData: FormData): Monitor['statusPolicy'] {
  if (formData.get('statusPolicyMode') !== 'EXACT') return { type: 'ANY_2XX' };

  const rawCodes = formData.get('statusCodes');
  const codes = typeof rawCodes === 'string' ? rawCodes : '';
  return {
    type: 'EXACT',
    statusCodes: codes.split(',').map((value) => Number(value.trim())),
  };
}


export function formatRatio(value: { numerator: number; denominator: number } | null): string {
  if (!value || value.denominator === 0) return '—';
  return `${((value.numerator / value.denominator) * 100).toFixed(1)}%`;
}

export function formatMilliseconds(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)} ms`;
}

export function humanize(value: string): string {
  return value.toLowerCase().replaceAll('_', ' ');
}

export function monitorState(check: CurrentCheck | null): 'awaiting' | 'pass' | 'fail' | 'unknown' {
  if (!check) return 'awaiting';
  if (check.availability === 'AVAILABLE') return 'pass';
  if (check.availability === 'UNAVAILABLE') return 'fail';
  return 'unknown';
}

export function monitorStateLabel(check: CurrentCheck | null): string {
  if (!check) return 'No completed check';
  if (check.aggregateOutcome)
    return `Current aggregate health: ${check.aggregateOutcome.toLowerCase()}`;
  return `Current availability: ${check.availability.toLowerCase()}`;
}

