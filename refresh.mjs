#!/usr/bin/env node
/*
 * Family World Cup 2026 Tracker  —  refresh.mjs
 * -----------------------------------------------
 * Pulls the 2026 fixtures/results from the public-domain openfootball dataset,
 * merges them with a local cache (so nothing is ever lost between refreshes),
 * computes group standings + the knockout bracket itself, and writes a single
 * self-contained index.html you can open and screenshot for the family.
 *
 * Run it whenever you like (e.g. once a week):   node refresh.mjs
 * No API key, no npm install. Node 18+ only.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- config ----------------------------------------------------------------
// Show everything in ONE consistent timezone so the whole family reads the same
// clock. Default = UK. We must NOT auto-detect the machine's timezone here: the
// GitHub server that rebuilds the site runs in UTC, so we pin it. Override with
// the WC_TZ env var if you ever need a different zone.
const DISPLAY_TZ = process.env.WC_TZ || "Europe/London";
const TZ_LABEL =
  process.env.WC_TZ_LABEL || (DISPLAY_TZ === "Europe/London" ? "UK time" : DISPLAY_TZ);
const BASE =
  "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026";
const SOURCES = {
  matches: `${BASE}/worldcup.json`,
  teams: `${BASE}/worldcup.teams.json`,
  groups: `${BASE}/worldcup.groups.json`,
};

// ---- tiny helpers -----------------------------------------------------------
const log = (...a) => console.log(...a);
const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

// ---- PDF export (so the whole thing can be shared on WhatsApp) --------------
// Renders index.html with headless Edge/Chrome. No extra install — Edge ships
// with Windows. Best-effort: if no browser is found we just skip it.
function findBrowser() {
  const pf = process.env.ProgramFiles || "";
  const pfx = process.env["ProgramFiles(x86)"] || "";
  const lad = process.env.LOCALAPPDATA || "";
  const cands = [
    `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${pfx}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
    `${pfx}\\Google\\Chrome\\Application\\chrome.exe`,
    `${lad}\\Google\\Chrome\\Application\\chrome.exe`,
  ];
  return cands.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}
function makePdf(htmlPath, pdfPath) {
  const exe = findBrowser();
  if (!exe) {
    log("  ! PDF skipped: no Edge/Chrome found. Open index.html and use Print → Save as PDF.");
    return;
  }
  const r = spawnSync(exe, [
    "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
    `--user-data-dir=${path.join(DATA_DIR, "_browser")}`,
    `--print-to-pdf=${pdfPath}`, pathToFileURL(htmlPath).href,
  ], { timeout: 90000, stdio: "ignore" });
  if (r.status === 0 && fs.existsSync(pdfPath)) log(`  ✓ PDF: ${path.basename(pdfPath)}`);
  else log("  ! PDF generation failed — open index.html and use Print → Save as PDF.");
}

// ---- fetch with cache fallback ---------------------------------------------
// Always tries the network; on any failure falls back to the last good copy on
// disk. On success it overwrites the cache. => a flaky network never breaks you.
async function fetchJson(name, url) {
  const cacheFile = path.join(DATA_DIR, `${name}.json`);
  try {
    const res = await fetch(url, { headers: { "User-Agent": "wc-family-tracker" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const json = JSON.parse(text); // validate before trusting it
    fs.writeFileSync(cacheFile, text);
    log(`  ✓ ${name}: fetched (${text.length.toLocaleString()} bytes)`);
    return json;
  } catch (err) {
    if (fs.existsSync(cacheFile)) {
      log(`  ! ${name}: fetch failed (${err.message}) — using cached copy`);
      return JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    }
    throw new Error(`Cannot fetch ${name} and no cache exists: ${err.message}`);
  }
}

// ---- match identity & score merge ------------------------------------------
const matchKey = (m) =>
  m.num != null ? `#${m.num}` : `${m.group}|${m.team1}|${m.team2}`;

// Merge freshly fetched matches with the previous processed snapshot so that any
// score we have ever seen survives, even if upstream temporarily drops it.
function mergeScores(fresh, snapshot) {
  const prev = new Map((snapshot?.matches || []).map((m) => [matchKey(m), m]));
  let kept = 0;
  for (const m of fresh) {
    const old = prev.get(matchKey(m));
    if ((!m.score || !m.score.ft) && old?.score?.ft) {
      m.score = old.score; // restore a score upstream lost
      if (old.goals1) m.goals1 = old.goals1;
      if (old.goals2) m.goals2 = old.goals2;
      kept++;
    }
  }
  if (kept) log(`  ↻ restored ${kept} score(s) from local snapshot`);
  return fresh;
}

// ---- kickoff time -> epoch + local display ---------------------------------
// openfootball times look like "13:00 UTC-6". Convert to a real instant, then
// render in the viewer's timezone (DST handled by the runtime, no tz package).
function parseKickoff(m) {
  if (!m.date) return { epoch: null, local: "", localDate: "" };
  const tm = /(\d{1,2}):(\d{2})\s*UTC([+-]\d{1,2})?/.exec(m.time || "");
  const [, y, mo, d] = /(\d{4})-(\d{2})-(\d{2})/.exec(m.date) || [];
  if (!y) return { epoch: null, local: m.time || "", localDate: m.date };
  let utcH = 12, min = 0;
  if (tm) {
    const lh = +tm[1], lm = +tm[2], off = tm[3] != null ? +tm[3] : 0;
    utcH = lh - off; min = lm; // UTC = local - offset
  }
  const epoch = Date.UTC(+y, +mo - 1, +d, utcH, min);
  const dt = new Date(epoch);
  const local = dt.toLocaleString("en-GB", {
    timeZone: DISPLAY_TZ, weekday: "short", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const localDate = dt.toLocaleDateString("en-CA", { timeZone: DISPLAY_TZ }); // YYYY-MM-DD
  return { epoch, local, localDate };
}

// ---- group standings (computed from results) -------------------------------
function computeStandings(matches, groups, teamMap) {
  const tables = {}; // letter -> [rows]
  const groupLetter = (g) => (g || "").replace(/^Group\s+/i, "");
  for (const g of groups) {
    const letter = groupLetter(g.name);
    tables[letter] = g.teams.map((t) => ({
      team: t, P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0, GD: 0, Pts: 0,
    }));
  }
  const scheduled = {}, played = {};
  for (const m of matches) {
    if (m.num != null || !m.group) continue; // group-stage matches only
    const L = groupLetter(m.group);
    scheduled[L] = (scheduled[L] || 0) + 1;
    if (!m.score || !m.score.ft) continue;
    played[L] = (played[L] || 0) + 1;
    const [a, b] = m.score.ft;
    const rows = tables[L];
    const r1 = rows.find((r) => r.team === m.team1);
    const r2 = rows.find((r) => r.team === m.team2);
    if (!r1 || !r2) continue;
    r1.P++; r2.P++;
    r1.GF += a; r1.GA += b; r2.GF += b; r2.GA += a;
    if (a > b) { r1.W++; r2.L++; r1.Pts += 3; }
    else if (b > a) { r2.W++; r1.L++; r2.Pts += 3; }
    else { r1.D++; r2.D++; r1.Pts++; r2.Pts++; }
  }
  const complete = {};
  for (const L of Object.keys(tables)) {
    tables[L].forEach((r) => (r.GD = r.GF - r.GA));
    tables[L].sort(
      (x, y) => y.Pts - x.Pts || y.GD - x.GD || y.GF - x.GF || x.team.localeCompare(y.team)
    );
    tables[L].forEach((r, i) => (r.rank = i + 1));
    complete[L] = (played[L] || 0) >= (scheduled[L] || 0) && (scheduled[L] || 0) > 0;
  }
  return { tables, complete };
}

// ---- knockout bracket resolution -------------------------------------------
function buildBracket(matches, standings, teamSet) {
  const byNum = {};
  for (const m of matches) if (m.num != null) byNum[m.num] = m;
  const memo = new Map();

  function resolve(ref) {
    if (ref == null) return { name: null, label: "TBD" };
    if (teamSet.has(ref)) return { name: ref, label: ref };
    if (memo.has(ref)) return memo.get(ref);
    let out = { name: null, label: ref };
    let mm;
    if ((mm = /^([12])([A-L])$/.exec(ref))) {
      const pos = +mm[1], L = mm[2];
      const lbl = `${pos === 1 ? "Winner" : "Runner-up"} Group ${L}`;
      const row = standings.complete[L] ? standings.tables[L][pos - 1] : null;
      out = { name: row ? row.team : null, label: lbl };
    } else if ((mm = /^W(\d+)$/.exec(ref))) {
      out = { name: winner(+mm[1]), label: `Winner of Match ${mm[1]}` };
    } else if ((mm = /^L(\d+)$/.exec(ref))) {
      out = { name: loser(+mm[1]), label: `Loser of Match ${mm[1]}` };
    } else if (/^3/.test(ref)) {
      out = { name: null, label: `3rd place (${ref.replace(/^3/, "")})` };
    }
    memo.set(ref, out);
    return out;
  }
  function decided(num) {
    const m = byNum[num];
    if (!m || !m.score || !m.score.ft) return null;
    const p1 = resolve(m.team1), p2 = resolve(m.team2);
    if (!p1.name || !p2.name) return null;
    const [a, b] = m.score.ft;
    const pa = m.score.p ? m.score.p[0] : null, pb = m.score.p ? m.score.p[1] : null;
    if (a > b) return { win: p1.name, lose: p2.name };
    if (b > a) return { win: p2.name, lose: p1.name };
    if (pa != null && pb != null && pa !== pb)
      return pa > pb ? { win: p1.name, lose: p2.name } : { win: p2.name, lose: p1.name };
    return null; // drawn / penalties not in data yet
  }
  const winner = (n) => decided(n)?.win ?? null;
  const loser = (n) => decided(n)?.lose ?? null;

  return { resolve, winner, loser, byNum };
}

const ROUND_INDEX = {
  "Round of 32": 1, "Round of 16": 2, "Quarter-final": 3,
  "Semi-final": 4, "Match for third place": 4, "Final": 5,
};
const STAGE_NAME = ["Group stage", "Round of 32", "Round of 16", "Quarter-final", "Semi-final", "Final", "Champion"];

// ---- per-team status (alive / eliminated / how far) ------------------------
function teamStatus(team, ctx) {
  const { teamMap, standings, matches, bracket } = ctx;
  const L = teamMap[team]?.group;
  const rows = standings.tables[L] || [];
  const row = rows.find((r) => r.team === team);
  const rank = row?.rank;

  // still in the group stage
  if (!standings.complete[L]) {
    const played = row?.P || 0;
    return {
      alive: true, stageIdx: 0,
      label: played === 0
        ? `Group ${L} — not started yet`
        : `Group stage — ${ordinal(rank)} in Group ${L}`,
    };
  }

  // knockout matches this team actually reached (resolved participants)
  const ko = matches
    .filter((m) => m.num != null)
    .map((m) => ({ m, p1: bracket.resolve(m.team1).name, p2: bracket.resolve(m.team2).name }))
    .filter((x) => x.p1 === team || x.p2 === team)
    .sort((a, b) => (ROUND_INDEX[a.m.round] || 0) - (ROUND_INDEX[b.m.round] || 0));

  if (ko.length === 0) {
    if (rank <= 2) return { alive: true, stageIdx: 1, label: `Group ${L} ${ordinal(rank)} — awaiting Round of 32 draw` };
    if (rank === 3) return { alive: true, stageIdx: 0, label: `Group ${L} 3rd — awaiting best-third places` };
    return { alive: false, stageIdx: 0, label: `Eliminated — group stage (${ordinal(rank)} in Group ${L})` };
  }

  const last = ko[ko.length - 1];
  const ri = ROUND_INDEX[last.m.round] || 1;
  const m = last.m;
  if (m.score && m.score.ft) {
    const dec = bracket.winner(m.num) === team || bracket.loser(m.num) !== team
      ? bracket.winner(m.num) === team : false;
    const won = bracket.winner(m.num) === team;
    const lost = bracket.loser(m.num) === team;
    if (won && m.round === "Final") return { alive: true, stageIdx: 6, label: "🏆 World Champions!" };
    if (lost) {
      if (m.round === "Final") return { alive: false, stageIdx: 5, label: "Runners-up (lost the Final)" };
      return { alive: false, stageIdx: ri, label: `Eliminated — ${m.round}` };
    }
    if (won) return { alive: true, stageIdx: ri + 1, label: `Won ${m.round} — through to next round` };
    return { alive: true, stageIdx: ri, label: `${m.round} — result pending` };
  }
  return { alive: true, stageIdx: ri, label: `Through to the ${m.round}` };
}

// ---- main ------------------------------------------------------------------
log("Family World Cup 2026 Tracker — refreshing…");

const [matchesDoc, teamsDoc, groupsDoc] = await Promise.all([
  fetchJson("matches", SOURCES.matches),
  fetchJson("teams", SOURCES.teams),
  fetchJson("groups", SOURCES.groups),
]);

// Polymarket title-winner odds — optional, must never break the build.
let pmDoc = null;
try {
  pmDoc = await fetchJson("polymarket", "https://gamma-api.polymarket.com/events?slug=world-cup-winner");
} catch (e) {
  log(`  ! polymarket odds unavailable (${e.message})`);
}

const teamsArr = Array.isArray(teamsDoc) ? teamsDoc : Object.values(teamsDoc);
const teamMap = {};
for (const t of teamsArr) {
  teamMap[t.name] = { flag: t.flag_icon || "", code: t.fifa_code || "", group: t.group || "" };
  if (t.name_normalised) teamMap[t.name_normalised] = teamMap[t.name];
}
const teamSet = new Set(teamsArr.map((t) => t.name));
const groups = groupsDoc.groups || [];

// Real flag images. Windows fonts render flag emoji as plain letters ("AU"),
// so we resolve each team's ISO code (from its emoji), download the PNG once
// from flagcdn, cache it, and embed it as base64 — fully self-contained and
// offline after the first run.
const FLAG_SPECIAL = { England: "gb-eng", Scotland: "gb-sct", Wales: "gb-wls" };
function isoOf(t) {
  if (FLAG_SPECIAL[t.name]) return FLAG_SPECIAL[t.name];
  const cps = [...(t.flag_icon || "")]
    .map((c) => c.codePointAt(0))
    .filter((cp) => cp >= 0x1f1e6 && cp <= 0x1f1ff);
  if (cps.length === 2) return cps.map((cp) => String.fromCharCode(cp - 0x1f1e6 + 97)).join("");
  return null;
}
const flagDir = path.join(DATA_DIR, "flags");
fs.mkdirSync(flagDir, { recursive: true });
const flagData = {}; // iso -> data URI
async function ensureFlag(iso) {
  if (!iso) return;
  const file = path.join(flagDir, `${iso}.png`);
  if (!fs.existsSync(file)) {
    try {
      const res = await fetch(`https://flagcdn.com/w40/${iso}.png`);
      if (res.ok) fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    } catch { /* fall back to code chip below */ }
  }
  if (fs.existsSync(file))
    flagData[iso] = `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;
}
for (const t of teamsArr) {
  const iso = isoOf(t);
  teamMap[t.name].iso = iso;
  if (t.name_normalised) teamMap[t.name_normalised].iso = iso;
}
await Promise.all([...new Set(teamsArr.map(isoOf).filter(Boolean))].map(ensureFlag));
log(`  ✓ flags: ${Object.keys(flagData).length}/${teamsArr.length} ready`);

// Polymarket implied win probabilities, keyed by our team name (0..1).
const PM_ALIAS = { "Czech Republic": "Czechia", "Turkey": "Turkiye", "DR Congo": "Congo DR" };
const pmNorm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, "");
const winProb = {};
if (pmDoc) {
  const ev = Array.isArray(pmDoc) ? pmDoc[0] : pmDoc;
  const byNorm = {};
  for (const m of ev?.markets || []) {
    if (!m.groupItemTitle) continue;
    let p = null;
    try { p = +JSON.parse(m.outcomePrices || "[]")[0]; } catch {}
    if (p != null && !Number.isNaN(p)) byNorm[pmNorm(m.groupItemTitle)] = p;
  }
  for (const t of teamsArr) {
    let p = byNorm[pmNorm(t.name)];
    if (p == null && PM_ALIAS[t.name]) p = byNorm[pmNorm(PM_ALIAS[t.name])];
    if (p != null) winProb[t.name] = p;
  }
  log(`  ✓ odds: ${Object.keys(winProb).length}/${teamsArr.length} teams priced`);
}

// merge with last snapshot, then compute everything
let snapshot = null;
const snapPath = path.join(DATA_DIR, "snapshot.json");
if (fs.existsSync(snapPath)) {
  try { snapshot = JSON.parse(fs.readFileSync(snapPath, "utf8")); } catch {}
}
const matches = mergeScores(matchesDoc.matches || [], snapshot);
for (const m of matches) m._k = parseKickoff(m);

// Guard against feed errors: a match that hasn't kicked off yet cannot have a
// real result. If the source lists a score on a future-dated match (e.g. a
// placeholder score on an unplayed knockout fixture), ignore it everywhere.
const buildNowMs = Date.now();
let droppedFuture = 0;
for (const m of matches) {
  if (m.score && m.score.ft && m._k.epoch != null && m._k.epoch > buildNowMs) {
    delete m.score;
    delete m.goals1;
    delete m.goals2;
    droppedFuture++;
  }
}
if (droppedFuture) log(`  ! ignored ${droppedFuture} score(s) on not-yet-played matches (feed error)`);

// Manual score corrections for when the free feed is wrong or incomplete
// (see score-overrides.json). These win over the feed and the future guard.
let overridesDoc = { overrides: [] };
try {
  overridesDoc = JSON.parse(fs.readFileSync(path.join(HERE, "score-overrides.json"), "utf8"));
} catch {}
let overrode = 0;
for (const o of overridesDoc.overrides || []) {
  if (!o || !Array.isArray(o.ft)) continue;
  const hit = matches.find(
    (m) =>
      m.date === o.date &&
      ((m.team1 === o.team1 && m.team2 === o.team2) || (m.team1 === o.team2 && m.team2 === o.team1))
  );
  if (!hit) continue;
  const flip = hit.team1 !== o.team1; // config may list the teams in either order
  hit.score = { ft: flip ? [o.ft[1], o.ft[0]] : [o.ft[0], o.ft[1]] };
  if (Array.isArray(o.p)) hit.score.p = flip ? [o.p[1], o.p[0]] : [o.p[0], o.p[1]];
  if (o.aet) hit._aet = true;
  hit._override = true;
  overrode++;
}
if (overrode) log(`  ✎ applied ${overrode} manual score override(s)`);

const standings = computeStandings(matches, groups, teamMap);
const bracket = buildBracket(matches, standings, teamSet);
const ctx = { teamMap, standings, matches, bracket };

// owners: team -> member, plus per-member team list
let ownersDoc;
try {
  ownersDoc = JSON.parse(fs.readFileSync(path.join(HERE, "owners.json"), "utf8"));
} catch {
  ownersDoc = { owners: {} };
}
const memberTeams = ownersDoc.owners || {};
const ownerOf = {};
const palette = [
  "#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#008080",
  "#9a6324", "#800000", "#808000", "#000075", "#e6ac00", "#46c2c2",
  "#bc3fbc", "#1aa35a", "#d2691e", "#2e6da4", "#a0522d", "#6b5b95",
];
const ownerColor = {};
Object.keys(memberTeams).forEach((name, i) => {
  ownerColor[name] = palette[i % palette.length];
  for (const t of memberTeams[name] || []) if (t) ownerOf[t] = name;
});

// played matches for results, with stamped status of owned teams
const playedMatches = matches.filter((m) => m.score && m.score.ft);
playedMatches.sort((a, b) => (b._k.epoch || 0) - (a._k.epoch || 0));

const statusCache = {};
const statusOf = (team) => (statusCache[team] ??= teamStatus(team, ctx));

// Total football points a team has earned across ALL its completed matches
// (win = 3, draw = 1), group and knockout. Drives the leaderboard tie-breaker so
// it moves with every result during the group stage.
const pointsCache = {};
function teamPointsOf(team) {
  if (pointsCache[team] != null) return pointsCache[team];
  let pts = 0;
  for (const m of matches) {
    if (!(m.score && m.score.ft)) continue;
    const t1 = m.num != null ? bracket.resolve(m.team1).name : m.team1;
    const t2 = m.num != null ? bracket.resolve(m.team2).name : m.team2;
    if (t1 !== team && t2 !== team) continue;
    const [a, b] = m.score.ft;
    const mine = t1 === team ? a : b, theirs = t1 === team ? b : a;
    if (mine > theirs) pts += 3;
    else if (mine === theirs) pts += 1;
  }
  return (pointsCache[team] = pts);
}

// Win/draw/loss record across all a team's completed matches (group + knockout).
const recordCache = {};
function teamRecordOf(team) {
  if (recordCache[team]) return recordCache[team];
  let W = 0, D = 0, L = 0;
  for (const m of matches) {
    if (!(m.score && m.score.ft)) continue;
    const t1 = m.num != null ? bracket.resolve(m.team1).name : m.team1;
    const t2 = m.num != null ? bracket.resolve(m.team2).name : m.team2;
    if (t1 !== team && t2 !== team) continue;
    const [a, b] = m.score.ft;
    const mine = t1 === team ? a : b, theirs = t1 === team ? b : a;
    if (mine > theirs) W++;
    else if (mine === theirs) D++;
    else L++;
  }
  return (recordCache[team] = { W, D, L });
}

// ----------------------------------------------------------------------------
// HTML rendering
// ----------------------------------------------------------------------------
const now = new Date();
const updated = now.toLocaleString("en-GB", {
  timeZone: DISPLAY_TZ, weekday: "long", day: "numeric", month: "long",
  hour: "2-digit", minute: "2-digit", hour12: false,
});
const firstDay = Date.UTC(2026, 5, 11);
const dayNum = Math.floor((now.getTime() - firstDay) / 86400000) + 1;
const totalMatches = matches.length;
const donePct = Math.round((playedMatches.length / totalMatches) * 100);

// "Result pending": a match has almost certainly finished but the (free, slow)
// feed still has no score. 90 min play + 15 min half-time + ~15 min stoppage
// ≈ 120 min. This deliberately ignores knockout extra time. Bump LIKELY_DONE_MIN
// up if you want to be more cautious, down to flag sooner.
const nowMs = now.getTime();
const LIKELY_DONE_MIN = 120;
const minsSince = (m) => (m._k.epoch != null ? (nowMs - m._k.epoch) / 60000 : -Infinity);
const noScore = (m) => !(m.score && m.score.ft);
// kicked off & still no score: "live" until ~120 min, then "pending" (feed lagging).
const isLive = (m) => noScore(m) && minsSince(m) >= 0 && minsSince(m) < LIKELY_DONE_MIN;
const isPending = (m) => noScore(m) && minsSince(m) >= LIKELY_DONE_MIN;
const hasPendingMatch = (team) =>
  matches.some((m) => {
    if (!isPending(m)) return false;
    const t1 = m.num != null ? bracket.resolve(m.team1).name : m.team1;
    const t2 = m.num != null ? bracket.resolve(m.team2).name : m.team2;
    return t1 === team || t2 === team;
  });
const pendingCount = matches.filter(isPending).length;
const liveCount = matches.filter(isLive).length;

const flag = (t) => {
  const iso = teamMap[t]?.iso;
  const uri = iso && flagData[iso];
  const p = winProb[t];
  const od = p != null
    ? ` data-team="${esc(t)}" data-prob="${(p * 100).toFixed(1)}" title="${esc(t)} — ${(p * 100).toFixed(1)}% to win (Polymarket)"`
    : "";
  const oc = p != null ? " odds" : "";
  if (uri) return `<img class="fl${oc}" src="${uri}" width="22" height="15" alt="${esc(teamMap[t]?.code || "")}"${od}>`;
  const code = teamMap[t]?.code;
  return code ? `<span class="flx${oc}"${od}>${esc(code)}</span>` : "";
};
const chip = (member) =>
  member
    ? `<span class="chip" style="background:${ownerColor[member]}">${esc(member)}</span>`
    : "";

// participant cell for any match (resolves knockout placeholders)
function side(ref, alignRight) {
  const r = bracket.resolve(ref);
  const name = r.name || null;
  const member = name ? ownerOf[name] : null;
  const f = name ? flag(name) : "";
  const txt = name ? esc(name) : `<span class="tbd">${esc(r.label)}</span>`;
  const inner = alignRight
    ? `${chip(member)} ${txt} ${f}`
    : `${f} ${txt} ${chip(member)}`;
  return `<span class="side ${member ? "owned" : ""}" ${member ? `style="--oc:${ownerColor[member]}"` : ""}>${inner}</span>`;
}

function scoreOrTime(m) {
  if (m.score && m.score.ft) {
    const [a, b] = m.score.ft;
    const extra = m.score.p
      ? ` <small>(pens ${m.score.p[0]}-${m.score.p[1]})</small>`
      : m._aet
        ? ` <small>(a.e.t.)</small>`
        : "";
    const t = m._override ? ` title="Corrected — the data feed had this wrong"` : "";
    return `<span class="sc"${t}>${a}–${b}${extra}</span>`;
  }
  if (isPending(m)) return `<span class="pending">⏳ pending</span>`;
  if (isLive(m)) return `<span class="live">🔴 in progress</span>`;
  return `<span class="tm">${esc(m._k.local || m.time || "")}</span>`;
}

function matchRow(m) {
  const tag = m.num != null ? esc(m.round) : esc(m.group || m.round);
  return `<div class="mrow">
    <div class="m-l">${side(m.team1, true)}</div>
    <div class="m-c">${scoreOrTime(m)}<div class="m-meta">${tag}</div></div>
    <div class="m-r">${side(m.team2, false)}</div>
  </div>`;
}

// --- Family standings ---
const familyRows = Object.entries(memberTeams)
  .map(([member, teams]) => {
    const ts = (teams || []).filter((t) => teamSet.has(t)).map((t) => ({ t, st: statusOf(t), pts: teamPointsOf(t), rec: teamRecordOf(t), pending: hasPendingMatch(t) }));
    const alive = ts.filter((x) => x.st.alive).length;
    const reach = ts.reduce((s, x) => s + x.st.stageIdx, 0);
    const points = ts.reduce((s, x) => s + x.pts, 0);
    return { member, ts, alive, reach, points };
  })
  .filter((r) => r.ts.length)
  // progress first (the sweepstake prize), then total points (lively now), then name
  .sort((a, b) => b.alive - a.alive || b.reach - a.reach || b.points - a.points || a.member.localeCompare(b.member));

const familyTable = familyRows.length
  ? `<section id="standings"><h2>👪 Family standings <small>(teams still in, then points)</small></h2>
    <table class="fam">
      <thead><tr><th>#</th><th>Member</th><th>Teams</th><th>Pts</th><th>Still in</th></tr></thead>
      <tbody>${familyRows
        .map(
          (r, i) => `<tr>
        <td class="rk">${i + 1}</td>
        <td>${chip(r.member)}</td>
        <td>${r.ts
            .map(
              (x) =>
                `<div class="ft-line">${x.st.alive ? `<span class="tick">✅</span>` : `<span class="tick">❌</span>`} ${flag(x.t)} ${esc(x.t)} <span class="wdl">${x.rec.W}W ${x.rec.D}D ${x.rec.L}L</span> <span class="tpts">${x.pts}&nbsp;pt${x.pts === 1 ? "" : "s"}</span> <span class="st ${x.st.alive ? "s-in" : "s-out"}">${esc(x.st.label)}</span>${x.pending ? ` <span class="pending">⏳ result pending</span>` : ""}</div>`
            )
            .join("")}</td>
        <td class="rk pts">${r.points}</td>
        <td class="rk">${r.alive}/${r.ts.length}</td>
      </tr>`
        )
        .join("")}</tbody>
    </table></section>`
  : "";

// --- Upcoming (next 7 days) ---
const todayLocal = now.toLocaleDateString("en-CA", { timeZone: DISPLAY_TZ });
const in7 = new Date(now.getTime() + 7 * 86400000).toLocaleDateString("en-CA", { timeZone: DISPLAY_TZ });
const upcoming = matches
  .filter((m) => !(m.score && m.score.ft) && m._k.localDate && m._k.localDate >= todayLocal && m._k.localDate <= in7)
  .sort((a, b) => (a._k.epoch || 0) - (b._k.epoch || 0));
const upByDate = {};
for (const m of upcoming) (upByDate[m._k.localDate] ||= []).push(m);
const upcomingHtml = `<section id="fixtures"><h2>📅 Next 7 days</h2>${
  Object.keys(upByDate).length
    ? Object.entries(upByDate)
        .map(([d, ms]) => {
          const label = new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", {
            timeZone: DISPLAY_TZ, weekday: "long", day: "numeric", month: "long",
          });
          return `<div class="daygrp"><div class="dayhdr">${esc(label)}</div>${ms.map(matchRow).join("")}</div>`;
        })
        .join("")
    : `<p class="muted">No matches in the next 7 days.</p>`
}</section>`;

// --- Recent results ---
const recentHtml = `<section id="results"><h2>✅ Recent results</h2>${
  playedMatches.length
    ? playedMatches.slice(0, 10).map(matchRow).join("")
    : `<p class="muted">No matches have been played yet — the tournament starts 11 June 2026.</p>`
}</section>`;

// --- Group standings ---
const groupHtml = `<section id="groups"><h2>📊 Group standings</h2><div class="grid">${groups
  .map((g) => {
    const L = g.name.replace(/^Group\s+/i, "");
    const rows = standings.tables[L] || [];
    return `<div class="gtable">
      <div class="ghdr">${esc(g.name)}${standings.complete[L] ? ' <small>· final</small>' : ""}</div>
      <table><thead><tr><th></th><th class="tl">Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th></tr></thead>
      <tbody>${rows
        .map((r) => {
          const member = ownerOf[r.team];
          const qual = standings.complete[L] && r.rank <= 2;
          return `<tr class="${member ? "owned" : ""} ${qual ? "qual" : ""}" ${member ? `style="--oc:${ownerColor[member]}"` : ""}>
            <td class="rk">${r.rank}</td>
            <td class="tl">${flag(r.team)} ${esc(r.team)} ${member ? chip(member) : ""}</td>
            <td>${r.P}</td><td>${r.W}</td><td>${r.D}</td><td>${r.L}</td>
            <td>${r.GD >= 0 ? "+" : ""}${r.GD}</td><td class="pts">${r.Pts}</td>
          </tr>`;
        })
        .join("")}</tbody></table>
    </div>`;
  })
  .join("")}</div></section>`;

// --- Knockout bracket ---
const koRounds = ["Round of 32", "Round of 16", "Quarter-final", "Semi-final", "Match for third place", "Final"];
const koHtml = `<section id="knockouts"><h2>🏆 Knockout bracket</h2><div class="grid">${koRounds
  .map((rd) => {
    const ms = matches.filter((m) => m.round === rd).sort((a, b) => (a.num || 0) - (b.num || 0));
    if (!ms.length) return "";
    return `<div class="koround"><div class="ghdr">${esc(rd)}</div>${ms.map(matchRow).join("")}</div>`;
  })
  .join("")}</div></section>`;

// --- Title odds (Polymarket): toggle between by-team and by-family-member ---
const oddsRows = teamsArr
  .map((t) => ({ name: t.name, p: winProb[t.name] }))
  .filter((x) => x.p != null)
  .sort((a, b) => b.p - a.p);
// Per member: only one team can be champion, so their two teams are mutually
// exclusive — the combined chance one of them wins is just the sum.
const memberOdds = Object.entries(memberTeams)
  .map(([member, teams]) => {
    const ts = (teams || []).filter((t) => teamSet.has(t)).map((t) => ({ t, p: winProb[t] }));
    const combined = ts.reduce((s, x) => s + (x.p || 0), 0);
    return { member, ts, combined };
  })
  .filter((r) => r.ts.length)
  .sort((a, b) => b.combined - a.combined || a.member.localeCompare(b.member));
const oddsHtml = oddsRows.length
  ? `<section id="odds"><h2>🎲 Title odds <small>(implied chance to win · Polymarket)</small></h2>
    <div class="odds-controls"><label>View: <select id="odds-mode"><option value="team">By team</option><option value="member">By family member</option></select></label></div>
    <div class="oddsgrid odds-by-team">${oddsRows
      .map(
        (r, i) =>
          `<div class="odds-row"><span class="orank">${i + 1}</span> ${flag(r.name)} <span class="oname">${esc(r.name)}</span> <span class="oprob">${(r.p * 100).toFixed(1)}%</span>${ownerOf[r.name] ? " " + chip(ownerOf[r.name]) : ""}</div>`
      )
      .join("")}</div>
    <div class="odds-by-member" style="display:none"><div class="omnote">Ranked by the combined chance one of a member's teams wins the World Cup.</div>${memberOdds
      .map(
        (r, i) =>
          `<div class="odds-row mem"><span class="orank">${i + 1}</span> ${chip(r.member)} <span class="oprob">${(r.combined * 100).toFixed(1)}%</span><div class="omteams">${r.ts
            .map((x) => `${flag(x.t)} ${esc(x.t)} <span class="osub">${x.p != null ? (x.p * 100).toFixed(1) + "%" : "—"}</span>`)
            .join(" · ")}</div></div>`
      )
      .join("")}</div></section>`
  : "";

const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Family World Cup 2026</title>
<style>
  :root{ --bg:#f4f6fb; --card:#fff; --ink:#1a2230; --muted:#6b7688; --line:#e3e8f0; --accent:#5b2a86; }
  *{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
  .wrap{max-width:920px;margin:0 auto;padding:18px 18px 88px}
  header.top{background:linear-gradient(120deg,#5b2a86,#1f6feb);color:#fff;border-radius:16px;padding:20px 22px;margin-bottom:18px;box-shadow:0 6px 22px rgba(31,111,235,.18)}
  header.top h1{margin:0;font-size:24px;letter-spacing:.2px}
  header.top .sub{opacity:.92;margin-top:6px;font-size:13px}
  header.top .banner-note{margin-top:10px;font-size:12px;line-height:1.4;background:rgba(255,255,255,.16);border-radius:8px;padding:6px 10px}
  .bar{height:7px;background:rgba(255,255,255,.25);border-radius:6px;margin-top:12px;overflow:hidden}
  .bar > i{display:block;height:100%;background:#fff;border-radius:6px}
  section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin:0 0 16px;box-shadow:0 1px 3px rgba(16,24,40,.04)}
  h2{margin:0 0 12px;font-size:17px}
  h2 small{color:var(--muted);font-weight:500}
  .muted{color:var(--muted)}
  .chip{display:inline-block;color:#fff;font-size:11px;font-weight:600;padding:1px 8px;border-radius:999px;vertical-align:middle;white-space:nowrap}
  .fl{width:22px;height:15px;vertical-align:-2px;border-radius:2px;box-shadow:0 0 0 .5px rgba(0,0,0,.18);object-fit:cover}
  .flx{display:inline-block;font:600 10px/14px ui-monospace,Consolas,monospace;background:#eef1f6;color:#445;border:1px solid var(--line);border-radius:3px;padding:0 3px;vertical-align:1px}
  .tbd{color:var(--muted);font-style:italic}
  /* spotlight */
  .spotgrid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .spot{display:flex;gap:12px;border:1px solid var(--line);border-radius:12px;padding:14px;background:#fbfcfe}
  .spot.alive{border-left:5px solid #1aa35a}.spot.out{border-left:5px solid #c0392b;opacity:.92}
  .spot-flag{font-size:40px;line-height:1}
  .spot-name{font-size:19px;font-weight:700}
  .badge{display:inline-block;font-size:12px;font-weight:600;border-radius:8px;padding:2px 9px;margin:5px 0}
  .b-in{background:#e6f7ee;color:#127a43}.b-out{background:#fdecea;color:#b03127}
  .spot .mini{font-size:13px;color:var(--muted);margin:3px 0}
  .spot .line{font-size:13px;margin-top:3px}
  /* family table */
  table.fam{width:100%;border-collapse:collapse}
  table.fam th,table.fam td{text-align:left;padding:8px 8px;border-bottom:1px solid var(--line);vertical-align:top}
  table.fam th{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px}
  td.rk{text-align:center;font-weight:700;color:var(--muted)}
  .ft-line{margin:2px 0}
  .st{font-size:11px;padding:0 6px;border-radius:6px;margin-left:4px}
  .tpts{font-size:11px;color:var(--muted);font-weight:700}
  .pending{display:inline-block;font-size:11px;font-weight:700;background:#fff4e5;color:#9a5b00;border:1px solid #ffd9a0;border-radius:6px;padding:0 6px}
  .live{display:inline-block;font-size:11px;font-weight:700;background:#fdecef;color:#c0143c;border:1px solid #f5b8c6;border-radius:6px;padding:0 6px}
  .tick{font-size:11px}
  .wdl{font-size:11px;color:var(--muted);font-weight:700;font-variant-numeric:tabular-nums}
  .s-in{background:#e6f7ee;color:#127a43}.s-out{background:#fdecea;color:#b03127}
  /* match rows */
  .mrow{display:grid;grid-template-columns:1fr 92px 1fr;align-items:center;padding:7px 4px;border-bottom:1px solid var(--line)}
  .mrow:last-child{border-bottom:none}
  .m-l{text-align:right}.m-r{text-align:left}.m-c{text-align:center}
  .side.owned{border-bottom:2px solid var(--oc);padding-bottom:1px}
  .sc{font-weight:700;font-size:16px}
  .tm{font-size:12px;color:var(--muted)}
  .m-meta{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.3px;margin-top:1px}
  .daygrp{margin-bottom:12px}
  .dayhdr{font-weight:700;font-size:13px;color:var(--accent);border-bottom:2px solid var(--line);padding-bottom:3px;margin-bottom:2px}
  /* grids */
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  .gtable table,.koround{width:100%}
  .ghdr{font-weight:700;font-size:13px;margin-bottom:5px;color:var(--accent)}
  .gtable table{border-collapse:collapse;width:100%}
  .gtable th,.gtable td{padding:3px 5px;font-size:12.5px;text-align:center;border-bottom:1px solid var(--line)}
  .gtable th{color:var(--muted);font-weight:600}
  .gtable .tl{text-align:left}
  .gtable tr.qual td{background:#f0faf3}
  .gtable tr.owned .tl{border-left:3px solid var(--oc);padding-left:5px}
  .pts{font-weight:700}
  footer{color:var(--muted);font-size:12px;text-align:center;padding:8px 0 22px}
  footer a{color:var(--accent)}
  /* floating "jump to a section" menu — works on desktop and mobile */
  html{scroll-behavior:smooth}
  section{scroll-margin-top:14px}
  .fab{position:fixed;right:16px;bottom:16px;z-index:50}
  .fab summary{list-style:none;cursor:pointer;width:52px;height:52px;border-radius:50%;
    background:linear-gradient(120deg,#5b2a86,#1f6feb);color:#fff;font-size:22px;
    display:flex;align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(16,24,40,.28)}
  .fab summary::-webkit-details-marker{display:none}
  .fab summary::marker{content:""}
  .fab-menu{position:absolute;right:0;bottom:62px;background:#fff;border:1px solid var(--line);
    border-radius:12px;box-shadow:0 10px 28px rgba(16,24,40,.22);padding:6px;min-width:172px;
    display:flex;flex-direction:column;gap:1px}
  .fab-menu a{padding:9px 12px;border-radius:8px;color:var(--ink);text-decoration:none;font-size:14px;font-weight:600;white-space:nowrap}
  .fab-menu a:hover{background:var(--bg)}
  /* Polymarket title odds + tap-a-flag popover */
  .oddsgrid{column-count:2;column-gap:24px}
  .odds-row{display:flex;align-items:center;gap:7px;padding:4px 2px;border-bottom:1px solid var(--line);font-size:13px;break-inside:avoid;-webkit-column-break-inside:avoid}
  .orank{color:var(--muted);font-weight:700;min-width:20px;text-align:right;font-variant-numeric:tabular-nums}
  .oname{flex:1}
  .oprob{font-weight:700;font-variant-numeric:tabular-nums}
  .odds-controls{margin:-2px 0 12px}
  .odds-controls select{font:inherit;padding:3px 7px;border-radius:7px;border:1px solid var(--line);background:#fff;cursor:pointer}
  .omnote{font-size:11.5px;color:var(--muted);margin-bottom:7px}
  .odds-row.mem{flex-wrap:wrap;row-gap:3px}
  .odds-row.mem .oprob{margin-right:4px}
  .omteams{flex:1 1 230px;color:var(--muted);font-size:12px}
  .omteams .osub{font-weight:700;color:var(--ink)}
  .fl.odds,.flx.odds{cursor:pointer}
  .odds-pop{position:absolute;z-index:60;background:#1a2230;color:#fff;border-radius:8px;padding:7px 10px;font-size:12.5px;line-height:1.35;box-shadow:0 8px 24px rgba(0,0,0,.3);max-width:230px}
  .odds-pop b{font-size:13.5px}
  .odds-src{opacity:.72;font-size:11px;margin-top:2px}
  @media(max-width:680px){.oddsgrid{column-count:1}}
  @media(max-width:680px){.spotgrid,.grid{grid-template-columns:1fr}.wrap{padding:10px}}
  @page{margin:11mm}
  @media print{
    body{background:#fff}
    .wrap{max-width:none;padding:0}
    header.top{box-shadow:none}
    section{box-shadow:none;break-inside:avoid}
    .gtable,.koround,.daygrp,.mrow,tr{break-inside:avoid}
    .fab{display:none} /* keep the PDF clean */
  }
</style></head>
<body><div class="wrap">
  <header class="top" id="top">
    <h1>🌍 Family World Cup 2026</h1>
    <div class="sub">${dayNum < 1 ? "Kicks off 11 June 2026" : `Day ${dayNum} of the tournament`} ·
      ${playedMatches.length}/${totalMatches} matches played ·
      Updated ${esc(updated)} (${esc(TZ_LABEL)})</div>
    <div class="bar"><i style="width:${donePct}%"></i></div>
    <div class="banner-note">Note: scores can take a while to update (free data source). Status: ${
      pendingCount
        ? `⏳ ${pendingCount} result${pendingCount === 1 ? "" : "s"} pending`
        : liveCount
          ? `⚽ ${liveCount} match${liveCount === 1 ? "" : "es"} in progress`
          : "✅ all up to date"
    }.</div>
  </header>
  ${familyTable}
  ${upcomingHtml}
  ${recentHtml}
  ${groupHtml}
  ${koHtml}
  ${oddsHtml}
  <footer>
    Data: public-domain <a href="https://github.com/openfootball/worldcup.json">openfootball/worldcup.json</a> ·
    Standings &amp; bracket computed locally · Title odds from <a href="https://polymarket.com/event/world-cup-winner">Polymarket</a> · Times in ${esc(TZ_LABEL)}.<br>
    Tie-breakers use points → goal difference → goals scored (simplified). Best-third-place spots resolve once group stage ends.
  </footer>
</div>
<details class="fab">
  <summary aria-label="Jump to a section">☰</summary>
  <nav class="fab-menu">
    <a href="#top">⬆️ Top</a>
    <a href="#standings">👪 Leaderboard</a>
    <a href="#fixtures">📅 Upcoming</a>
    <a href="#results">✅ Results</a>
    <a href="#groups">📊 Groups</a>
    <a href="#knockouts">🏆 Knockouts</a>
    <a href="#odds">🎲 Odds</a>
  </nav>
</details>
<script>
  document.querySelectorAll(".fab-menu a").forEach(function (a) {
    a.addEventListener("click", function () { a.closest("details").open = false; });
  });
  // Tap (mobile) or click any flag to see that team's Polymarket win probability.
  (function () {
    var pop = null;
    function close() { if (pop) { pop.remove(); pop = null; } }
    document.addEventListener("click", function (e) {
      var el = e.target.closest ? e.target.closest("[data-prob]") : null;
      if (!el) { close(); return; }
      e.preventDefault();
      close();
      pop = document.createElement("div");
      pop.className = "odds-pop";
      var name = document.createElement("b");
      name.textContent = el.getAttribute("data-team");
      var prob = document.createElement("div");
      prob.textContent = el.getAttribute("data-prob") + "% to win the World Cup";
      var src = document.createElement("div");
      src.className = "odds-src";
      src.textContent = "implied odds · Polymarket";
      pop.appendChild(name); pop.appendChild(prob); pop.appendChild(src);
      document.body.appendChild(pop);
      var r = el.getBoundingClientRect();
      var maxLeft = window.scrollX + document.documentElement.clientWidth - pop.offsetWidth - 8;
      pop.style.left = Math.max(8, Math.min(window.scrollX + r.left, maxLeft)) + "px";
      pop.style.top = (window.scrollY + r.bottom + 6) + "px";
    });
  })();
  // Title-odds view switch: by team <-> by family member.
  var oddsMode = document.getElementById("odds-mode");
  if (oddsMode) oddsMode.addEventListener("change", function () {
    var byTeam = oddsMode.value === "team";
    document.querySelector(".odds-by-team").style.display = byTeam ? "" : "none";
    document.querySelector(".odds-by-member").style.display = byTeam ? "none" : "";
  });
</script>
</body></html>`;

const htmlPath = path.join(HERE, "index.html");
fs.writeFileSync(htmlPath, html);
fs.writeFileSync(snapPath, JSON.stringify({ savedAt: now.toISOString(), matches }, null, 0));
makePdf(htmlPath, path.join(HERE, "Family-World-Cup.pdf"));

log(`\nDone. ${playedMatches.length}/${totalMatches} matches played.`);
log(`• index.html — open to view / screenshot`);
log(`• Family-World-Cup.pdf — attach to WhatsApp`);
