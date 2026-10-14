// Cliente mínimo de Supabase compartido por popup y service worker (sin dependencias).
const ML = (() => {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = MULTILOTE_CONFIG;

  async function getSession() {
    const { session } = await chrome.storage.local.get("session");
    return session || null;
  }

  async function login(email, password) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error_description || body.msg || "No se pudo entrar");
    await chrome.storage.local.set({ session: body });
    return body;
  }

  async function logout() {
    await chrome.storage.local.remove("session");
  }

  async function refresh(session) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    if (!res.ok) return null;
    const fresh = await res.json();
    await chrome.storage.local.set({ session: fresh });
    return fresh;
  }

  // fetch autenticado; reintenta una vez con token renovado ante 401.
  async function authed(path, init = {}) {
    let session = await getSession();
    if (!session) throw new Error("no-session");
    const run = (s) =>
      fetch(`${SUPABASE_URL}${path}`, {
        ...init,
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${s.access_token}`,
          "Content-Type": "application/json",
          ...(init.headers || {}),
        },
      });
    let res = await run(session);
    if (res.status === 401) {
      session = await refresh(session);
      if (!session) {
        await logout();
        throw new Error("no-session");
      }
      res = await run(session);
    }
    return res;
  }

  async function rpc(name, args) {
    const res = await authed(`/rest/v1/rpc/${name}`, { method: "POST", body: JSON.stringify(args) });
    if (!res.ok) throw new Error(`${name}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  async function select(path) {
    const res = await authed(`/rest/v1/${path}`);
    if (!res.ok) throw new Error(`select: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  async function signedPhotoUrls(paths) {
    const urls = [];
    for (const p of paths) {
      const res = await authed(`/storage/v1/object/sign/listing-photos/${p}`, {
        method: "POST",
        body: JSON.stringify({ expiresIn: 3600 }),
      });
      if (res.ok) {
        const { signedURL } = await res.json();
        urls.push(`${SUPABASE_URL}/storage/v1${signedURL}`);
      }
    }
    return urls;
  }

  return { getSession, login, logout, rpc, select, signedPhotoUrls };
})();
