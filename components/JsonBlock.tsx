"use client";

/** Collapsible monospace JSON viewer for tool inputs/outputs. */
export function JsonBlock({
  label,
  value,
}: {
  label: string;
  value: unknown;
}) {
  return (
    <details className="group">
      <summary className="cursor-pointer text-xs text-slate-500 select-none hover:text-slate-700">
        {label}
      </summary>
      <pre className="mt-1 max-h-64 overflow-auto rounded border border-slate-200 bg-slate-50 p-2 font-mono text-xs whitespace-pre-wrap break-all">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}
