/**
 * The page, its styles and its script, kept as three strings and served from separate URLs.
 * Separate URLs (not inline <script>/<style>) let the Content-Security-Policy forbid inline code
 * altogether, so even if something unexpected ended up in the page it could not run as a script.
 *
 * The browser script writes every value with `textContent`, never `innerHTML`: flag keys and user
 * names are shown as text and can never be interpreted as markup.
 */

export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Parcels: a FlagForge demo app</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header class="top">
  <p class="brand">parcels.example <span class="dim">/ a demo app using the FlagForge SDK</span></p>
  <p class="status" id="status" role="status" aria-live="polite"><span class="dot" id="status-dot"></span><span id="status-text">connecting</span></p>
</header>

<main>
  <section class="pane" aria-labelledby="shop-title">
    <p class="caption">FIG 1 / The app your customer sees</p>
    <h1 id="shop-title">Checkout</h1>
    <div class="who" role="group" aria-label="Shop as">
      <span class="caption">Shop as</span>
      <span id="users"></span>
    </div>

    <div class="card" id="checkout" data-mode="form" aria-live="polite">
      <div class="row"><span>Same-day courier</span><span class="mono">184,00 kr</span></div>
      <p class="dim small">Oslo to Bergen, one parcel, 4.2 kg</p>

      <div class="variant" id="variant-form">
        <div class="fields"><span class="field">Card number</span><span class="field">MM/YY</span><span class="field">CVC</span></div>
        <span class="field wide">Name on card</span>
        <button type="button" class="button outline" id="pay-form">Pay 184,00 kr</button>
      </div>
      <div class="variant" id="variant-onetap" hidden>
        <div class="row field"><span class="dim">Saved card</span><span class="mono">&bull;&bull;&bull;&bull; 4417</span></div>
        <p class="dim small">Receipt goes to the address on file.</p>
        <button type="button" class="button solid" id="pay-onetap">Pay in one tap</button>
      </div>
    </div>
    <p class="small dim" id="featured-note"></p>
    <p class="small" id="pay-result" role="status" aria-live="polite"></p>

    <div class="traffic">
      <p class="caption">Traffic for an experiment</p>
      <p class="small dim" id="traffic-note"></p>
      <button type="button" class="small-button" id="simulate">Simulate 200 shoppers</button>
      <p class="small" id="simulate-result" role="status" aria-live="polite"></p>
    </div>
  </section>

  <section class="pane" aria-labelledby="sdk-title">
    <p class="caption">FIG 2 / What the SDK decided, on the server</p>
    <h2 id="sdk-title">Flags for <span id="user-name">this customer</span></h2>
    <p class="small dim" id="attributes"></p>
    <table aria-label="Flag decisions">
      <thead><tr><th>Flag</th><th>Value</th><th>Why</th></tr></thead>
      <tbody id="flags"></tbody>
    </table>
    <p class="small dim" id="empty" hidden>This environment has no flags yet. Create one in the dashboard and it appears here by itself.</p>
    <p class="small dim foot">Decisions are made on this app's server from rules the SDK already holds: no request to FlagForge per page. The browser receives only the answers, never the rules or the API key. Last change received <span class="mono" id="at">never</span>.</p>
    <p class="small dim" id="events-line"></p>
  </section>
