export interface OwnerAuthPageInput {
  readonly appName: string;
  readonly routePrefix: string;
  readonly afterLoginPath: string;
  readonly nonce: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Self-contained login, first-time setup, and token management page. It uses
 * only browser WebAuthn APIs and `fetch`; no third-party script is loaded.
 */
export function renderOwnerAuthPage(input: OwnerAuthPageInput): string {
  const config = JSON.stringify({
    prefix: input.routePrefix,
    afterLogin: input.afterLoginPath,
  }).replaceAll("<", "\\u003c");
  const title = escapeHtml(input.appName);
  const nonce = escapeHtml(input.nonce);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in · ${title}</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; --bg:#f6f7f9; --fg:#14161a; --muted:#5b6270; --card:#fff; --line:#dde1e7; --accent:#2b59c3; --danger:#b42318; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --fg:#e8eaee; --muted:#9aa3b2; --card:#171a21; --line:#2a2f3a; --accent:#7aa2ff; --danger:#ff8a80; } }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; background:var(--bg); color:var(--fg); }
  main { max-width:560px; margin:48px auto; padding:0 16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:24px; margin-bottom:16px; }
  h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:16px; margin:0 0 12px; }
  p { margin:0 0 12px; color:var(--muted); }
  label { display:block; font-size:13px; color:var(--muted); margin:12px 0 4px; }
  input, select { width:100%; padding:9px 10px; border:1px solid var(--line); border-radius:8px; background:transparent; color:inherit; font:inherit; }
  button { margin-top:14px; padding:9px 14px; border:0; border-radius:8px; background:var(--accent); color:#fff; font:inherit; cursor:pointer; }
  button.secondary { background:transparent; color:var(--fg); border:1px solid var(--line); }
  button.danger { background:transparent; color:var(--danger); border:1px solid var(--line); margin:0; padding:4px 10px; }
  .row { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:8px 0; border-top:1px solid var(--line); }
  .row small { color:var(--muted); display:block; }
  code.secret { display:block; word-break:break-all; padding:10px; border-radius:8px; border:1px dashed var(--accent); margin-top:12px; }
  .error { color:var(--danger); min-height:1.5em; margin-top:12px; }
  [hidden] { display:none !important; }
</style>
</head>
<body>
<main>
  <div class="card">
    <h1>${title}</h1>
    <p id="lead">Checking sign-in state…</p>

    <section id="setup" hidden>
      <p>No owner passkey exists yet. Enter the setup token from the server configuration or logs, then create a passkey on this device.</p>
      <label for="setup-token">Setup token</label>
      <input id="setup-token" autocomplete="off" spellcheck="false">
      <label for="setup-name">Passkey name</label>
      <input id="setup-name" value="My device" maxlength="100">
      <button id="setup-button" type="button">Create owner passkey</button>
    </section>

    <section id="login" hidden>
      <button id="login-button" type="button">Sign in with passkey</button>
    </section>

    <section id="signed-in" hidden>
      <button id="continue-button" type="button">Continue</button>
      <button id="logout-button" type="button" class="secondary">Sign out</button>
    </section>
    <div id="error" class="error" role="alert"></div>
  </div>

  <div class="card" id="tokens-card" hidden>
    <h2>API tokens</h2>
    <p>Tokens authenticate scripts and other services. Each token is shown once.</p>
    <label for="token-name">Name</label>
    <input id="token-name" maxlength="100" placeholder="ci, laptop, scheduler…">
    <label for="token-scope">Access</label>
    <select id="token-scope">
      <option value="runs:execute,runs:read">Run and read</option>
      <option value="runs:read">Read only</option>
      <option value="runs:execute,runs:read,tokens:manage">Full owner access</option>
    </select>
    <label for="token-expiry">Expires after (days, blank for never)</label>
    <input id="token-expiry" type="number" min="1" max="3650" value="90">
    <button id="token-create" type="button">Create token</button>
    <code id="token-secret" class="secret" hidden></code>
    <div id="token-list"></div>
  </div>

  <div class="card" id="passkeys-card" hidden>
    <h2>Passkeys</h2>
    <div id="passkey-list"></div>
    <label for="passkey-name">New passkey name</label>
    <input id="passkey-name" maxlength="100" value="Another device">
    <button id="passkey-add" type="button" class="secondary">Add a passkey</button>
  </div>
</main>
<script nonce="${nonce}">
(() => {
  const CONFIG = ${config};
  const $ = (id) => document.getElementById(id);
  const b64uToBuf = (value) => {
    const pad = "=".repeat((4 - (value.length % 4)) % 4);
    const bin = atob((value + pad).replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  };
  const bufToB64u = (buffer) => {
    const bytes = new Uint8Array(buffer);
    let bin = "";
    for (const byte of bytes) bin += String.fromCharCode(byte);
    return btoa(bin).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  };
  const showError = (message) => { $("error").textContent = message || ""; };
  const api = async (path, options = {}) => {
    const response = await fetch(CONFIG.prefix + path, {
      method: options.method || "GET",
      credentials: "same-origin",
      headers: options.body === undefined ? {} : { "content-type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || ("Request failed: " + response.status));
    return data;
  };

  const toCreationOptions = (o) => ({
    ...o,
    challenge: b64uToBuf(o.challenge),
    user: { ...o.user, id: b64uToBuf(o.user.id) },
    excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
  });
  const toRequestOptions = (o) => ({
    ...o,
    challenge: b64uToBuf(o.challenge),
    allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
  });
  const registrationJson = (cred) => ({
    id: cred.id,
    rawId: bufToB64u(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment || undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: bufToB64u(cred.response.clientDataJSON),
      attestationObject: bufToB64u(cred.response.attestationObject),
      transports: typeof cred.response.getTransports === "function" ? cred.response.getTransports() : [],
    },
  });
  const authenticationJson = (cred) => ({
    id: cred.id,
    rawId: bufToB64u(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment || undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: bufToB64u(cred.response.clientDataJSON),
      authenticatorData: bufToB64u(cred.response.authenticatorData),
      signature: bufToB64u(cred.response.signature),
      userHandle: cred.response.userHandle ? bufToB64u(cred.response.userHandle) : undefined,
    },
  });

  const registerPasskey = async (name, setupToken) => {
    const body = setupToken ? { setupToken } : {};
    const start = await api("/passkeys/register/options", { method: "POST", body });
    const credential = await navigator.credentials.create({ publicKey: toCreationOptions(start.options) });
    if (!credential) throw new Error("Passkey creation was cancelled.");
    await api("/passkeys/register/verify", {
      method: "POST",
      body: { ...body, name, challengeId: start.challengeId, response: registrationJson(credential) },
    });
  };

  const login = async () => {
    const start = await api("/passkeys/login/options", { method: "POST" });
    const credential = await navigator.credentials.get({ publicKey: toRequestOptions(start.options) });
    if (!credential) throw new Error("Sign-in was cancelled.");
    await api("/passkeys/login/verify", {
      method: "POST",
      body: { challengeId: start.challengeId, response: authenticationJson(credential) },
    });
  };

  const row = (title, detail, onRemove, removeLabel) => {
    const div = document.createElement("div");
    div.className = "row";
    const text = document.createElement("div");
    text.textContent = title;
    const small = document.createElement("small");
    small.textContent = detail;
    text.appendChild(small);
    div.appendChild(text);
    if (onRemove) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "danger";
      button.textContent = removeLabel;
      button.addEventListener("click", () => onRemove().catch((e) => showError(e.message)));
      div.appendChild(button);
    }
    return div;
  };
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString() : "never");

  const loadManagement = async () => {
    const [{ tokens }, { passkeys }] = await Promise.all([api("/tokens"), api("/passkeys")]);
    const tokenList = $("token-list");
    tokenList.replaceChildren(...tokens.slice().reverse().map((t) => row(
      t.name + (t.revokedAt ? " (revoked)" : ""),
      t.displayPrefix + "… · " + t.scopes.join(", ") + " · expires " + day(t.expiresAt) + " · last used " + day(t.lastUsedAt),
      t.revokedAt ? null : async () => { await api("/tokens/" + encodeURIComponent(t.id), { method: "DELETE" }); await loadManagement(); },
      "Revoke",
    )));
    const passkeyList = $("passkey-list");
    passkeyList.replaceChildren(...passkeys.map((p) => row(
      p.name,
      "added " + day(p.createdAt) + " · last used " + day(p.lastUsedAt),
      passkeys.length > 1 ? async () => { await api("/passkeys/" + encodeURIComponent(p.id), { method: "DELETE" }); await loadManagement(); } : null,
      "Remove",
    )));
    $("tokens-card").hidden = false;
    $("passkeys-card").hidden = false;
  };

  const refresh = async () => {
    showError("");
    const state = await api("/session");
    $("setup").hidden = !(state.setupRequired && !state.authenticated);
    $("login").hidden = state.setupRequired || state.authenticated;
    $("signed-in").hidden = !state.authenticated;
    $("lead").textContent = state.authenticated
      ? "Signed in as " + (state.subject.displayName || state.subject.subjectId) + "."
      : state.setupRequired ? "Set up the owner account." : "Sign in to continue.";
    if (!window.PublicKeyCredential && !state.authenticated) {
      showError("This browser does not support passkeys.");
    }
    if (state.authenticated && state.subject.scopes.includes("tokens:manage")) {
      await loadManagement();
    } else {
      $("tokens-card").hidden = true;
      $("passkeys-card").hidden = true;
    }
  };

  const guard = (fn) => () => fn().catch((error) => showError(error.message));
  $("setup-button").addEventListener("click", guard(async () => {
    await registerPasskey($("setup-name").value, $("setup-token").value.trim());
    await refresh();
  }));
  $("login-button").addEventListener("click", guard(async () => { await login(); await refresh(); }));
  $("continue-button").addEventListener("click", () => { window.location.assign(CONFIG.afterLogin); });
  $("logout-button").addEventListener("click", guard(async () => { await api("/logout", { method: "POST" }); await refresh(); }));
  $("passkey-add").addEventListener("click", guard(async () => { await registerPasskey($("passkey-name").value); await refresh(); }));
  $("token-create").addEventListener("click", guard(async () => {
    const days = $("token-expiry").value.trim();
    const created = await api("/tokens", {
      method: "POST",
      body: {
        name: $("token-name").value,
        scopes: $("token-scope").value.split(","),
        ...(days ? { expiresInDays: Number(days) } : {}),
      },
    });
    const secret = $("token-secret");
    secret.textContent = created.token;
    secret.hidden = false;
    $("token-name").value = "";
    await loadManagement();
  }));
  refresh().catch((error) => showError(error.message));
})();
</script>
</body>
</html>`;
}
