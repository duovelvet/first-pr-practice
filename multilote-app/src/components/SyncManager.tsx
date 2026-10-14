"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { MARKETPLACES, type Marketplace, type Publication, type SyncJob } from "@/lib/types";

const ACTIVE = ["pending", "processing"];

export default function SyncManager({
  listingId,
  publications,
  jobs,
}: {
  listingId: string;
  publications: Publication[];
  jobs: SyncJob[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasActive = jobs.some((j) => ACTIVE.includes(j.status));

  // Mientras la extensión trabaja la cola, refrescamos el estado.
  useEffect(() => {
    if (!hasActive) return;
    const t = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(t);
  }, [hasActive, router]);

  function latestJob(m: Marketplace) {
    return jobs.find((j) => j.marketplace === m); // jobs viene ordenado por created_at desc
  }

  async function enqueue(markets: Marketplace[]) {
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const rows = markets.map((marketplace) => ({ listing_id: listingId, marketplace, action: "publish" as const }));
    const { error } = await supabase.from("sync_queue").insert(rows);
    if (error) {
      if (error.code === "23505") setError("Ya hay una tarea en curso para ese marketplace.");
      else if (error.code === "42501") setError("Tu prueba ha terminado. Activa un plan para publicar.");
      else setError(error.message);
    }
    setBusy(false);
    router.refresh();
  }

  const pendingMarkets = MARKETPLACES.filter((m) => {
    const published = publications.find((p) => p.marketplace === m.id)?.status === "published";
    const active = ACTIVE.includes(latestJob(m.id)?.status ?? "");
    return !published && !active;
  }).map((m) => m.id);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button className="btn" disabled={busy || pendingMarkets.length === 0} onClick={() => enqueue(pendingMarkets)}>
          Publicar en todos los marketplaces
        </button>
        {hasActive && <span className="text-sm text-slate-500">La extensión está trabajando… (actualizando)</span>}
      </div>
      {error && (
        <p className="mb-3 text-sm text-red-600">
          {error}{" "}
          {error.includes("plan") && (
            <Link href="/dashboard/billing" className="underline">
              Ver planes
            </Link>
          )}
        </p>
      )}

      <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
        {MARKETPLACES.map((m) => {
          const pub = publications.find((p) => p.marketplace === m.id);
          const job = latestJob(m.id);
          const active = job && ACTIVE.includes(job.status);
          const published = pub?.status === "published";
          const failed = !active && job?.status === "failed";

          let status = "Sin publicar";
          if (active) status = job.status === "pending" ? "En cola — esperando a la extensión" : "Publicando…";
          else if (published) status = "Publicado";
          else if (failed) status = `Error: ${job.last_error ?? "desconocido"}`;
          else if (job?.status === "pending") status = "En cola";

          return (
            <li key={m.id} className="flex items-center justify-between gap-4 p-4">
              <div>
                <p className="font-medium">{m.name}</p>
                <p className={`text-sm ${failed ? "text-red-600" : "text-slate-500"}`}>{status}</p>
              </div>
              <div className="flex gap-2">
                {published && pub?.external_url && (
                  <a href={pub.external_url} target="_blank" rel="noreferrer" className="btn-secondary">
                    Ver anuncio
                  </a>
                )}
                {!published && !active && (
                  <button className="btn-secondary" disabled={busy} onClick={() => enqueue([m.id])}>
                    {failed ? "Reintentar" : "Publicar"}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
