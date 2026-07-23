// scripts/sync.js
//
// Pulls this director's tournament list + results from the real IFPA API,
// matches each event to its Match Play tournament (by owner + name/date),
// and writes events.json for the Squarespace widget to fetch().
//
// IFPA field mapping (confirmed from a real API response, 2026-07):
//   GET /director/{id}/tournaments/PAST?api_key=...
//     -> { tournaments: [{ tournament_id, tournament_name, event_name,
//                           event_start_date, event_end_date, player_count, ... }] }
//   GET /tournament/{id}/results?api_key=...
//     -> { tournament_id, results: [{ name, position, points, ... }] }
//        results[] is sorted by position ascending, so results[0] is the winner.
//        "points" and "position" are returned as strings — cast to number.
//
// Match Play field mapping (from docs.matchplay.events/tournaments-api):
//   GET /api/tournaments?owner={id}&limit=100&page=N
//     -> paginated list of tournaments owned by this user. Exact field names
//        for name/date/id are unconfirmed — MATCHPLAY_DEBUG below prints the
//        raw response once so we can confirm/adjust in one pass if needed.

const fs = require("fs");

const IFPA_API_KEY = process.env.IFPA_API_KEY;
const MATCHPLAY_API_TOKEN = process.env.MATCHPLAY_API_TOKEN;
const DIRECTOR_ID = 2909;
const MATCHPLAY_OWNER_ID = 25018;
const IFPA_BASE = "https://api.ifpapinball.com";
const MATCHPLAY_BASE = "https://app.matchplay.events";
const MATCHPLAY_DEBUG = true; // set to false once field mapping is confirmed

if (!IFPA_API_KEY) {
  console.error("Missing IFPA_API_KEY environment variable.");
  process.exit(1);
}
if (!MATCHPLAY_API_TOKEN) {
  console.warn("Missing MATCHPLAY_API_TOKEN — matchplayLink will be left blank for all events.");
}

async function ifpaGet(path) {
  const url = `${IFPA_BASE}${path}${path.includes("?") ? "&" : "?"}api_key=${IFPA_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

async function matchplayGet(path) {
  const res = await fetch(`${MATCHPLAY_BASE}${path}`, {
    headers: { Authorization: `Bearer ${MATCHPLAY_API_TOKEN}` }
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

function classify(name) {
  const n = name.toLowerCase();
  if (n.includes("frenzy")) return "flipfrenzy";
  if (n.includes("monday")) return "monday";
  if (n.includes("tuesday")) return "tuesday";
  if (n.startsWith("pinawarra")) return "pinawarra";
  return "other";
}

function toIsoDate(dateStr) {
  return dateStr ? dateStr.slice(0, 10) : "";
}

function pickDisplayDate(t) {
  return t.event_end_date || t.event_start_date;
}

// Loose normalization for name matching: lowercase, strip non-alphanumerics.
function normalizeName(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function fetchAllMatchplayTournaments() {
  if (!MATCHPLAY_API_TOKEN) return [];
  var all = [];
  var page = 1;
  var debugged = false;
  while (true) {
    var data = await matchplayGet(`/api/tournaments?owner=${MATCHPLAY_OWNER_ID}&limit=100&page=${page}`);

    if (MATCHPLAY_DEBUG && !debugged) {
      console.log("---- RAW MATCH PLAY RESPONSE (page 1, for field-mapping check) ----");
      console.log(JSON.stringify(data, null, 2).slice(0, 2000));
      console.log("---- end raw response ----");
      debugged = true;
    }

    var pageItems = data.tournaments || data.results || data.data || (Array.isArray(data) ? data : []);
    if (!Array.isArray(pageItems) || pageItems.length === 0) break;
    all = all.concat(pageItems);
    if (pageItems.length < 100) break;
    page++;
    await new Promise((r) => setTimeout(r, 150));
  }
  console.log(`Fetched ${all.length} Match Play tournaments for owner ${MATCHPLAY_OWNER_ID}.`);
  return all;
}

function findMatchplayLink(ifpaEvent, matchplayTournaments) {
  var targetName = normalizeName(ifpaEvent.name);
  var targetDate = ifpaEvent.date;

  var candidates = matchplayTournaments.filter(function (mt) {
    var mtName = normalizeName(mt.name || mt.title || "");
    return mtName === targetName || mtName.includes(targetName) || targetName.includes(mtName);
  });

  var pool = candidates.length > 0 ? candidates : matchplayTournaments;
  var dateMatches = pool.filter(function (mt) {
    var mtDate = toIsoDate(mt.startDate || mt.date || mt.scheduledStart || "");
    return mtDate === targetDate;
  });

  var best = (dateMatches.length === 1 ? dateMatches[0] : candidates[0]) || null;
  if (!best || !best.id) return "";
  return `${MATCHPLAY_BASE}/tournaments/${best.id}`;
}

async function main() {
  console.log(`Fetching tournament list for director ${DIRECTOR_ID}...`);
  const dirData = await ifpaGet(`/director/${DIRECTOR_ID}/tournaments/PAST`);
  const tournaments = dirData.tournaments || [];
  console.log(`Found ${tournaments.length} past tournaments.`);

  const matchplayTournaments = await fetchAllMatchplayTournaments();

  const events = [];

  for (const t of tournaments) {
    const id = t.tournament_id;
    let winner = "";
    let points = 0;

    try {
      const resultsData = await ifpaGet(`/tournament/${id}/results`);
      const results = resultsData.results || [];
      const first = Array.isArray(results) ? results[0] : null;
      if (first) {
        winner = (first.name || "").trim();
        points = parseFloat(first.points) || 0;
      }
    } catch (err) {
      console.warn(`  Could not fetch results for tournament ${id}: ${err.message}`);
    }

    const eventName = t.tournament_name || t.event_name;
    const eventDate = toIsoDate(pickDisplayDate(t));

    events.push({
      name: eventName,
      category: classify(eventName || ""),
      year: new Date(pickDisplayDate(t)).getFullYear(),
      date: eventDate,
      players: Number(t.player_count) || 0,
      winner,
      points,
      ifpaLink: `https://www.ifpapinball.com/tournaments/view.php?t=${id}`,
      matchplayLink: findMatchplayLink({ name: eventName, date: eventDate }, matchplayTournaments)
    });

    await new Promise((r) => setTimeout(r, 150));
  }

  fs.writeFileSync("events.json", JSON.stringify(events, null, 2));
  const linkedCount = events.filter((e) => e.matchplayLink).length;
  console.log(`Wrote ${events.length} events to events.json (${linkedCount} with a matched Match Play link).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
