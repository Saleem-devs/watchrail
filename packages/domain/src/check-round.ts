export const CHECK_ROUND_TRIGGERS = ['MANUAL'] as const;
export const CHECK_ROUND_STATUSES = ['PENDING', 'COMPLETED'] as const;
export const EXECUTION_ASSIGNMENT_STATUSES = ['PENDING', 'RUNNING', 'COMPLETED'] as const;

export type CheckRoundTrigger = (typeof CHECK_ROUND_TRIGGERS)[number];
export type CheckRoundStatus = (typeof CHECK_ROUND_STATUSES)[number];
export type ExecutionAssignmentStatus = (typeof EXECUTION_ASSIGNMENT_STATUSES)[number];
