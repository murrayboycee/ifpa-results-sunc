// scripts/sync.js
const fs = require("fs");

const API_KEY = process.env.IFPA_API_KEY;
const DIRECTOR_ID = 2909; // your IFPA director ID

if (!API_KEY) {
  console.error("Missing IFPA_API_KEY environment variable.");
  process.exit(1);
}

async function main() {
  // TODO: replace with the real endpoint once confirmed from api.ifpapinball.com/docs
  const events = []; // will hold { name, winner, points, ifpaLink, matchplayLink, ... }

  fs.writeFileSync("events.json", JSON.stringify(events, null, 2));
  console.log(`Wrote ${events.length} events to events.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
