"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { MARKETPLACES, type Publication } from "@/lib/types";

export default function PublicationManager({
  listingId,
  publications,
}: {
  listingId: string;
  publications: Publication[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function setStatus(marketplace: string, status: Publication["status"]) {
    setBusy(marketplace);
    const supabase = createClient();
    await supabase.from("publications").upsert(
      {
        listing_id: listingId,
        marketplace,
        status,
        published_at: status === "published" ? new Date().toISOString() : null,
      },
      { onConflict: "listing_id,marketplace" }
    );
    setBusy(null);
    router.refresh();
  }

  return (
    <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
      {MARKETPLACES.map((m) => {
        const p = publications.find((x) => x.marketplace === m.id);
        const published = p?.status === "published";
        return (
          <li key={m.id} className="flex items-center justify-between p-4">
            <div>
              <p className="font-medium">{m.name}</p>
              <p className="text-sm text-slate-500">{p ? p.status : "sin publicar"}</p>
            </div>
            <div className="flex gap-2">
              {published ? (
                <button className="btn-secondary" disabled={busy === m.id} onClick={() => setStatus(m.id, "removed")}>
                  Retirar
                </button>
              ) : (
                <button className="btn-secondary" disabled={busy === m.id} onClick={() => setStatus(m.id, "published")}>
                  Marcar publicado
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
