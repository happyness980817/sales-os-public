import { CalendarDays, FileSpreadsheet, FolderOpen, Mail, MessageCircle, MessagesSquare, Monitor, NotebookPen, type LucideIcon } from 'lucide-react';

const serviceIcons: Record<string, LucideIcon> = {
  google_drive: FolderOpen, gmail: Mail, google_sheets: FileSpreadsheet,
  google_chat: MessagesSquare, google_calendar: CalendarDays, notion: NotebookPen,
  line: MessageCircle, local_files: Monitor,
};

export function ServiceIcon({ provider }: { provider: string }) {
  const Icon = serviceIcons[provider] || FolderOpen;
  return <span className="service-icon service-icon-local" aria-hidden="true"><Icon size={23} strokeWidth={1.6}/></span>;
}

export function BrandMark({ small = false }: { small?: boolean }) {
  return <svg className={small ? 'brand-mark small' : 'brand-mark'} viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M23 7H13a5 5 0 0 0 0 10h6a4 4 0 0 1 0 8H8M8 25h11a5 5 0 0 0 0-10h-6a4 4 0 0 1 0-8h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>;
}
