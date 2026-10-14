import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { computePlanState } from "@/lib/plans";
import PlanBanner from "@/components/PlanBanner";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: sub } = await supabase
    .from("subscriptions")
    .select("plan,status,current_period_end")
    .maybeSingle();
  const plan = computePlanState(sub, user.created_at);

  async function signOut() {
    "use server";
    await createClient().auth.signOut();
    redirect("/");
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <header className="mb-8 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <Link href="/dashboard" className="text-xl font-bold text-brand-700">
            MultiLote
          </Link>
          <nav className="flex gap-4 text-sm text-slate-600">
            <Link href="/dashboard" className="hover:text-slate-900">
              Artículos
            </Link>
            <Link href="/dashboard/billing" className="hover:text-slate-900">
              Plan
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className="hidden text-slate-500 sm:inline">{user.email}</span>
          <form action={signOut}>
            <button className="btn-secondary">Salir</button>
          </form>
        </div>
      </header>
      <PlanBanner plan={plan} />
      {children}
    </div>
  );
}
