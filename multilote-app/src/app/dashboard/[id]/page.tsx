import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import PublicationManager from "@/components/PublicationManager";
import type { Listing, Publication } from "@/lib/types";

export default async function ListingPage({ params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: listing } = await supabase.from("listings").select("*").eq("id", params.id).single();
  if (!listing) notFound();
  const l = listing as Listing;

  const { data: pubs } = await supabase.from("publications").select("*").eq("listing_id", l.id);

  const photoUrls = l.photos.length
    ? (await supabase.storage.from("listing-photos").createSignedUrls(l.photos, 3600)).data ?? []
    : [];

  return (
    <>
      <h1 className="text-2xl font-bold">{l.title}</h1>
      <p className="mt-1 text-lg font-semibold text-brand-700">{Number(l.price).toFixed(2)} €</p>
      <p className="mt-4 whitespace-pre-line text-slate-700">{l.description}</p>

      {photoUrls.length > 0 && (
        <div className="mt-6 flex gap-3 overflow-x-auto">
          {photoUrls.map((p, i) =>
            p.signedUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src={p.signedUrl} alt="" className="h-32 w-32 rounded-lg object-cover" />
            ) : null
          )}
        </div>
      )}

      <h2 className="mb-3 mt-10 text-lg font-semibold">Publicaciones</h2>
      <p className="mb-3 text-sm text-slate-500">
        Publica desde la extensión de Chrome y marca aquí el estado en cada marketplace.
      </p>
      <PublicationManager listingId={l.id} publications={(pubs as Publication[]) ?? []} />
    </>
  );
}
