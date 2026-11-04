import React from 'react';
import { StatusLabel } from './StatusGlyph.js';

export function EdgeInspector({
  edge,
}: {
  edge: { source: string; target: string };
}): React.JSX.Element {
  return (
    <div>
      <h3 style={{ marginTop: 0 }}>Edge</h3>
      <p className="mono muted">
        {edge.source} → {edge.target}
      </p>
      {(edge.source === 'snapshot' || edge.source === 'target') &&
      edge.target.startsWith('agent-') ? (
        <p className="muted">
          This agent investigates the immutable snapshot independently and keeps its own findings
          and evidence.
        </p>
      ) : null}
    </div>
  );
}

export function NodeStatusHeader({
  label,
  status,
}: {
  label: string;
  status: string;
}): React.JSX.Element {
  return (
    <div>
      <h3 style={{ marginTop: 0 }}>{label}</h3>
      <p className="muted">
        <StatusLabel status={status} />
      </p>
    </div>
  );
}
