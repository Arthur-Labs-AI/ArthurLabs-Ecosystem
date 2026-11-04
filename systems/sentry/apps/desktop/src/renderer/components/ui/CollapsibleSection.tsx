import React from 'react';
import { ChevronRight } from 'lucide-react';

export function CollapsibleSection({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(defaultOpen ?? false);
  return (
    <div>
      <button className="collapsible-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <ChevronRight className="disclosure-icon" size={14} aria-hidden="true" /> {title}
      </button>
      {open ? <div>{children}</div> : null}
    </div>
  );
}
