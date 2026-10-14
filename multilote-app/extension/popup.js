const { SUPABASE_URL, SUPABASE_ANON_KEY, WEB_URL, UPLOAD_URLS } = MULTILOTE_CONFIG;
const MARKETPLACES = [
  ["wallapop", "Wallapop"],
  ["vinted", "Vinted"],
  ["milanuncios", "Milanuncios"],
];

const $ = (id) => document.getElementById(id);

async function getSession() {
  const { session } = await chrome.storage.local.get("session");
  return session || null;
}

async function api(path, session, init = {}) {
  return fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
      ...(init.headers || {}),
    },
  });
}

async function refreshSession(session) {
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

async function fetchListings(session) {
  let res = await api("/rest/v1/listings?select=*&status=eq.active&order=created_at.desc", session);
  if (res.status === 401) {
    const fresh = await refreshSession(session);
    if (!fresh) throw new Error("expired");
    session = fresh;
    res = await api("/rest/v1/listings?select=*&status=eq.active&order=created_at.desc", session);
  }
  if (!res.ok) throw new Error("No se pudieron cargar los artículos");
  return { listings: await res.json(), session };
}

async function signedPhotoUrls(session, paths) {
  const urls = [];
  for (const p of paths) {
    const res = await api(`/storage/v1/object/sign/listing-photos/${p}`, session, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: 3600 }),
    });
    if (res.ok) {
      const { signedURL } = await res.json();
      urls.push(`${SUPABASE_URL}/storage/v1${signedURL}`);
    }
  }
  return urls;
}

async function publish(listing, marketplace, session) {
  const photoUrls = await signedPhotoUrls(session, listing.photos || []);
  await chrome.storage.local.set({ pending: { marketplace, listing, photoUrls, at: Date.now() } });
  chrome.tabs.create({ url: UPLOAD_URLS[marketplace] });
}

function render(listings, session) {
  const list = $("list");
  list.textContent = "";
  if (!listings.length) {
    list.textContent = "No tienes artículos activos. Crea uno en el panel web.";
    return;
  }
  for (const l of listings) {
    const div = document.createElement("div");
    div.className = "item";
    const title = document.createElement("p");
    title.textContent = l.title;
    const price = document.createElement("span");
    price.className = "price";
    price.textContent = ` ${Number(l.price).toFixed(2)} €`;
    title.appendChild(price);
    const row = document.createElement("div");
    row.className = "row";
    for (const [id, name] of MARKETPLACES) {
      const b = document.createElement("button");
      b.textContent = name;
      b.onclick = () => publish(l, id, session);
      row.appendChild(b);
    }
    div.append(title, row);
    list.appendChild(div);
  }
}

async function showApp(session) {
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("openWeb").href = `${WEB_URL}/dashboard`;
  try {
    const { listings, session: current } = await fetchListings(session);
    render(listings, current);
  } catch (e) {
    if (e.message === "expired") return showLogin();
    $("list").textContent = e.message;
  }
}

function showLogin() {
  chrome.storage.local.remove("session");
  $("app").classList.add("hidden");
  $("login").classList.remove("hidden");
}

$("login").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("loginError").textContent = "";
  try {
    const session = await login($("email").value, $("password").value);
    showApp(session);
  } catch (err) {
    $("loginError").textContent = err.message;
  }
});

$("logout").addEventListener("click", showLogin);

(async () => {
  const session = await getSession();
  if (session) showApp(session);
  else showLogin();
})();
