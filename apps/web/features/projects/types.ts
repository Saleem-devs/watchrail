export interface WorkspaceProject {
  id: string;
  name: string;
  slug: string;
  monitorCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectApiError {
  message?: string;
  fields?: { name?: string[]; slug?: string[] };
}
