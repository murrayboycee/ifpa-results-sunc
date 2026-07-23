// scripts/sync.js
//
// Pulls this director's tournament list + results from the real IFPA API
// and writes events.json for the Squarespace widget to fetch().
//
// Confirmed field mapping (from a real API response, 2026-07):
//   GET /director/{id}/tournaments/PAST?api_key=...
//     -> { tournaments: [{ tournament_id, tournament_name, event_name,
//                           event_start_date, event_end_date, player_count, ... }] }
//   GET /tournament/{id}/results?api_key=...
//     -> { tournament_id, results: [{ name, position, points, ... }] }
//        results[] is sorted by position ascending, so results[0] is the winner.
//        "points" and "position" are returned as strings — cast to number.

const fs = require("fs");

const API_KEY = process.env.IFPA_API_KEY;
const DIRECTOR_ID = 2909;
const BASE = "https://api.ifpapinball.com";

if (!API_KEY) {
  console.error("Missing IFPA_API_KEY environment variable.");
  process.exit(1);
}

async function apiGet(path) {
  const url = `${BASE}${path}${path.includes("?") ? "&" : "?"}api_key=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${path} -> HTTP ${res.status}`);
  }
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

// Leagues report event_start_date as the season's first meeting and
// event_end_date as the last — the director page displays event_end_date
// as "Date", so we match that for consistency with the public site.
function pickDisplayDate(t) {
  return t.event_end_date || t.event_start_date;
}

async function main() {
  console.log(`Fetching tournament list for director ${DIRECTOR_ID}...`);
  const dirData = await apiGet(`/director/${DIRECTOR_ID}/tournaments/PAST`);
  const tournaments = dirData.tournaments || [];
  console.log(`Found ${tournaments.length} past tournaments.`);

  const events = [];

  for (const t of tournaments) {
    const id = t.tournament_id;
    let winner = "";
    let points = 0;

    try {
      const resultsData = await apiGet(`/tournament/${id}/results`);
      const results = resultsData.results || [];
      const first = Array.isArray(results) ? results[0] : null;

      if (first) {
        winner = (first.name || "").trim();
        points = parseFloat(first.points) || 0;
      }
    } catch (err) {
      console.warn(`  Could not fetch results for tournament ${id}: ${err.message}`);
    }

    events.push({
      name: t.tournament_name || t.event_name,
      category: classify(t.tournament_name || ""),
      year: new Date(pickDisplayDate(t)).getFullYear(),
      date: toIsoDate(pickDisplayDate(t)),
      players: Number(t.player_count) || 0,
      winner,
      points,
      ifpaLink: `https://www.ifpapinball.com/tournaments/view.php?t=${id}`,
      matchplayLink: ""
    });

    await new Promise((r) => setTimeout(r, 150));
  }

  fs.writeFileSync("events.json", JSON.stringify(events, null, 2));
  console.log(`Wrote ${events.length} events to events.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
