"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, decisionBadge } from "@/components/Badge";
import { formatTimestamp } from "@/lib/format";

type QueueRow = {
  id: number;
  customerId: number;
  customerName: string;
  message: string;
  status: string;
  createdAt: string;
  latestAction: {
    id: number;
    status: string;
    type: string;
    riskReason: string | null;
  } | null;
  latestRun: { id: number; status: string } | null;
};

type Customer = { id: number; name: string; email: string };

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return res.json();
}

export default function QueuePage() {
  const router = useRouter();
  const queue = useQuery({
    queryKey: ["requests"],
    queryFn: () => fetchJson<{ requests: QueueRow[] }>("/api/requests"),
  });

  return (
    <div className="space-y-6">
      <NewRequestForm />

      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-600 uppercase tracking-wide">
          Support queue
        </h2>
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                <th className="px-3 py-2 font-medium">Message</th>
                <th className="px-3 py-2 font-medium">Customer</th>
                <th className="px-3 py-2 font-medium">Agent decision</th>
                <th className="px-3 py-2 font-medium">Risk reason</th>
                <th className="px-3 py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {queue.isLoading && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-slate-400">
                    Loading queue…
                  </td>
                </tr>
              )}
              {queue.data?.requests.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-slate-400">
                    No support requests yet — submit one above.
                  </td>
                </tr>
              )}
              {queue.data?.requests.map((r) => {
                const badge = decisionBadge(
                  r.latestAction?.status ?? null,
                  r.latestRun?.status ?? null
                );
                return (
                  <tr
                    key={r.id}
                    onClick={() => router.push(`/requests/${r.id}`)}
                    className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
                  >
                    <td className="max-w-md truncate px-3 py-2" title={r.message}>
                      <span className="mr-2 font-mono text-xs text-slate-400">
                        #{r.id}
                      </span>
                      {r.message}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{r.customerName}</td>
                    <td className="px-3 py-2">
                      <Badge color={badge.color}>{badge.label}</Badge>
                    </td>
                    <td
                      className="max-w-xs truncate px-3 py-2 text-xs text-slate-500"
                      title={r.latestAction?.riskReason ?? undefined}
                    >
                      {r.latestAction?.riskReason ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-xs whitespace-nowrap text-slate-500">
                      {formatTimestamp(r.createdAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function NewRequestForm() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [customerId, setCustomerId] = useState<string>("");
  const [message, setMessage] = useState("");

  const customers = useQuery({
    queryKey: ["customers"],
    queryFn: () => fetchJson<{ customers: Customer[] }>("/api/customers"),
    refetchInterval: false,
  });

  const submit = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customer_id: Number(customerId),
          message,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      return body as { request: { id: number } };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["requests"] });
      setMessage("");
      router.push(`/requests/${data.request.id}`);
    },
  });

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold text-slate-600 uppercase tracking-wide">
        New support request
      </h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (customerId && message.trim()) submit.mutate();
        }}
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
      >
        <select
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
          required
          className="rounded border border-slate-300 bg-white px-2 py-2 text-sm"
        >
          <option value="">Select customer…</option>
          {customers.data?.customers.map((c) => (
            <option key={c.id} value={c.id}>
              #{c.id} {c.name}
            </option>
          ))}
        </select>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          required
          rows={2}
          placeholder='e.g. "Order 1004 arrived damaged, I want a refund"'
          className="flex-1 rounded border border-slate-300 px-2 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={submit.isPending || !customerId || !message.trim()}
          className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {submit.isPending ? "Agent working…" : "Submit"}
        </button>
      </form>
      {submit.isPending && (
        <p className="mt-2 text-xs text-slate-500">
          The agent is investigating this request (usually 10–30 seconds)…
        </p>
      )}
      {submit.isError && (
        <p className="mt-2 text-xs text-red-600">
          {(submit.error as Error).message}
        </p>
      )}
    </section>
  );
}
