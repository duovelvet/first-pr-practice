"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const CONDITIONS = ["Nuevo", "Como nuevo", "Buen estado", "Aceptable"];

export default function ListingForm() {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const supabase = createClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      router.push("/login");
      return;
    }

    const paths: string[] = [];
    for (const file of files) {
      const ext = file.name.split(".").pop() ?? "jpg";
      const path = `${user.id}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage.from("listing-photos").upload(path, file);
      if (upErr) {
        setError(`Error subiendo foto: ${upErr.message}`);
        setLoading(false);
        return;
      }
      paths.push(path);
    }

    const { data, error: insErr } = await supabase
      .from("listings")
      .insert({
        title: String(form.get("title")),
        description: String(form.get("description")),
        price: Number(form.get("price")),
        category: String(form.get("category") || "") || null,
        brand: String(form.get("brand") || "") || null,
        size: String(form.get("size") || "") || null,
        condition: String(form.get("condition") || "") || null,
        photos: paths,
      })
      .select("id")
      .single();

    if (insErr) {
      setError(insErr.message);
      setLoading(false);
      return;
    }
    router.push(`/dashboard/${data.id}`);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <input name="title" className="input" placeholder="Título" required minLength={3} maxLength={120} />
      <textarea name="description" className="input min-h-32" placeholder="Descripción" />
      <div className="grid gap-4 sm:grid-cols-2">
        <input name="price" type="number" step="0.01" min="0" className="input" placeholder="Precio (€)" required />
        <select name="condition" className="input" defaultValue="">
          <option value="">Estado</option>
          {CONDITIONS.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <input name="category" className="input" placeholder="Categoría" />
        <input name="brand" className="input" placeholder="Marca" />
        <input name="size" className="input" placeholder="Talla (opcional)" />
      </div>
      <div>
        <label className="mb-1 block text-sm font-medium">Fotos</label>
        <input
          type="file"
          accept="image/*"
          multiple
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          className="text-sm"
        />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button className="btn" disabled={loading}>
        {loading ? "Guardando..." : "Guardar artículo"}
      </button>
    </form>
  );
}
