import { NextResponse, type NextRequest } from "next/server";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const stripe = getStripe();
  const signature = request.headers.get("stripe-signature");
  const body = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature ?? "", process.env.STRIPE_WEBHOOK_SECRET!);
  } catch {
    return NextResponse.json({ error: "Firma inválida" }, { status: 400 });
  }

  const admin = createAdminClient();

  if (event.type === "checkout.session.completed") {
    const s = event.data.object as Stripe.Checkout.Session;
    const userId = s.metadata?.user_id ?? s.client_reference_id;
    const plan = s.metadata?.plan;
    if (userId && (plan === "monthly" || plan === "founder")) {
      let periodEnd: string | null = null;
      if (plan === "monthly" && typeof s.subscription === "string") {
        const sub = await stripe.subscriptions.retrieve(s.subscription);
        const end = sub.current_period_end;
        periodEnd = end ? new Date(end * 1000).toISOString() : null;
      }
      const { error } = await admin.from("subscriptions").upsert({
        user_id: userId,
        plan,
        status: "active",
        stripe_customer_id: typeof s.customer === "string" ? s.customer : null,
        stripe_subscription_id: plan === "monthly" && typeof s.subscription === "string" ? s.subscription : null,
        current_period_end: periodEnd,
      });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const sub = event.data.object as Stripe.Subscription;
    const end = sub.current_period_end;
    const { error } = await admin
      .from("subscriptions")
      .update({
        status: sub.status,
        current_period_end: end ? new Date(end * 1000).toISOString() : null,
      })
      .eq("stripe_subscription_id", sub.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
