import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  async function signOut() {
    "use server";
    await createClient().auth.signOut();
    redirect("/");
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <header className="mb-8 flex items-center justify-between">
        <Link href="/dashboard" className="text-xl font-bold text-brand-700">
          MultiLote
        </Link>
        <div className="flex items-center gap-4 text-sm">
          <span className="hidden text-slate-500 sm:inline">{user.email}</span>
          <form action={signOut}>
            <button className="btn-secondary">Salir</button>
          </form>
        </div>
      </header>
      {children}
    </div>
  );
}
