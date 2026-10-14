import Link from "next/link";
import { PLANS } from "@/lib/plans";

// mode "landing": enlaces a /login. mode "checkout": formularios POST a Stripe.
export default function PlanCards({ mode }: { mode: "landing" | "checkout" }) {
  return (
    <div className="grid gap-6 sm:grid-cols-2">
      {Object.values(PLANS).map((p) => (
        <div
          key={p.id}
          className={`rounded-xl border bg-white p-6 ${p.id === "founder" ? "border-brand-500 ring-2 ring-brand-100" : "border-slate-200"}`}
        >
          {p.id === "founder" && (
            <span className="mb-2 inline-block rounded-full bg-brand-100 px-2 py-0.5 text-xs font-semibold text-brand-700">
              Pago único de fundador
            </span>
          )}
          <h3 className="text-lg font-semibold">{p.name}</h3>
          <p className="mt-2">
            <span className="text-3xl font-extrabold">{p.price}</span>{" "}
            <span className="text-sm text-slate-500">{p.period}</span>
          </p>
          <p className="mt-3 text-sm text-slate-600">{p.description}</p>
          {mode === "landing" ? (
            <Link href="/login" className="btn mt-5 w-full">
              Probar 7 días gratis
            </Link>
          ) : (
            <form action="/api/stripe/checkout" method="post" className="mt-5">
              <input type="hidden" name="plan" value={p.id} />
              <button className="btn w-full">{p.id === "founder" ? "Pagar 69 € una vez" : "Suscribirme"}</button>
            </form>
          )}
        </div>
      ))}
    </div>
  );
}
