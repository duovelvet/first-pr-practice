import Link from "next/link";

const features = [
  {
    title: "Crea una vez, publica en todos",
    text: "Sube fotos, título y precio una sola vez. La extensión rellena Wallapop, Vinted y Milanuncios por ti.",
  },
  {
    title: "Control de ventas",
    text: "Marca un artículo como vendido y sabrás dónde sigue publicado para retirarlo y evitar doble venta.",
  },
  {
    title: "Precio pensado para España",
    text: "Sin tarifas por anuncio ni planes de cientos de euros. Pensado para particulares y pequeños revendedores.",
  },
];

export default function Home() {
  return (
    <main>
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <span className="text-xl font-bold text-brand-700">MultiLote</span>
        <Link href="/login" className="btn-secondary">
          Entrar
        </Link>
      </header>

      <section className="mx-auto max-w-3xl px-6 py-20 text-center">
        <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">
          Publica en Wallapop, Vinted y Milanuncios en un clic
        </h1>
        <p className="mt-6 text-lg text-slate-600">
          El cross-listing hecho para España. Menos tiempo copiando anuncios, más tiempo vendiendo.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Link href="/login" className="btn">
            Empezar gratis
          </Link>
        </div>
      </section>

      <section className="mx-auto grid max-w-5xl gap-6 px-6 pb-24 sm:grid-cols-3">
        {features.map((f) => (
          <div key={f.title} className="rounded-xl border border-slate-200 bg-white p-6">
            <h2 className="font-semibold">{f.title}</h2>
            <p className="mt-2 text-sm text-slate-600">{f.text}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
