# Mile 17 — Table Arcade

A QR-scanned arcade for the benches at 7 Midway Plaza. A guest scans the code
at their table, watches a short 17-years film, and is dealt one prize game —
Jackpot or Spin the Wheel, never both. One guest in fifty wins a reward, which
they show to their steward. Everyone else gets ten more games to play while
their food comes up.

Everything runs on one free Cloudflare account. There is no build step and no
framework — the arcade is a single self-contained HTML file.

**If you are setting this up for the first time, open `START-HERE.html` in a
browser.** It walks through the whole thing with the buttons named as they
appear on screen. This README is the short version.

## What's in here

| Path | What it is |
|---|---|
| `1-arcade/index.html` | The arcade itself. This is the only thing guests ever load. |
| `2-server/mile17-pass-worker.js` | The pass server. Enforces one go per device per day. |
| `2-server/schema.sql` | Run once in the D1 console to create the table. |
| `3-tools/qr-sheet.html` | Makes the printable bench QR code. |
| `3-tools/preview-build.html` | Every lock off, for demos. **Never deploy this.** |
| `START-HERE.html` | The illustrated setup guide. |

## Deploying

### The page — Cloudflare Pages

Connect this repository under **Workers & Pages → Create → Pages → Connect to
Git**, then set:

- **Build command:** leave empty
- **Build output directory:** `1-arcade`

That output directory matters. Pointing Pages at the repository root would
publish `3-tools/preview-build.html` as well, and that build lets anyone force
a win.

Once connected, every push to `main` deploys itself.

### The pass server — Cloudflare Workers + D1

1. **D1 → Create database**, name it `mile17`, run `2-server/schema.sql` in its
   console.
2. **Workers → Create**, paste in `2-server/mile17-pass-worker.js`.
3. Bind the database to that worker as `DB`.
4. Set two variables: `ALLOW_ORIGIN` (your Pages address, no trailing slash)
   and `RESET_KEY` (any password — the reset action refuses to run without it).
5. Put the worker's address into `PASS_API` near the top of
   `1-arcade/index.html`, commit, push.

## Nothing secret lives in this repository

`RESET_KEY` is set in the Cloudflare dashboard and never appears in a file.
`PASS_API` is a public endpoint that only answers questions about the device
asking, so it is safe to commit.

The only thing the server ever stores is a fingerprint hash — screen size,
graphics chip, core count, timezone. It cannot be turned back into a phone, a
name or a person, and rows older than two days delete themselves.

## After a change

Commit and push. Pages redeploys on its own, and the printed QR codes never
change because they point at the address, not at a version.

Before pushing anything that touches the prize logic, open
`3-tools/preview-build.html` and force a win and a miss in both games.