</main>
<script src="/app.js" defer></script>
</body>
</html>`;

export const APP_CSS = `
:root { --canvas:#0c0c0b; --raised:#141412; --sunken:#080807; --hairline:#26241f; --strong:#3a372f; --ink:#e8e4dc; --muted:#8a867d; --faint:#5c5952; --ember:#ff5a1f; --danger:#e5484d; }
* { box-sizing: border-box; }
html { background: var(--canvas); color: var(--ink); font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; color-scheme: dark; }
body { margin: 0; min-height: 100dvh; }
.mono, .caption, th, .status, .brand, code { font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; font-variant-numeric: tabular-nums; }
.dim { color: var(--muted); } .small { font-size: 12px; }
.caption, th { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); font-weight: 400; }
.top { display: flex; justify-content: space-between; align-items: center; gap: 16px; height: 48px; padding: 0 24px; border-bottom: 1px solid var(--hairline); }
.brand { margin: 0; font-size: 12px; } .status { margin: 0; font-size: 11px; display: flex; align-items: center; gap: 8px; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; }
.dot { width: 6px; height: 6px; border-radius: 1px; background: var(--faint); } .dot.live { background: var(--ember); } .dot.bad { background: var(--danger); }
main { display: grid; gap: 1px; background: var(--hairline); grid-template-columns: minmax(0,1fr) minmax(0,1fr); min-height: calc(100dvh - 49px); }
.pane { background: var(--canvas); padding: 32px 24px; }
h1, h2 { margin: 16px 0 0; font-size: 28px; font-weight: 500; letter-spacing: -.02em; line-height: 1.15; }
.who { margin-top: 20px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.who button { height: 28px; padding: 0 10px; border: 1px solid var(--hairline); border-radius: 2px; background: transparent; color: var(--muted); font: inherit; cursor: pointer; }
.who button:hover { color: var(--ink); border-color: var(--strong); }
.who button[aria-pressed="true"] { color: var(--ink); border-color: var(--strong); background: var(--raised); }
:focus-visible { outline: 1px solid var(--ink); outline-offset: 2px; }
.card { margin-top: 24px; max-width: 360px; border: 1px solid var(--hairline); border-radius: 2px; background: var(--raised); padding: 16px; }
.row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.variant { margin-top: 20px; display: flex; flex-direction: column; gap: 8px; min-height: 148px; animation: arrive .18s ease-out; }
.variant[hidden] { display: none; }
.fields { display: grid; grid-template-columns: 1fr 64px 56px; gap: 8px; }
.field { border: 1px solid var(--hairline); border-radius: 2px; background: var(--sunken); padding: 10px 12px; font-size: 12px; color: var(--faint); font-family: ui-monospace, Menlo, monospace; }
.row.field { color: var(--ink); }
.button { margin-top: auto; height: 40px; display: flex; align-items: center; justify-content: center; border-radius: 3px; font-weight: 500; }
button.button { width: 100%; font: inherit; font-weight: 500; cursor: pointer; color: inherit; background: transparent; padding: 0; }
button.button:disabled { opacity: .5; cursor: progress; }
.traffic { margin-top: 32px; max-width: 360px; border-top: 1px solid var(--hairline); padding-top: 16px; }
.traffic .caption { margin: 0 0 8px; }
.small-button { height: 30px; padding: 0 12px; margin-top: 10px; border: 1px solid var(--hairline); border-radius: 2px; background: transparent; color: var(--ink); font: inherit; cursor: pointer; }
.small-button:hover { border-color: var(--strong); background: var(--raised); }
.small-button:disabled { opacity: .5; cursor: progress; }
.button.outline { border: 1px solid var(--strong); } .button.solid { background: var(--ink); color: var(--canvas); }
table { width: 100%; margin-top: 20px; border-collapse: collapse; }
th { text-align: left; padding: 8px 8px 8px 0; border-bottom: 1px solid var(--hairline); }
td { padding: 10px 8px 10px 0; border-bottom: 1px solid var(--hairline); vertical-align: baseline; }
td.key { font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
td.value { font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: var(--faint); white-space: nowrap; }
td.value.on { color: var(--ink); } td.value .dot { display: inline-block; margin-right: 8px; vertical-align: middle; }
td.why { color: var(--muted); font-size: 12px; }
tr.changed td { animation: flash 1.2s ease-out; }
.foot { margin-top: 24px; max-width: 46ch; line-height: 1.6; }
/* Only opacity and transform are animated, as in the dashboard. */
@keyframes arrive { from { opacity: 0; transform: translateY(6px); } }
@keyframes flash { from { background: rgba(255, 90, 31, .28); } to { background: transparent; } }
@media (max-width: 800px) { main { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { .variant, tr.changed td { animation: none; } }
`;

// Plain strings and concatenation on purpose (no template literals), so this file's own
// template string needs no escaping and the script stays readable.
export const APP_JS = `
"use strict";
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var WHY = {
    OFF: "The flag is off in this environment, so everyone gets off.",
    RULE_MATCH: "A targeting rule matched this customer.",
    FALLTHROUGH: "No rule matched; decided by the rollout percentage.",
    FLAG_NOT_FOUND: "The SDK has no flag with this key.",
    NOT_READY: "The SDK has not loaded any flags yet; default used.",
    ERROR: "Could not evaluate; default used."
  };
  var source = null;
  var previous = {};

  function describe(attributes) {
    return Object.keys(attributes).map(function (name) { return name + ": " + attributes[name]; }).join("   ");
  }

  function showStatus(text, kind) {
    $("status-text").textContent = text;
    $("status-dot").className = "dot" + (kind ? " " + kind : "");
  }

  function render(snapshot) {
    var sdk = snapshot.sdk;
    if (sdk.fatal) showStatus("api key rejected", "bad");
    else if (!sdk.ready) showStatus("waiting for flags", "");
    else if (sdk.stream === "connected" && !sdk.degraded) showStatus("live / v" + (sdk.version === null ? "?" : sdk.version), "live");
    else showStatus("polling (stream " + sdk.stream + ")" + (sdk.source !== "network" ? " / flags from " + sdk.source : ""), "");

    $("user-name").textContent = snapshot.user.name;
    $("attributes").textContent = describe(snapshot.user.attributes);

    var oneTap = snapshot.featured.value === true;
    $("checkout").dataset.mode = oneTap ? "one-tap" : "form";
    $("variant-form").hidden = oneTap;
    $("variant-onetap").hidden = !oneTap;
    $("featured-note").textContent = snapshot.featured.exists
      ? "This checkout follows the flag " + snapshot.featured.key + ", which is " + (oneTap ? "on" : "off") + " for " + snapshot.user.name + "."
      : "No flag called " + snapshot.featured.key + " in this environment yet. Create it in the dashboard and turn it on to switch this checkout.";

    var body = $("flags");
    var sameUser = previous.user === snapshot.user.id;
    body.textContent = "";
    snapshot.flags.forEach(function (flag) {
      var row = document.createElement("tr");
      var before = previous.values ? previous.values[flag.key] : undefined;
      // Flash only when a value really changed for the SAME customer (not when switching customer).
      if (sameUser && before !== undefined && before !== flag.value) row.className = "changed";
      row.dataset.flag = flag.key;

      var key = document.createElement("td"); key.className = "key"; key.textContent = flag.key;
      var value = document.createElement("td"); value.className = "value" + (flag.value ? " on" : "");
      var dot = document.createElement("span"); dot.className = "dot" + (flag.value ? " live" : "");
      value.appendChild(dot); value.appendChild(document.createTextNode(flag.value ? "on" : "off"));
      var why = document.createElement("td"); why.className = "why"; why.textContent = WHY[flag.reason] || flag.reason;
      row.appendChild(key); row.appendChild(value); row.appendChild(why);
      body.appendChild(row);
    });
    $("empty").hidden = snapshot.flags.length > 0;
    var ev = sdk.events;
    $("events-line").textContent = ev ? "Experiment events: " + ev.sent + " sent, " + ev.queued + " waiting" + (ev.dropped ? ", " + ev.dropped + " dropped" : "") + "." : "";

    var changed = !previous.values || !sameUser || snapshot.flags.some(function (f) { return previous.values[f.key] !== f.value; }) || Object.keys(previous.values).length !== snapshot.flags.length;
    if (changed) $("at").textContent = new Date(snapshot.at).toLocaleTimeString();
    previous = { user: snapshot.user.id, values: {} };
    snapshot.flags.forEach(function (f) { previous.values[f.key] = f.value; });
  }

  var userId = null;
  function watch(id) {
    userId = id;
    if (source) source.close();
    Array.prototype.forEach.call($("users").children, function (button) {
      button.setAttribute("aria-pressed", String(button.dataset.user === userId));
    });
    try { history.replaceState(null, "", "?user=" + encodeURIComponent(userId)); } catch (e) {}
    // EventSource reconnects by itself if the connection drops, and this app's server sends a
    // full snapshot on every connection, so nothing is missed.
    source = new EventSource("/events?user=" + encodeURIComponent(userId));
    source.addEventListener("snapshot", function (event) {
      try { render(JSON.parse(event.data)); } catch (e) {}
    });
    source.onerror = function () { showStatus("demo server unreachable, retrying", "bad"); };
  }

  // POST helper: JSON in, JSON out. The server refuses anything that is not JSON from this same site.
  function post(path, body) {
    return fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(function (response) {
      return response.json().then(function (data) { if (!response.ok) throw new Error(data.error || "Request failed"); return data; });
    });
  }

  function pay() {
    var buttons = [$("pay-form"), $("pay-onetap")];
    buttons.forEach(function (b) { b.disabled = true; });
    post("/pay", { user: userId }).then(function (result) {
      $("pay-result").textContent = "Paid with the " + (result.oneTap ? "one-tap" : "card form") + " checkout. Recorded as " + result.event + " for this customer.";
    }).catch(function (error) {
      $("pay-result").textContent = "Could not record the payment: " + error.message;
    }).then(function () { buttons.forEach(function (b) { b.disabled = false; }); });
  }
  $("pay-form").addEventListener("click", pay);
  $("pay-onetap").addEventListener("click", pay);

  var SHOPPERS = 200;
  $("simulate").addEventListener("click", function () {
    var button = $("simulate");
    button.disabled = true;
    $("simulate-result").textContent = "Sending...";
    post("/simulate", { shoppers: SHOPPERS }).then(function (r) {
      $("simulate-result").textContent = r.shoppers + " shoppers: " + r.withFlag + " saw one-tap, " + r.withoutFlag + " saw the card form, " + r.conversions + " paid.";
    }).catch(function (error) {
      $("simulate-result").textContent = "Could not simulate: " + error.message;
    }).then(function () { button.disabled = false; });
  });

  fetch("/api/config").then(function (response) { return response.json(); }).then(function (config) {
    var sim = config.simulation;
    $("traffic-note").textContent = "Pretend shoppers pay at " + Math.round(sim.conversionWithout * 100) + "% with the card form and " + Math.round(sim.conversionWith * 100) + "% with one-tap. Those rates are made up for this demo. An experiment on " + config.featuredFlag + " that measures " + config.conversionEvent + " should find them again.";
    config.users.forEach(function (user) {
      var button = document.createElement("button");
      button.type = "button";
      button.dataset.user = user.id;
      button.textContent = user.name;
      button.title = describe(user.attributes);
      button.addEventListener("click", function () { watch(user.id); });
      $("users").appendChild(button);
    });
    var asked = new URLSearchParams(location.search).get("user");
    var known = config.users.some(function (user) { return user.id === asked; });
    watch(known ? asked : config.users[0].id);
  }).catch(function () { showStatus("could not load the demo", "bad"); });
})();
`;
