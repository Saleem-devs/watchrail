export interface WorkspaceStatusPage {
  id: string;
  name: string;
  slug: string;
  published: boolean;
  components: Array<{ id: string; displayName: string; monitorId: string; position: number }>;
  createdAt: string;
  updatedAt: string;
}
