import React from 'react';

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="empty" role="status">
      <strong>{title}</strong>
      {body !== undefined ? <span>{body}</span> : null}
      {action}
    </div>
  );
}
