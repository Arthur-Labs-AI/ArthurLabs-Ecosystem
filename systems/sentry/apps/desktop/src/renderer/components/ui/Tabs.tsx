import React from 'react';

export function Tabs({
  tabs,
  active,
  onChange,
  label,
}: {
  tabs: ReadonlyArray<{ id: string; label: string }>;
  active: string;
  onChange: (id: string) => void;
  label?: string;
}): React.JSX.Element {
  return (
    <div className="tabs" role="tablist" aria-label={label ?? 'Sections'}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={tab.id === active}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function SegmentedControl({
  options,
  value,
  onChange,
  label,
}: {
  options: ReadonlyArray<{ value: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
  label?: string;
}): React.JSX.Element {
  return (
    <div className="segmented" role="group" aria-label={label ?? 'Options'}>
      {options.map((option) => (
        <button
          key={option.value}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
