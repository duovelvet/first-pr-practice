import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe";

export async function POST(request: NextRequest) {
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? request.nextUrl.origin;
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(`${site}/login`, 303);

  const plan = String((await request.formData()).get("plan"));
  if (plan !== "monthly" && plan !== "founder") {
    return NextResponse.json({ error: "Plan no válido" }, { status: 400 });
  }

  const stripe = getStripe();
  const common = {
    client_reference_id: user.id,
    customer_email: user.email ?? undefined,
    metadata: { user_id: user.id, plan },
    success_url: `${site}/dashboard/billing?ok=1`,
    cancel_url: `${site}/dashboard/billing`,
    locale: "es" as const,
  };

  const session =
    plan === "monthly"
      ? await stripe.checkout.sessions.create({
          ...common,
          mode: "subscription",
          line_items: [{ price: process.env.STRIPE_PRICE_MONTHLY!, quantity: 1 }],
          subscription_data: { metadata: { user_id: user.id, plan } },
        })
      : await stripe.checkout.sessions.create({
          ...common,
          mode: "payment",
          line_items: [{ price: process.env.STRIPE_PRICE_FOUNDER!, quantity: 1 }],
        });

  return NextResponse.redirect(session.url!, 303);
}
