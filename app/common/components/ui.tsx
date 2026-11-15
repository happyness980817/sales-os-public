import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X, CircleAlert } from 'lucide-react';

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  return <dialog ref={ref} aria-labelledby={headingId} className="modal" onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="modal-heading"><h2 id={headingId}>{title}</h2><button className="icon-button" aria-label="닫기" onClick={onClose}><X size={20}/></button></div>{children}
  </dialog>;
}

export function Notice({ children, error = false, action }: { children: ReactNode; error?: boolean; action?: ReactNode }) {
  return <div className={`notice${error ? ' notice-error' : ''}`} role={error ? 'alert' : 'status'}><CircleAlert size={16}/><span>{children}</span>{action}</div>;
}

export function Empty({ icon, title, children, action }: { icon: ReactNode; title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><h2>{title}</h2><p>{children}</p>{action}</div>;
}
