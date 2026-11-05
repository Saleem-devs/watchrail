import { WebhookChannelFormPage } from '../../../../../../features/notifications/webhook-channel-form';

export default async function EditWebhookChannelPage({
  params,
}: {
  params: Promise<{ projectId: string; endpointId: string }>;
}) {
  const { projectId, endpointId } = await params;
  return <WebhookChannelFormPage projectId={projectId} endpointId={endpointId} />;
}
