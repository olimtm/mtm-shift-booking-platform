import { useEffect, useRef, type ReactNode } from 'react';
import { X, Check, Clock3, Ban, AlertCircle, LoaderCircle, ArrowUpRight } from 'lucide-react';
import type { Participant, Shift, SupportType } from '../shared/types';

export const supportLabels: Record<SupportType, string> = {
  general: 'General support',
  events: 'Event support',
  both: 'General + events',
  none: 'No regular support',
};
export function Avatar({
  name,
  color = 'sage',
  small = false,
}: {
  name: string;
  color?: string;
  small?: boolean;
}) {
  return (
    <span className={`avatar avatar-${color} ${small ? 'avatar-small' : ''}`} aria-hidden="true">
      {name
        .split(' ')
        .map((s) => s[0])
        .slice(0, 2)
        .join('')}
    </span>
  );
}
export function Status({ shift }: { shift: Shift }) {
  const label = shift.pendingChange
    ? 'Change requested'
    : (
        {
          requested: 'Awaiting approval',
          confirmed: 'Confirmed',
          declined: 'Declined',
          cancelled: 'Cancelled',
        } as const
      )[shift.status];
  const Icon =
    shift.pendingChange || shift.status === 'requested'
      ? Clock3
      : shift.status === 'confirmed'
        ? Check
        : Ban;
  return (
    <span className={`status status-${shift.pendingChange ? 'requested' : shift.status}`}>
      <Icon size={16} />
      {label}
    </span>
  );
}
export function ParticipantName({ participant }: { participant: Participant | undefined }) {
  return (
    <span className="person-cell">
      <Avatar name={participant?.name || 'Unknown participant'} color={participant?.color} small />
      <span>{participant?.name || 'Unknown participant'}</span>
    </span>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-symbol">
        <Check size={25} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Spinner() {
  return <LoaderCircle size={17} className="spin" aria-hidden="true" />;
}
export function ErrorNotice({ children }: { children: ReactNode }) {
  return (
    <div className="error-notice" role="alert">
      <AlertCircle size={17} />
      <span>{children}</span>
    </div>
  );
}
export function TextLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button className="text-link" onClick={onClick}>
      {children}
      <ArrowUpRight size={15} />
    </button>
  );
}
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
      if (event.key !== 'Tab' || !ref.current) return;
      const nodes = [
        ...ref.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]',
        ),
      ];
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === ref.current)
      ) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.body.style.overflow = originalOverflow;
      document.removeEventListener('keydown', handler);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? 'modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabIndex={-1}
        ref={ref}
      >
        <header className="modal-header">
          <div>
            <h2 id="modal-title">{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
