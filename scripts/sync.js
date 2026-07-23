// scripts/sync.js
//
// Pulls this director's tournament list + results from the real IFPA API
// and writes events.json for the Squarespace widget to fetch().
//
// Confirmed against the live OpenAPI spec (api.ifpapinball.com/docs/api.json):
//   GET /director/{id}/tournaments/{PAST|FUTURE}?api_key=...
//     -> { tournaments: [{ tournament_id, tournament_name, event_name,
//                           city, event_start_date, event_end_date,
//                           qualifying_format, finals_format, player_count }] }
//
// The per-tournament results endpoint (viewTournamentResults) exists at
// GET /tournament/{id}/results?api_key=... but the spec was too large to
// pull in full — its exact field names are inferred from the consistent
// pattern used elsewhere in the API (position, wppr_points, first_name/
// last_name). FIRST_RUN_DEBUG below prints the raw response for one
// tournament so we can confirm/adjust field names in one pass if needed.

const fs = require("fs");

const API_KEY = process.env.IFPA_API_KEY;
const DIRECTOR_ID = 2909;
const BASE = "https://api.ifpapinball.com";
const FIRST_RUN_DEBUG = true; // set to false once field mapping is confirmed

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

async function main() {
  console.log(`Fetching tournament list for director ${DIRECTOR_ID}...`);
  const dirData = await apiGet(`/director/${DIRECTOR_ID}/tournaments/PAST`);
  const tournaments = dirData.tournaments || [];
  console.log(`Found ${tournaments.length} past tournaments.`);

  const events = [];
  let debugged = false;

  for (const t of tournaments) {
    const id = t.tournament_id;
    let winner = "";
    let points = 0;

    try {
      const resultsData = await apiGet(`/tournament/${id}/results`);

      if (FIRST_RUN_DEBUG && !debugged) {
        console.log("---- RAW RESPONSE for first tournament (for field-mapping check) ----");
        console.log(JSON.stringify(resultsData, null, 2).slice(0, 2000));
        console.log("---- end raw response ----");
        debugged = true;
      }

      const results = resultsData.results || resultsData.standings || [];
      const first = Array.isArray(results) ? results[0] : null;

      if (first) {
        winner =
          first.player_name ||
          [first.first_name, first.last_name].filter(Boolean).join(" ") ||
          "";
        points = first.wppr_points ?? first.current_points ?? first.points ?? 0;
      }
    } catch (err) {
      console.warn(`  Could not fetch results for tournament ${id}: ${err.message}`);
    }

    events.push({
      name: t.tournament_name || t.event_name,
      category: classify(t.tournament_name || ""),
      year: new Date(t.event_start_date).getFullYear(),
      date: toIsoDate(t.event_start_date),
      players: t.player_count || 0,
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
