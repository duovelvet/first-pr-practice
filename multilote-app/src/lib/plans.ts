export const TRIAL_DAYS = 7; // debe coincidir con has_active_plan() en la migración 0002

export const PLANS = {
  monthly: {
    id: "monthly" as const,
    name: "Mensual",
    price: "17,90 €",
    period: "/mes",
    description: "Publicación en Wallapop, Vinted y Milanuncios. Cancela cuando quieras.",
  },
  founder: {
    id: "founder" as const,
    name: "Fundador",
    price: "69 €",
    period: "pago único",
    description: "Pagas una vez y MultiLote es tuyo. Sin cuotas mensuales.",
  },
};

export type PlanState =
  | { kind: "founder" }
  | { kind: "monthly"; renewsAt: string | null }
  | { kind: "trial"; daysLeft: number }
  | { kind: "expired" };

type Sub = { plan: "monthly" | "founder"; status: string; current_period_end: string | null } | null;

export function computePlanState(sub: Sub, userCreatedAt: string): PlanState {
  const now = Date.now();
  const active =
    sub &&
    ["active", "trialing"].includes(sub.status) &&
    (!sub.current_period_end || new Date(sub.current_period_end).getTime() > now);

  if (active && sub.plan === "founder") return { kind: "founder" };
  if (active) return { kind: "monthly", renewsAt: sub.current_period_end };

  const trialEnd = new Date(userCreatedAt).getTime() + TRIAL_DAYS * 86_400_000;
  if (trialEnd > now) return { kind: "trial", daysLeft: Math.ceil((trialEnd - now) / 86_400_000) };
  return { kind: "expired" };
}
