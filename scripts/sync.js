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

// Word-based name matching, tolerant of abbreviations IFPA/Match Play use
// inconsistently (e.g. IFPA writes "Seas 4", Match Play writes "Season 4").
function tokens(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

// Two tokens are considered a match if identical, or if one is a prefix of
// the other (handles Seas/Season, Tues/Tuesday, etc.) — except numbers,
// which must match exactly since they usually carry the most meaning
// (season number, year).
function tokenMatches(a, b) {
  if (a === b) return true;
  if (/^\d+$/.test(a) || /^\d+$/.test(b)) return false;
  return a.length >= 3 && b.length >= 3 && (a.indexOf(b) === 0 || b.indexOf(a) === 0);
}

// Fraction of the IFPA event's name-words found (loosely) in a candidate's name.
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

// Among several same-name candidates (e.g. many "Flip Frenzy" entries),
// pick whichever has the closest date to the IFPA event's date.
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

// Match Play sometimes numbers events with Roman numerals instead of
// Arabic digits (e.g. "Pinawarra XXVIII" for Pinawarra 28, "Pinawarra X
// Qualifying" for Pinawarra 10). Convert any Roman-numeral-looking token
// to its Arabic value so number matching still works either way. Capped
// at 200 and 8 characters to avoid misreading ordinary English words that
// happen to consist only of the letters I/V/X/L/C/D/M (rare, but possible).
function romanToInt(s) {
  var map = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  s = s.toUpperCase();
  var total = 0;
  for (var i = 0; i < s.length; i++) {
    var cur = map[s[i]];
    if (!cur) return null;
    var next = map[s[i + 1]];
    total += next && cur < next ? -cur : cur;
  }
  return total;
}

function normalizeRomanTokens(toks) {
  return toks.map(function (t) {
    if (/^[ivxlcdm]+$/i.test(t) && t.length <= 8) {
      var val = romanToInt(t);
      if (val && val > 0 && val <= 200) return String(val);
    }
    return t;
  });
}

// A small number of events use naming so different on Match Play (e.g.
// "Pinawarra Major" instead of "Pinawarra 24") that no name/number rule
// can reliably catch them without risking false matches elsewhere. Add
// entries here as {"<exact IFPA event name>": <matchplay tournamentId>}
// when you spot one — this always takes priority over automated matching.
// NOTE: this only works for events that exist in IFPA's own tournament
// list — if a Match Play tournament has no corresponding IFPA record at
// all (never submitted/sanctioned), there's no event row to attach a
// link to, and no override can fix that.
var MANUAL_MATCHPLAY_OVERRIDES = {
  "Pinawarra 24": 191785,
  "Pinawarra 13": 146293
};

// Bracket/knockout stages and side-competitions are never the right link —
// only the qualifying round itself should ever be used. Unlike an earlier
// version of this logic, there is NO fallback to these: if no genuine
// qualifier match exists, the event is left blank (falls back to the
// director's profile link) rather than pointing at a Semi Final, Top 8,
// tiebreaker, or similar.
var ELIMINATION_TYPE_REGEX = /elimination|knockout/i;
var NON_QUALIFIER_NAME_REGEX = /\bfinal(s)?\b|\bsemi(s)?(\s*final(s)?)?\b|\bquarter(s)?(\s*final(s)?)?\b|\btop\s*\d+\b|\bplay[\s-]?off(s)?\b|\bround of \d+\b|\bseeding\b|\bbest of the rest\b|\bwildcard\b|\bconsolation\b|\bplate\b|\btie[\s-]?breaker\b|\(?\s*\d+(st|nd|rd|th)?\s*-\s*\d+(st|nd|rd|th)\b\s*\)?/i;

function findMatchplayLink(ifpaEvent, matchplayTournaments) {
  if (Object.prototype.hasOwnProperty.call(MANUAL_MATCHPLAY_OVERRIDES, ifpaEvent.name)) {
    return `${MATCHPLAY_BASE}/tournaments/${MANUAL_MATCHPLAY_OVERRIDES[ifpaEvent.name]}`;
  }

  var targetTokens = tokens(ifpaEvent.name);

  // Exclude test/template tournaments — these show up in the owner's list
  // but were never actually played and shouldn't be matched to real events.
  // Also exclude side/consolation events (e.g. "Best of the Rest") entirely.
  var realTournaments = matchplayTournaments.filter(function (mt) {
    return !mt.test
      && !/template/i.test(mt.name || "")
      && !NON_QUALIFIER_NAME_REGEX.test(mt.name || "")
      && !ELIMINATION_TYPE_REGEX.test(mt.type || "");
  });

  // If the IFPA name names a specific day of the week (Monday League vs
  // Tuesday League run in parallel with near-identical names otherwise),
  // require an EXACT match on that word first — a fuzzy score alone lets
  // a wrong-day tournament through when 5 of 6 words still line up.
  var targetWeekday = targetTokens.filter(function (t) { return WEEKDAYS.indexOf(t) !== -1; })[0];
  if (targetWeekday) {
    realTournaments = realTournaments.filter(function (mt) {
      return tokens(mt.name).indexOf(targetWeekday) !== -1;
    });
  }

  // Same problem with numbers (season number, year, event number): a fuzzy
  // score alone lets "Season 5" match an IFPA event for "Season 4" through,
  // because only 1 of 6 words differs. Numbers carry the most distinguishing
  // meaning here, so every number in the IFPA name must appear EXACTLY in
  // the candidate — not just count toward an overall percentage.
  // EXCEPTION: IFPA sometimes encodes the date into the name itself, e.g.
  // "Flip Frenzy 160726" for 16/07/26 — that's not a real identifier and
  // won't appear literally in Match Play's name, so long digit strings
  // (5+ digits) are left out of this check and handled by date-closeness
  // matching instead, the same way plain "Flip Frenzy" (no number) already is.
  var targetNumbers = targetTokens.filter(function (t) { return /^\d+$/.test(t) && t.length <= 4; });
  if (targetNumbers.length > 0) {
    realTournaments = realTournaments.filter(function (mt) {
      var mtTokens = normalizeRomanTokens(tokens(mt.name));
      return targetNumbers.every(function (n) { return mtTokens.indexOf(n) !== -1; });
    });
  }

  // Require most (70%+) of the IFPA name's meaningful words to appear in
  // the Match Play tournament's name, tolerant of abbreviations. Long
  // digit-string tokens (date codes, see above) are excluded here too —
  // otherwise a name like "Flip Frenzy 160726" only scores 2/3 (67%) since
  // that code will never appear in Match Play's name, dropping it below
  // the threshold even though "Flip" and "Frenzy" both matched.
  var scorableTokens = targetTokens.filter(function (t) { return !/^\d{5,}$/.test(t); });
  var candidates = realTournaments.filter(function (mt) {
    return nameScore(scorableTokens, normalizeRomanTokens(tokens(mt.name))) >= 0.7;
  });

  // If nothing matched by name, don't guess by date alone across all 800+
  // tournaments — leaving it blank (falls back to the profile link) is
  // safer than risking a link to the wrong event.
  var best = closestByDate(candidates, ifpaEvent.date);
  if (!best || !best.tournamentId) return "";

  // Monday/Tuesday leagues: link the whole series (season) instead of one
  // week's tournament, since the league spans many weeks under one series.
  if ((ifpaEvent.category === "monday" || ifpaEvent.category === "tuesday") && best.seriesId) {
    return `${MATCHPLAY_BASE}/series/${best.seriesId}`;
  }

  return `${MATCHPLAY_BASE}/tournaments/${best.tournamentId}`;
}

// Finds the most recent real (non-test) Monday or Tuesday league night on
// Match Play and fetches its arena list — this is what actually maps to
// "which machines are currently in the lineup", since the weekly league
// reflects the current machine set better than a special event like
// Pinawarra (which sometimes runs on an expanded/different selection).
async function fetchLatestMachines(all) {
  if (!MATCHPLAY_API_TOKEN) {
    console.warn("Missing MATCHPLAY_API_TOKEN — skipping machines.json.");
    return [];
  }

  const today = toIsoDate(new Date().toISOString());

  const real = all.filter((mt) => !mt.test && !/template/i.test(mt.name || ""));

  const leagueNights = real.filter((mt) => {
    const n = tokens(mt.name);
    const isLeague = (n.indexOf("monday") !== -1 || n.indexOf("tuesday") !== -1) && n.indexOf("league") !== -1;
    if (!isLeague) return false;
    // Only consider nights that have actually happened — Match Play's
    // tournament list includes future scheduled weeks too (status
    // "planned"), and those don't have real arena data yet. A pure
    // "latest date" sort would otherwise grab next week instead of the
    // most recent one that was actually played.
    const isPast = mt.status === "completed" || toIsoDate(mt.startLocal || mt.startUtc || "") <= today;
    return isPast;
  });

  if (leagueNights.length === 0) {
    console.warn("Could not find any past Monday/Tuesday league tournaments to pull machines from.");
    return [];
  }

  leagueNights.sort((a, b) => {
    const da = toIsoDate(a.startLocal || a.startUtc || "");
    const db = toIsoDate(b.startLocal || b.startUtc || "");
    return da < db ? 1 : -1;
  });

  const latest = leagueNights[0];
  console.log(`Pulling machine list from: "${latest.name}" (${toIsoDate(latest.startLocal || latest.startUtc || "")}, status: ${latest.status})`);

  const detail = await matchplayGet(`/api/tournaments/${latest.tournamentId}?includeArenas=true`);
  const tournamentObj = detail.data || detail;

  console.log("---- RAW ARENA RESPONSE (for field-mapping check) ----");
  console.log(JSON.stringify(tournamentObj.arenas, null, 2).slice(0, 2000));
  console.log("---- end raw response ----");

  const arenas = tournamentObj.arenas || [];
  const names = arenas
    .map((a) => ({
      name: (a.name || a.arenaName || "").trim(),
      active: (a.status || "").toLowerCase() === "active"
    }))
    .filter((m) => m.name)
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    sourceName: latest.name,
    sourceDate: toIsoDate(latest.startLocal || latest.startUtc || ""),
    machines: names
  };
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
    const eventCategory = classify(eventName || "");

    events.push({
      name: eventName,
      category: eventCategory,
      year: new Date(pickDisplayDate(t)).getFullYear(),
      date: eventDate,
      players: Number(t.player_count) || 0,
      winner,
      points,
      ifpaLink: `https://www.ifpapinball.com/tournaments/view.php?t=${id}`,
      matchplayLink: findMatchplayLink({ name: eventName, date: eventDate, category: eventCategory }, matchplayTournaments)
    });

    await new Promise((r) => setTimeout(r, 150));
  }

  fs.writeFileSync("events.json", JSON.stringify(events, null, 2));
  const linkedCount = events.filter((e) => e.matchplayLink).length;
  console.log(`Wrote ${events.length} events to events.json (${linkedCount} with a matched Match Play link).`);

  try {
    const machinesData = await fetchLatestMachines(matchplayTournaments);
    fs.writeFileSync("machines.json", JSON.stringify(machinesData, null, 2));
    console.log(`Wrote ${machinesData.machines ? machinesData.machines.length : 0} machines to machines.json.`);
  } catch (err) {
    console.warn(`Could not update machines.json: ${err.message}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
