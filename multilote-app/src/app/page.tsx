import Link from "next/link";
import PlanCards from "@/components/PlanCards";

const features = [
  {
    title: "Crea una vez, publica en todos",
    text: "Sube fotos, título y precio una sola vez. La extensión publica en Wallapop, Vinted y Milanuncios por ti, sin que tengas que copiar nada.",
  },
  {
    title: "Cola de tareas automática",
    text: "Pulsas «Publicar» en el panel y la extensión de Chrome va resolviendo la cola en segundo plano, con reintentos si algo falla.",
  },
  {
    title: "Sin cuotas abusivas",
    text: "17,90 €/mes o un pago único de fundador de 69 €. Hecho para particulares y pequeños revendedores de España.",
  },
];

const steps = [
  "Crea tu artículo en el panel web con sus fotos.",
  "Pulsa «Publicar en todos los marketplaces».",
  "Deja Chrome abierto: la extensión lo publica y te avisa en el panel.",
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
            Empezar 7 días gratis
          </Link>
          <a href="#precios" className="btn-secondary">
            Ver precios
          </a>
        </div>
      </section>

      <section className="mx-auto grid max-w-5xl gap-6 px-6 pb-16 sm:grid-cols-3">
        {features.map((f) => (
          <div key={f.title} className="rounded-xl border border-slate-200 bg-white p-6">
            <h2 className="font-semibold">{f.title}</h2>
            <p className="mt-2 text-sm text-slate-600">{f.text}</p>
          </div>
        ))}
      </section>

      <section className="mx-auto max-w-3xl px-6 pb-16">
        <h2 className="mb-6 text-center text-2xl font-bold">Así de simple</h2>
        <ol className="space-y-3">
          {steps.map((s, i) => (
            <li key={s} className="flex gap-4 rounded-xl border border-slate-200 bg-white p-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-600 font-bold text-white">
                {i + 1}
              </span>
              <span className="self-center">{s}</span>
            </li>
          ))}
        </ol>
      </section>

      <section id="precios" className="mx-auto max-w-3xl px-6 pb-24">
        <h2 className="mb-6 text-center text-2xl font-bold">Precios claros</h2>
        <PlanCards mode="landing" />
      </section>
    </main>
  );
}
