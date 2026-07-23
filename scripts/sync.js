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
// Match Play field mapping (confirmed from a real API response, 2026-07):
//   GET /api/tournaments?owner={id}&limit=100&page=N
//     -> { data: [{ tournamentId, name, status, startUtc, startLocal,
//                    endUtc, endLocal, test, organizerId, ... }] }
//        "test": true marks template/practice tournaments that were never
//        actually played — these must be excluded from matching.
//        startLocal is "YYYY-MM-DD HH:MM:SS" — first 10 chars give the date.

const fs = require("fs");

const IFPA_API_KEY = process.env.IFPA_API_KEY;
const MATCHPLAY_API_TOKEN = process.env.MATCHPLAY_API_TOKEN;
const DIRECTOR_ID = 2909;
const MATCHPLAY_OWNER_ID = 25018;
const IFPA_BASE = "https://api.ifpapinball.com";
const MATCHPLAY_BASE = "https://app.matchplay.events";

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

function tokens(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function tokenMatches(a, b) {
  if (a === b) return true;
  if (/^\d+$/.test(a) || /^\d+$/.test(b)) return false;
  return a.length >= 3 && b.length >= 3 && (a.indexOf(b) === 0 || b.indexOf(a) === 0);
}

function nameScore(targetTokens, candidateTokens) {
  if (targetTokens.length === 0) return 0;
  var matched = 0;
  targetTokens.forEach(function (t) {
    if (candidateTokens.indexOf(t) !== -1 || candidateTokens.some(function (c) { return tokenMatches(t, c); })) {
      matched++;
    }
  });
  return matched / targetTokens.length;
}

function closestByDate(candidates, targetDate) {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  var targetTime = new Date(targetDate).getTime();
  var ranked = candidates
    .map(function (mt) {
      var d = toIsoDate(mt.startLocal || mt.startUtc || "");
      var diff = d ? Math.abs(new Date(d).getTime() - targetTime) : Infinity;
      return { mt: mt, diff: diff };
    })
    .sort(function (a, b) { return a.diff - b.diff; });
  return ranked[0].mt;
}

async function fetchAllMatchplayTournaments() {
  if (!MATCHPLAY_API_TOKEN) return [];
  var all = [];
  var page = 1;
  while (true) {
    var data = await matchplayGet(`/api/tournaments?owner=${MATCHPLAY_OWNER_ID}&limit=100&page=${page}`);
    var pageItems = data.data || [];
    if (!Array.isArray(pageItems) || pageItems.length === 0) break;
    all = all.concat(pageItems);
    if (pageItems.length < 100) break;
    page++;
    await new Promise((r) => setTimeout(r, 150));
  }
  console.log(`Fetched ${all.length} Match Play tournaments for owner ${MATCHPLAY_OWNER_ID}.`);
  return all;
}

var WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function findMatchplayLink(ifpaEvent, matchplayTournaments) {
  var targetTokens = tokens(ifpaEvent.name);

  var realTournaments = matchplayTournaments.filter(function (mt) {
    return !mt.test && !/template/i.test(mt.name || "");
  });

  var targetWeekday = targetTokens.filter(function (t) { return WEEKDAYS.indexOf(t) !== -1; })[0];
  if (targetWeekday) {
    realTournaments = realTournaments.filter(function (mt) {
      return tokens(mt.name).indexOf(targetWeekday) !== -1;
    });
  }

  var targetNumbers = targetTokens.filter(function (t) { return /^\d+$/.test(t); });
  if (targetNumbers.length > 0) {
    realTournaments = realTournaments.filter(function (mt) {
      var mtTokens = tokens(mt.name);
      return targetNumbers.every(function (n) { return mtTokens.indexOf(n) !== -1; });
    });
  }

  var candidates = realTournaments.filter(function (mt) {
    return nameScore(targetTokens, tokens(mt.name)) >= 0.7;
  });

  var best = closestByDate(candidates, ifpaEvent.date);
  if (!best || !best.tournamentId) return "";
  return `${MATCHPLAY_BASE}/tournaments/${best.tournamentId}`;
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
