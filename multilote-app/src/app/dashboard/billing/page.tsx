import { createClient } from "@/lib/supabase/server";
import { computePlanState } from "@/lib/plans";
import PlanCards from "@/components/PlanCards";

export default async function BillingPage({ searchParams }: { searchParams: { ok?: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: sub } = await supabase
    .from("subscriptions")
    .select("plan,status,current_period_end")
    .maybeSingle();
  const plan = computePlanState(sub, user!.created_at);

  const label =
    plan.kind === "founder"
      ? "Plan Fundador (de por vida)"
      : plan.kind === "monthly"
      ? "Plan Mensual"
      : plan.kind === "trial"
      ? `Prueba gratuita (${plan.daysLeft} d restantes)`
      : "Sin plan activo";

  return (
    <>
      <h1 className="mb-2 text-2xl font-bold">Tu plan</h1>
      <p className="mb-6 text-slate-600">
        Estado actual: <strong>{label}</strong>
      </p>
      {searchParams.ok && (
        <p className="mb-6 rounded-lg bg-green-50 p-3 text-sm text-green-800">
          Pago recibido. Tu plan se activará en unos segundos.
        </p>
      )}
      {plan.kind === "founder" || plan.kind === "monthly" ? (
        <p className="text-sm text-slate-500">Todo en orden. Para cambios en tu suscripción escríbenos.</p>
      ) : (
        <PlanCards mode="checkout" />
      )}
    </>
  );
}
