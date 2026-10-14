import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import type { Listing, Publication } from "@/lib/types";
import { MARKETPLACES } from "@/lib/types";

export default async function DashboardPage() {
  const supabase = createClient();
  const [{ data: listings }, { data: pubs }] = await Promise.all([
    supabase.from("listings").select("*").order("created_at", { ascending: false }),
    supabase.from("publications").select("*"),
  ]);

  const byListing = new Map<string, Publication[]>();
  (pubs as Publication[] | null)?.forEach((p) => {
    byListing.set(p.listing_id, [...(byListing.get(p.listing_id) ?? []), p]);
  });

  return (
    <>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Mis artículos</h1>
        <Link href="/dashboard/new" className="btn">
          + Nuevo artículo
        </Link>
      </div>

      {!listings?.length ? (
        <p className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-slate-500">
          Aún no tienes artículos. Crea el primero y publícalo con la extensión de Chrome.
        </p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
          {(listings as Listing[]).map((l) => {
            const published = byListing.get(l.id) ?? [];
            return (
              <li key={l.id}>
                <Link href={`/dashboard/${l.id}`} className="flex items-center justify-between gap-4 p-4 hover:bg-slate-50">
                  <div>
                    <p className="font-medium">
                      {l.title}
                      {l.status === "sold" && (
                        <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">Vendido</span>
                      )}
                      {l.status === "archived" && (
                        <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">Retirado</span>
                      )}
                    </p>
                    <p className="text-sm text-slate-500">{Number(l.price).toFixed(2)} €</p>
                  </div>
                  <div className="flex gap-1.5">
                    {MARKETPLACES.map((m) => {
                      const p = published.find((x) => x.marketplace === m.id);
                      const on = p?.status === "published";
                      return (
                        <span
                          key={m.id}
                          className={`rounded-full px-2 py-0.5 text-xs ${
                            on ? "bg-green-100 text-green-800" : "bg-slate-100 text-slate-500"
                          }`}
                        >
                          {m.name}
                        </span>
                      );
                    })}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
