// Load artists into the song catalog. Apple rate-limits its search API from Cloudflare,
// so search runs here and the Worker verifies each track with Apple's lookup API.
// Usage: node seed.mjs [api-base] [artist ...]
const API = process.argv[2] || "https://psalmless-api.psalmless-api.workers.dev/api";
const DEFAULT = [
  "Elevation Worship", "Hillsong Worship", "Hillsong UNITED", "Bethel Music", "Chris Tomlin",
  "Phil Wickham", "Lauren Daigle", "for KING & COUNTRY", "Casting Crowns", "MercyMe",
  "TobyMac", "Maverick City Music", "Brandon Lake", "Newsboys", "Third Day", "Jeremy Camp",
  "Matt Redman", "Michael W. Smith", "Amy Grant", "Kari Jobe", "Crowder", "Zach Williams",
  "Switchfoot", "Skillet", "Lecrae", "Kirk Franklin", "CeCe Winans", "Tauren Wells",
  "Passion", "Jesus Culture", "Big Daddy Weave", "Rich Mullins", "dc Talk", "Keith & Kristyn Getty",
  "Sidewalk Prophets", "Matthew West", "Hillsong Young & Free", "Tasha Cobbs Leonard",
  "Steven Curtis Chapman", "Audio Adrenaline", "Jars of Clay", "Building 429", "Cory Asbury",
  "Chris Renzema", "Pat Barrett", "We The Kingdom", "Anne Wilson", "Sanctus Real",
  "SEU Worship", "Red Rocks Worship", "Gateway Worship", "UPPERROOM", "Rivers & Robots", "Vertical Worship",
  "CityAlight", "Sovereign Grace Music", "Housefires", "Influence Music", "Mosaic MSC", "Life.Church Worship",
  "Circuit Rider Music", "Planetshakers", "VOUS Worship", "North Point Worship", "Cross Worship",
  "Forerunner Music", "Worship Together", "Leeland", "Jon Reddick", "Josh Baldwin", "Bryan & Katie Torwalt",
  "Citipointe Worship", "Shane & Shane", "Kristene DiMarco", "Jenn Johnson", "Chandler Moore", "Naomi Raine",
  "Cody Carnes", "Brooke Ligertwood", "Matt Maher", "All Sons & Daughters",
  "Kim Walker-Smith", "Tribl", "Jesus Image", "Worship Central",
  "Rend Collective", "Austin Stone Worship", "The Belonging Co", "Hope Darst", "Jonathan & Melissa Helser",
  "Seacoast Worship", "Christ For The Nations Worship", "One Voice"
];
const names = process.argv.length > 3 ? process.argv.slice(3) : DEFAULT;
const sleep = ms => new Promise(r => setTimeout(r, ms));

for (const name of names) {
  let data;
  for (let tries = 0; ; tries++) {
    const res = await fetch("https://itunes.apple.com/search?" + new URLSearchParams({ term: name, entity: "song", attribute: "artistTerm", limit: 200, country: "US" }));
    if (res.ok) { data = await res.json(); break; }
    if (tries > 4) { console.log(`${name}: search failed (${res.status})`); break; }
    await sleep(15000);
  }
  if (!data) continue;
  const tracks = data.results.filter(r => r.previewUrl && r.artistName.toLowerCase().includes(name.toLowerCase()))
    .map(r => [r.trackId, (r.artworkUrl100 || "").replace("100x100", "300x300")]);
  const res = await fetch(API + "/artists", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, tracks }) });
  console.log(`${name}: ${res.ok ? (await res.json()).songs + " songs" : "error " + res.status + " " + await res.text()}`);
  await sleep(3500); // Apple allows about 20 searches a minute
}
