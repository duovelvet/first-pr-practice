import Link from "next/link";
import type { PlanState } from "@/lib/plans";

export default function PlanBanner({ plan }: { plan: PlanState }) {
  if (plan.kind === "founder" || plan.kind === "monthly") return null;

  const expired = plan.kind === "expired";
  return (
    <div
      className={`mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4 text-sm ${
        expired ? "border-red-200 bg-red-50 text-red-800" : "border-brand-100 bg-brand-50 text-brand-700"
      }`}
    >
      <span>
        {expired
          ? "Tu prueba gratuita ha terminado. Activa un plan para seguir publicando."
          : `Prueba gratuita: te quedan ${plan.daysLeft} ${plan.daysLeft === 1 ? "día" : "días"}.`}
      </span>
      <Link href="/dashboard/billing" className="btn">
        Ver planes
      </Link>
    </div>
  );
}
