import { createClient } from "@supabase/supabase-js";

// Solo para código de servidor (webhooks). Nunca importar desde componentes cliente.
export function createAdminClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
}
