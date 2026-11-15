export interface Project {
  id: string;
  name: string;
  overview: string;
  created_at: string;
  updated_at: string;
  revision: number;
  summary_status: 'empty' | 'pending' | 'ready' | 'failed';
  summary_updated_at?: string | null;
  summary_error?: string | null;
}
export interface ProjectThread { id: string; title: string | null; created_at: string }
export interface ProjectList { items: Project[]; has_more: boolean; after: string | null; member_id: string }
export interface ProjectThreads { items: ProjectThread[]; has_more: boolean; after: string | null }
export interface ProjectOverview { project: Project; threads: ProjectThreads; member_id: string; threads_error: string }
