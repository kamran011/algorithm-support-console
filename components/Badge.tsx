const STYLES: Record<string, string> = {
  green: "bg-green-100 text-green-800 border-green-300",
  amber: "bg-amber-100 text-amber-800 border-amber-300",
  red: "bg-red-100 text-red-800 border-red-300",
  gray: "bg-slate-100 text-slate-600 border-slate-300",
  blue: "bg-blue-100 text-blue-800 border-blue-300",
};

export function Badge({
  color,
  children,
}: {
  color: keyof typeof STYLES;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${STYLES[color]}`}
    >
      {children}
    </span>
  );
}

/** Maps an action/run state to the queue's decision badge. */
export function decisionBadge(
  actionStatus: string | null,
  runStatus: string | null
): { color: keyof typeof STYLES; label: string } {
  if (runStatus === "running") return { color: "gray", label: "processing" };
  if (runStatus === "failed" && !actionStatus)
    return { color: "red", label: "run failed" };
  switch (actionStatus) {
    case "auto_executed":
      return { color: "green", label: "auto-executed" };
    case "executed":
      return { color: "green", label: "approved & executed" };
    case "pending_review":
      return { color: "amber", label: "escalated" };
    case "failed":
      return { color: "red", label: "failed" };
    case "rejected":
      return { color: "gray", label: "rejected" };
    case "approved":
      return { color: "blue", label: "approved" };
    default:
      return { color: "gray", label: "no action" };
  }
}
