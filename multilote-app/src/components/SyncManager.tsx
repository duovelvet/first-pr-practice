"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { MARKETPLACES, type Listing, type Marketplace, type Publication, type SyncJob } from "@/lib/types";

const ACTIVE = ["pending", "processing"];

export default function SyncManager({
  listingId,
  listingStatus,
  publications,
  jobs,
}: {
  listingId: string;
  listingStatus: Listing["status"];
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

  async function retire(status: "sold" | "archived") {
    const msg =
      status === "sold"
        ? "¿Marcar como vendido? La extensión retirará el anuncio de todos los marketplaces donde esté publicado."
        : "¿Retirar este artículo? La extensión eliminará sus anuncios de todos los marketplaces.";
    if (!confirm(msg)) return;
    setBusy(true);
    setError(null);
    const { error } = await createClient().rpc("retire_listing", { p_listing_id: listingId, p_status: status });
    if (error) setError(error.message);
    setBusy(false);
    router.refresh();
  }

  // Reintento de una retirada fallida: se vuelve a encolar un delete.
  async function enqueueDelete(m: Marketplace) {
    setBusy(true);
    setError(null);
    const { error } = await createClient()
      .from("sync_queue")
      .insert({ listing_id: listingId, marketplace: m, action: "delete" });
    if (error && error.code !== "23505") setError(error.message);
    setBusy(false);
    router.refresh();
  }

  const retired = listingStatus === "sold" || listingStatus === "archived";
  const anyPublished = publications.some((p) => p.status === "published");

  const pendingMarkets = MARKETPLACES.filter((m) => {
    const published = publications.find((p) => p.marketplace === m.id)?.status === "published";
    const active = ACTIVE.includes(latestJob(m.id)?.status ?? "");
    return !published && !active;
  }).map((m) => m.id);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {!retired && (
          <button className="btn" disabled={busy || pendingMarkets.length === 0} onClick={() => enqueue(pendingMarkets)}>
            Publicar en todos los marketplaces
          </button>
        )}
        {listingStatus === "active" && (
          <>
            <button className="btn-secondary" disabled={busy} onClick={() => retire("sold")}>
              Marcar como vendido
            </button>
            <button className="btn-secondary" disabled={busy} onClick={() => retire("archived")}>
              Retirar de todos
            </button>
          </>
        )}
        {retired && (
          <span className="rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-600">
            {listingStatus === "sold" ? "Vendido" : "Retirado"}
            {anyPublished ? " — retirada en curso" : ""}
          </span>
        )}
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
          const failed = !active && job?.status === "failed" && job.last_error !== "Cancelada: artículo retirado";
          const deleting = active && job.action === "delete";
          const deleteFailed = failed && job.action === "delete" && published;

          let status = "Sin publicar";
          if (deleting) status = job.status === "pending" ? "Retirada en cola — esperando a la extensión" : "Retirando anuncio…";
          else if (active) status = job.status === "pending" ? "En cola — esperando a la extensión" : "Publicando…";
          else if (failed) status = `Error${job.action === "delete" ? " al retirar" : ""}: ${job.last_error ?? "desconocido"}`;
          else if (published) status = "Publicado";
          else if (pub?.status === "removed") status = "Retirado";

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
                {deleteFailed && (
                  <button className="btn-secondary" disabled={busy} onClick={() => enqueueDelete(m.id)}>
                    Reintentar retirada
                  </button>
                )}
                {!retired && !published && !active && (
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
