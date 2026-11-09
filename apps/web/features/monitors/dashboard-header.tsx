import Link from 'next/link';
import type { ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { actionClassName } from '../../components/ui/button';
import { PageHeader } from '../../components/ui/page-header';
import {
  createMonitorTypePath,
  monitorTypeDefinition,
  monitorTypePath,
  type MonitorType,
} from './monitor-types';
import { CreateMonitorMenu } from './create-monitor-menu';

const copy = {
  overview: {
    title: 'Project overview',
    description: 'Review this project’s health, performance, and services that need attention.',
  },
  monitors: {
    title: 'Monitors',
    description: 'Search and manage every monitored service in this project.',
  },
  create: {
    title: 'Create monitor',
    description:
      'Add an HTTP endpoint, TCP service, ping target, DNS record, API workflow, heartbeat, or domain expiry check.',
  },
} as const;

export function DashboardHeader({
  view = 'overview',
  actions,
  basePath = '',
  monitorType,
  createMonitorType,
}: {
  view?: keyof typeof copy;
  actions?: ReactNode;
  basePath?: string;
  monitorType?: MonitorType | undefined;
  createMonitorType?: MonitorType | undefined;
}) {
  const projectId = basePath.split('/').filter(Boolean).at(-1);
  const definition = monitorType ? monitorTypeDefinition(monitorType) : undefined;
  const createDefinition = createMonitorType ? monitorTypeDefinition(createMonitorType) : undefined;
  const content =
    view === 'monitors' && definition
      ? {
          title: `${definition.label} monitors`,
          description: definition.description,
        }
      : view === 'create' && createDefinition
        ? {
            title: `Create ${createDefinition.singular}`,
            description: createDefinition.createDescription,
          }
        : copy[view];
  const defaultActions =
    view !== 'create' && projectId && !monitorType ? (
      <CreateMonitorMenu projectId={projectId} />
    ) : view !== 'create' ? (
      <Link
        href={
          projectId && monitorType
            ? createMonitorTypePath(projectId, monitorType)
            : `${basePath}/monitors/new`
        }
        className={actionClassName({ variant: 'primary', className: 'px-5' })}
      >
        <Plus className="size-4" strokeWidth={1.75} aria-hidden="true" />
        {definition ? `Add ${definition.singular}` : 'Add monitor'}
      </Link>
    ) : null;
  return (
    <PageHeader
      title={content.title}
      description={content.description}
      backLink={
        view === 'create'
          ? {
              href:
                projectId && createMonitorType
                  ? monitorTypePath(projectId, createMonitorType)
                  : `${basePath}/monitors`,
              label: createDefinition ? `Back to ${createDefinition.label}` : 'Back to monitors',
            }
          : undefined
      }
      actions={actions ?? defaultActions}
    />
  );
}
