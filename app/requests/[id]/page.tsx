"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Badge, decisionBadge } from "@/components/Badge";
import { JsonBlock } from "@/components/JsonBlock";
import { formatCents, formatTimestamp } from "@/lib/format";

type Detail = {
  request: {
    id: number;
    customerId: number;
    customerName: string;
    customerEmail: string;
    message: string;
    status: string;
    createdAt: string;
  };
  run: {
    id: number;
    status: string;
    reasoningSummary: string | null;
    startedAt: string;
    completedAt: string | null;
  } | null;
  toolCalls: {
    id: number;
    seq: number;
    toolName: string;
    input: unknown;
    output: unknown;
    createdAt: string;
  }[];
  action: {
    id: number;
    type: string;
    status: string;
    params: { amount_cents?: number; reasoning?: string };
    riskReason: string | null;
    decidedBy: string | null;
    decidedAt: string | null;
    executedAt: string | null;
    failureReason: string | null;
    orderId: number | null;
  } | null;
  order: {
    id: number;
    customerId: number;
    customerName: string;
    status: string;
    totalAmountCents: number;
    amountRefundedCents: number;
    createdAt: string;
  } | null;
  refunds: {
    id: number;
    amountCents: number;
    status: string;
    createdAt: string;
  }[];
};

export default function RequestDetailPage() {
  const params = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [reviewer, setReviewer] = useState("");
  const [conflict, setConflict] = useState<string | null>(null);

  useEffect(() => {
    setReviewer(localStorage.getItem("reviewerName") ?? "");
  }, []);

  const detail = useQuery({
    queryKey: ["request", params.id],
    queryFn: async () => {
      const res = await fetch(`/api/requests/${params.id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<Detail>;
    },
  });

  const decide = useMutation({
    mutationFn: async (verb: "approve" | "reject") => {
      const actionId = detail.data?.action?.id;
      const res = await fetch(`/api/actions/${actionId}/${verb}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewer }),
      });
      const body = await res.json();
      if (res.status === 409) {
        // Someone else decided first. Honest concurrent state: show who,
        // then refetch so the page reflects reality.
        throw Object.assign(new Error(body.error), { conflict: true });
      }
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      return body;
    },
    onSuccess: () => setConflict(null),
    onError: (err) => {
      if ((err as { conflict?: boolean }).conflict) setConflict(err.message);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["request", params.id] });
      queryClient.invalidateQueries({ queryKey: ["requests"] });
    },
  });

  if (detail.isLoading) {
    return <p className="text-slate-400">Loading request…</p>;
  }
  if (detail.isError || !detail.data) {
    return (
      <p className="text-red-600">
        Failed to load request. <Link href="/" className="underline">Back to queue</Link>
      </p>
    );
  }

  const { request, run, toolCalls, action, order, refunds } = detail.data;
  const badge = decisionBadge(action?.status ?? null, run?.status ?? null);
  const canDecide = action?.status === "pending_review";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Link href="/" className="text-sm text-slate-500 hover:underline">
          ← Back to queue
        </Link>
        <Badge color={badge.color}>{badge.label}</Badge>
      </div>

      {conflict && (
        <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {conflict} — the view has been refreshed with the current state.
        </div>
      )}

      {/* Request */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="mb-1 flex items-baseline justify-between">
          <h1 className="font-semibold">
            Request <span className="font-mono">#{request.id}</span>
          </h1>
          <span className="text-xs text-slate-400">
            {formatTimestamp(request.createdAt)}
          </span>
        </div>
        <p className="text-sm text-slate-500">
          {request.customerName} ({request.customerEmail}) — customer{" "}
          <span className="font-mono">#{request.customerId}</span>
        </p>
        <p className="mt-3 rounded bg-slate-50 p-3 text-sm">{request.message}</p>
      </section>

      {/* Agent reasoning */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-600 uppercase tracking-wide">
          Agent reasoning{" "}
          {run?.status === "failed" && <Badge color="red">run failed</Badge>}
        </h2>
        {run ? (
          run.reasoningSummary ? (
            <div className="text-sm [&>p]:mb-2 [&>ul]:mb-2 [&>ul]:list-disc [&>ul]:pl-4 [&>ol]:mb-2 [&>ol]:list-decimal [&>ol]:pl-4 [&>h1]:font-semibold [&>h2]:font-semibold [&>h3]:font-semibold">
              <ReactMarkdown>{run.reasoningSummary}</ReactMarkdown>
            </div>
          ) : (
            <p className="text-sm text-slate-400">(no summary produced)</p>
          )
        ) : (
          <p className="text-sm text-slate-400">No agent run recorded.</p>
        )}
      </section>

      {/* Tool call timeline */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-600 uppercase tracking-wide">
          Tool calls ({toolCalls.length})
        </h2>
        {toolCalls.length === 0 && (
          <p className="text-sm text-slate-400">No tool calls recorded.</p>
        )}
        <ol className="space-y-3">
          {toolCalls.map((tc) => (
            <li key={tc.id} className="rounded border border-slate-200 p-3">
              <div className="mb-1 flex items-center gap-2">
                <span className="font-mono text-xs text-slate-400">
                  {tc.seq}.
                </span>
                <span className="font-mono text-sm font-medium">
                  {tc.toolName}
                </span>
                <span className="ml-auto text-xs text-slate-400">
                  {formatTimestamp(tc.createdAt)}
                </span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <JsonBlock label="input" value={tc.input} />
                <JsonBlock label="output" value={tc.output} />
              </div>
            </li>
          ))}
        </ol>
      </section>

      <div className="grid gap-6 sm:grid-cols-2">
        {/* Order card */}
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold text-slate-600 uppercase tracking-wide">
            Order
          </h2>
          {order ? (
            <dl className="space-y-1 text-sm">
              <Row label="Order">
                <span className="font-mono">#{order.id}</span>
              </Row>
              <Row label="Customer">
                {order.customerName}{" "}
                <span className="font-mono text-xs text-slate-400">
                  #{order.customerId}
                </span>
              </Row>
              <Row label="Status">
                <Badge color={order.status === "cancelled" || order.status === "refunded" ? "gray" : "blue"}>
                  {order.status}
                </Badge>
              </Row>
              <Row label="Total">{formatCents(order.totalAmountCents)}</Row>
              <Row label="Refunded so far">
                {formatCents(order.amountRefundedCents)}
              </Row>
              {refunds.length > 0 && (
                <Row label="Refund rows">
                  <span className="font-mono text-xs">
                    {refunds
                      .map((r) => `${formatCents(r.amountCents)} (#${r.id})`)
                      .join(", ")}
                  </span>
                </Row>
              )}
            </dl>
          ) : (
            <p className="text-sm text-slate-400">
              No order attached to this request.
            </p>
          )}
        </section>

        {/* Proposed action card */}
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold text-slate-600 uppercase tracking-wide">
            Proposed action
          </h2>
          {action ? (
            <div className="space-y-2 text-sm">
              <dl className="space-y-1">
                <Row label="Type">
                  <span className="font-mono">{action.type}</span>
                </Row>
                {action.params.amount_cents !== undefined && (
                  <Row label="Amount">
                    {formatCents(action.params.amount_cents)}
                  </Row>
                )}
                <Row label="Status">
                  <Badge color={badge.color}>{action.status}</Badge>
                </Row>
                {action.riskReason && (
                  <Row label="Risk reason">{action.riskReason}</Row>
                )}
                {action.failureReason && (
                  <Row label="Failure">
                    <span className="text-red-700">{action.failureReason}</span>
                  </Row>
                )}
                {action.decidedBy && (
                  <Row label="Decided by">
                    {action.decidedBy} at {formatTimestamp(action.decidedAt)}
                  </Row>
                )}
                {action.executedAt && (
                  <Row label="Executed">{formatTimestamp(action.executedAt)}</Row>
                )}
              </dl>

              {canDecide && (
                <div className="border-t border-slate-100 pt-3">
                  <label className="mb-2 block text-xs text-slate-500">
                    Reviewer name
                    <input
                      value={reviewer}
                      onChange={(e) => {
                        setReviewer(e.target.value);
                        localStorage.setItem("reviewerName", e.target.value);
                      }}
                      placeholder="Your name"
                      className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
                    />
                  </label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => decide.mutate("approve")}
                      disabled={decide.isPending || !reviewer.trim()}
                      className="rounded bg-green-700 px-4 py-2 text-sm font-medium text-white hover:bg-green-600 disabled:opacity-50"
                    >
                      {decide.isPending ? "Working…" : "Approve & execute"}
                    </button>
                    <button
                      onClick={() => decide.mutate("reject")}
                      disabled={decide.isPending || !reviewer.trim()}
                      className="rounded bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
                    >
                      Reject
                    </button>
                  </div>
                  {decide.isError &&
                    !(decide.error as { conflict?: boolean }).conflict && (
                      <p className="mt-2 text-xs text-red-600">
                        {(decide.error as Error).message}
                      </p>
                    )}
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-slate-400">
              The agent did not propose an action for this request.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}
