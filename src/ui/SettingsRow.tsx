import type { ReactNode } from 'react';

/** A setting: its name on the left, its controls beside it. */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-1 py-1">
      <span className="w-24 shrink-0 text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</span>
      <div className="flex flex-wrap items-center gap-1">{children}</div>
    </div>
  );
}

/** An on/off setting: a checkbox with the switch role, and what it switches. */
export function Switch({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800">
      <input
        type="checkbox"
        role="switch"
        className="h-4 w-4 accent-blue-600"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {children}
    </label>
  );
}
