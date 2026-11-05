// Pure tab/site helpers for the extension (classic script: loaded by the Safari background page
// and by Node tests). No imports, no top-level names beyond functions prefixed "term".
// Mirrors bridge/sites.mjs hostAllowed/urlAllowed: https only, no credentials, host or subdomain match.

function termHostAllowed(host, sites) {
  if (typeof host !== "string" || !Array.isArray(sites)) return false;
  let h = host.toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (!h) return false;
  for (const raw of sites) {
    if (typeof raw !== "string") continue;
    let site = raw.toLowerCase();
    if (site.endsWith(".")) site = site.slice(0, -1);
    if (!site) continue;
    if (h === site || h.endsWith("." + site)) return true;
  }
  return false;
}

function termUrlAllowed(url, sites) {
  if (typeof url !== "string") return false;
  let u;
  try {
    u = new URL(url);
  } catch (err) {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.username !== "" || u.password !== "") return false;
  return termHostAllowed(u.hostname, sites);
}

// Returns "restricted" (no usable web URL), "site" (web URL not on the list, or http://) or "eligible".
function termClassifyTab(tab, sites) {
  const url = tab.url;
  if (typeof url !== "string" || url === "") return "restricted";
  let u;
  try {
    u = new URL(url);
  } catch (err) {
    return "restricted";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "restricted";
  return termUrlAllowed(url, sites) ? "eligible" : "site";
}

function termPickShareable(tabs, sites, shared, cap) {
  const result = { share: [], skipped: [], unshare: [] };
  const eligible = [];
  for (const tab of Array.isArray(tabs) ? tabs : []) {
    if (!tab || typeof tab.id !== "number") continue;
    const kind = termClassifyTab(tab, sites);
    if (kind === "eligible") eligible.push(tab.id);
    else result.skipped.push({ tabId: tab.id, reason: kind });
  }
  if (eligible.length > 0 && eligible.every((id) => shared.has(id))) {
    result.unshare = eligible.slice();
    return result;
  }
  for (const id of eligible) {
    if (shared.has(id)) continue;
    if (shared.size + result.share.length < cap) result.share.push(id);
    else result.skipped.push({ tabId: id, reason: "cap" });
  }
  return result;
}

// True when fewer than `limit` timestamps in `history` fall within the `windowMs` before `nowMs`.
function termOpenAllowed(history, nowMs, limit, windowMs) {
  const list = Array.isArray(history) ? history : [];
  let count = 0;
  for (const t of list) {
    if (typeof t !== "number") continue;
    if (t <= nowMs && nowMs - t < windowMs) count++;
  }
  return count < limit;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { termHostAllowed, termUrlAllowed, termPickShareable, termOpenAllowed };
}
