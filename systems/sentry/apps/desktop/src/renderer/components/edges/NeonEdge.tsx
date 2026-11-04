import React from 'react';
import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react';
import { useReducedMotion } from '../../lib/use-reduced-motion.js';

export type NeonEdgeState = 'pending' | 'active' | 'completed' | 'blocked' | 'failed';

const STATE_COLORS: Record<NeonEdgeState, string> = {
  completed: 'var(--success)',
  active: 'var(--running)',
  failed: 'var(--danger)',
  blocked: 'var(--cancelled)',
  pending: 'var(--border-strong)',
};

function colorFor(state: string | undefined): string {
  if (state !== undefined && state in STATE_COLORS) {
    return STATE_COLORS[state as NeonEdgeState];
  }
  return STATE_COLORS.pending;
}

/**
 * Command-deck connection line: a soft base path, an animated dash stream
 * while work flows (active), and a traveling energy pulse. Edge geometry
 * comes from React Flow on every render, so lines follow dragged nodes
 * with zero extra bookkeeping. Motion is inert under reduced-motion.
 */
export function NeonEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps): React.JSX.Element {
  const reducedMotion = useReducedMotion();
  const state = (data as { state?: string } | undefined)?.state;
  const color = colorFor(state);
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const active = state === 'active';
  return (
    <g className={'neon-edge' + (selected === true ? ' selected' : '')} color={color}>
      <BaseEdge
        id={id}
        path={path}
        className="neon-edge-base"
        style={{
          stroke: color,
          strokeWidth: selected === true ? 2.2 : 1.6,
          strokeOpacity: state === 'pending' ? 0.4 : 0.62,
          ...(state === 'pending' || state === 'blocked'
            ? { strokeDasharray: '3 7', strokeLinecap: 'round' as const }
            : null),
        }}
      />
      {active ? (
        <path
          d={path}
          fill="none"
          className="neon-edge-flow"
          stroke={color}
          strokeWidth={1.6}
          strokeLinecap="round"
          pointerEvents="none"
        />
      ) : null}
      {active ? (
        <path
          d={path}
          fill="none"
          stroke={color}
          strokeWidth={4.5}
          strokeOpacity={0.14}
          strokeLinecap="round"
          pointerEvents="none"
        />
      ) : null}
      {active && !reducedMotion ? (
        <circle r={2.6} fill={color} opacity={0.95} pointerEvents="none">
          <animateMotion dur="2.2s" repeatCount="indefinite" path={path} />
        </circle>
      ) : null}
    </g>
  );
}
