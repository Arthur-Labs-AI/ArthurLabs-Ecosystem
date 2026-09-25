import React from 'react';

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
      <button
        className="collapsible-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span aria-hidden="true">{open ? '\u25BE' : '\u25B8'}</span> {title}
      </button>
      {open ? <div>{children}</div> : null}
    </div>
  );
}
