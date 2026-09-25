/**
 * Mile 17 — day pass server (Cloudflare Worker + D1)
 * ---------------------------------------------------------------
 * One device, one go, from midnight to midnight in the restaurant's own
 * timezone. This is the thing a second browser cannot lie to.
 *
 * It owns three decisions that must not live on the phone:
 *   - what "today" is          (computed in IST, not from the device clock)
 *   - which prize game a guest is dealt, and how many pulls it carries
 *   - whether they win         (1 in 50, drawn once per guest per day)
 *
 * WHY D1 AND NOT KV
 * At 400 guests a day this writes roughly 2,000 records. Workers KV allows
 * 1,000 writes a day on the free plan and then hard-fails until midnight
 * UTC, so the arcade would stop handing out passes by mid-afternoon. D1's
 * free plan allows 100,000 row writes a day — fifty times the headroom,
 * for the same money: none.
 *
 * HOW THIS IS DEPLOYED
 * This Worker serves the arcade page and answers /pass, from one address.
 * wrangler.toml in the repository root points `main` at this file and
 * `[assets]` at the folder holding index.html, so a push to GitHub deploys
 * both together. The only things set by hand are the D1 database id in
 * wrangler.toml and RESET_KEY as a secret in the dashboard.
 *
 * THE SQL FOR STEP 2
 *   CREATE TABLE IF NOT EXISTS passes (
 *     id      TEXT PRIMARY KEY,
 *     day     TEXT NOT NULL,
 *     game    TEXT NOT NULL,
 *     tries   INTEGER NOT NULL,
 *     spent   INTEGER NOT NULL DEFAULT 0,
 *     win_on  INTEGER,
 *     won     INTEGER NOT NULL DEFAULT 0,
 *     code    TEXT,
 *     intro   INTEGER NOT NULL DEFAULT 0,
 *     created TEXT NOT NULL
 *   );
 *   CREATE INDEX IF NOT EXISTS passes_day ON passes(day);
 *
 * CLEARING A PASS
 * The page cannot reset itself — no URL, no button, nothing a guest or a
 * phone at the table can reach. Clearing one is an operator action:
 *
 *   curl -X POST https://<your-worker>/pass \
 *     -H 'Content-Type: application/json' \
 *     -d '{"action":"reset","device":"<device id>","key":"<RESET_KEY>"}'
 *
 * Set RESET_KEY before going live or that action is open to anyone who
 * knows the URL.
 *
 * Yesterday's rows are swept out on a small fraction of requests, so the
 * table stays at roughly a day of guests. Nothing personal is kept — only
 * a fingerprint hash, which cannot be turned back into a phone, a name or
 * a number.
 */

const ODDS  = 50;                       // one guest in fifty
const TRIES = { spin: 3, wheel: 2 };    // Jackpot gives three pulls, the wheel two
const GAMES = ['spin', 'wheel'];
const TZ_OFFSET_MIN = 330;              // IST, UTC+5:30
const KEEP_DAYS = 2;

/* "Today" in the restaurant's timezone. Deliberately not the device's idea
   of the date, which anyone can change in Settings. */
function dayKey(now = new Date()) {
  const local = new Date(now.getTime() + TZ_OFFSET_MIN * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())}`;
}
function daysAgo(n) {
  return dayKey(new Date(Date.now() - n * 86400000));
}

function makeCode(table) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let tail = '';
  for (let i = 0; i < 4; i++) tail += alphabet[Math.floor(Math.random() * alphabet.length)];
  const t = String(table || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 3);
  return 'MWP-R' + (t ? t + '-' : '') + tail;
}

/* A brand new pass. The draw happens here, once, and the winning pull is
   pinned in advance — so three pulls give drama, not better odds. */
/* Exactly one winner in every 50 guests - not a 1-in-50 chance each, which
   can give three winners in 50 or none in 150. The day's new guests are
   counted in blocks of 50, and one position in each block is the winner.
   Which position is decided by a secret, so nobody can time a scan to land
   on it. A guest only ever gets one draw a day, however many pulls or spins
   their game gives them. */
async function drawForNewGuest(env, day) {
  try {
    const row = await env.DB.prepare(
      'INSERT INTO draws (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1 RETURNING n'
    ).bind(day).first();
    const seq = row && row.n ? row.n : 1;                 // this guest is the nth new guest today
    const block = Math.floor((seq - 1) / ODDS), pos = (seq - 1) % ODDS;
    const secret = env.DRAW_SECRET || env.RESET_KEY || 'mile17-draw';
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret + '|' + day + '|' + block));
    const slot = new DataView(h).getUint32(0) % ODDS;
    return pos === slot;
  } catch (e) {
    return Math.floor(Math.random() * ODDS) === 0;       // counter unavailable: fall back to the plain 1-in-50
  }
}

function freshPass(id, day, wins) {
  const game = GAMES[Math.floor(Math.random() * GAMES.length)];
  const tries = TRIES[game];
  return {
    id, day, game, tries,
    spent: 0,
    win_on: wins ? Math.floor(Math.random() * tries) : null,
    won: 0,
    code: null,
    intro: 0,
    created: new Date().toISOString()
  };
}

function cors(env) {
  // The page is served by this same Worker, so these headers are only a
  // courtesy for anyone who later splits the two onto separate addresses.
  return {
    'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}
function json(body, env, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(env) }
  });
}

/* What the phone is allowed to see. win_on stays here — handing it over
   would let a guest read the result before spinning. */
function publicView(p) {
  return {
    ok: true,
    day: p.day,
    game: p.game,
    tries: p.tries,
    spent: p.spent,
    intro: !!p.intro,
    won: !!p.won,
    code: p.won ? p.code : null
  };
}

let schemaChecked = false;
async function ensureSchema(db) {
  if (schemaChecked) return;
  await db.exec(
    'CREATE TABLE IF NOT EXISTS passes (id TEXT PRIMARY KEY, day TEXT NOT NULL, ' +
    'game TEXT NOT NULL, tries INTEGER NOT NULL, spent INTEGER NOT NULL DEFAULT 0, ' +
    'win_on INTEGER, won INTEGER NOT NULL DEFAULT 0, code TEXT, ' +
    'intro INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL)'
  );
  // Added later: a scrambled code for "this phone on this connection".
  // Older databases get the column on the first request; if it is already
  // there the database says so and nothing changes.
  try { await db.exec('ALTER TABLE passes ADD COLUMN net TEXT'); } catch (e) {}
  try { await db.exec('CREATE TABLE IF NOT EXISTS draws (day TEXT PRIMARY KEY, n INTEGER NOT NULL)'); } catch (e) {}
  try { await db.exec('CREATE INDEX IF NOT EXISTS passes_net ON passes(day, net)'); } catch (e) {}
  schemaChecked = true;
}

/* Rescanning the QR code often opens the link somewhere with empty storage -
   a private tab, a scanner app's own browser, a different browser - so the
   guest's private ID is lost and they look new. The same phone on the same
   internet connection is still the same person, so the server also keeps a
   code made from the phone's details plus its connection, and a "new" guest
   who matches a go already started in the last few hours carries on with
   that go instead of starting another.

   Only a one-way scrambled code is stored, never the connection address
   itself. On mobile data the connection is usually unique to the phone; on
   shared Wi-Fi, two phones of exactly the same model can match - which is
   why the match only lasts for the length of a visit. */
const TWIN_HOURS = 3;
async function netCode(request, fp) {
  if (!fp) return null;
  let ip = request.headers.get('CF-Connecting-IP') || '';
  if (!ip) return null;
  if (ip.includes(':')) ip = ip.split(':').slice(0, 4).join(':');   // IPv6: the phone's own network part
  const data = new TextEncoder().encode('mile17|' + fp + '|' + ip);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function insert(db, p) {
  await db.prepare(
    'INSERT INTO passes (id, day, game, tries, spent, win_on, won, code, intro, created, net) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(p.id, p.day, p.game, p.tries, p.spent, p.win_on, p.won, p.code, p.intro, p.created, p.net || null).run();
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;

    // Anything that is not the pass endpoint is the arcade itself. Static
    // assets are served before this runs, so reaching here with another path
    // means the file genuinely is not there.
    if (path !== '/pass') {
      return env.ASSETS
        ? env.ASSETS.fetch(request)
        : new Response('Not found', { status: 404 });
    }

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(env) });
    if (request.method !== 'POST') return json({ ok: false, error: 'POST only' }, env, 405);
    if (!env.DB) return json({ ok: false, error: 'D1 not bound as DB' }, env, 500);

    let body;
    try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, env, 400); }

    const device = String(body.device || '').slice(0, 64);
    if (!device) return json({ ok: false, error: 'no device' }, env, 400);

    await ensureSchema(env.DB);

    const day = dayKey();
    let id = `${day}:${device}`;
    const fp = String(body.browser || '').slice(0, 64);
    const net = (fp && fp !== device) ? await netCode(request, fp) : null;

    let pass = await env.DB.prepare('SELECT * FROM passes WHERE id = ?').bind(id).first();
    if (!pass && net && body.action !== 'reset') {
      const since = new Date(Date.now() - TWIN_HOURS * 3600000).toISOString();
      const twin = await env.DB.prepare(
        'SELECT * FROM passes WHERE day = ? AND net = ? AND created > ? ORDER BY created DESC LIMIT 1'
      ).bind(day, net, since).first();
      if (twin) { pass = twin; id = twin.id; }       // same phone, fresh storage: carry on with its go
    }

    switch (body.action) {
      case 'open': {
        // Only ever writes on the first load of the day. Every later open is
        // a read, which is what keeps this inside the free plan.
        if (!pass) {
          pass = freshPass(id, day, await drawForNewGuest(env, day)); pass.net = net;
          await insert(env.DB, pass);
          // Sweep yesterday out now and then rather than on a schedule.
          if (Math.random() < 0.02) {
            // Winners are kept for good, so the restaurant can always count
            // them. Only non-winning rows are tidied away after KEEP_DAYS.
            const job = env.DB.prepare('DELETE FROM passes WHERE day < ? AND won = 0').bind(daysAgo(KEEP_DAYS)).run();
            if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
          }
        }
        return json(publicView(pass), env);
      }

      case 'intro': {
        if (!pass) { pass = freshPass(id, day, await drawForNewGuest(env, day)); pass.net = net; pass.intro = 1; await insert(env.DB, pass); }
        else if (!pass.intro) {
          pass.intro = 1;
          await env.DB.prepare('UPDATE passes SET intro = 1 WHERE id = ?').bind(id).run();
        }
        return json(publicView(pass), env);
      }

      case 'play': {
        if (!pass) { pass = freshPass(id, day, await drawForNewGuest(env, day)); pass.net = net; await insert(env.DB, pass); }
        // Already spent: hand back what happened, never a second draw.
        if (pass.spent >= pass.tries) {
          return json({ ...publicView(pass), hit: false, spent: pass.spent, tries: pass.tries }, env);
        }
        const attempt = pass.spent;
        const hit = pass.win_on === attempt;
        pass.spent = hit ? pass.tries : pass.spent + 1;   // a win ends the round on the spot
        if (hit) {
          pass.won = 1;
          pass.code = pass.code || makeCode(body.table);
        }
        await env.DB.prepare('UPDATE passes SET spent = ?, won = ?, code = ? WHERE id = ?')
          .bind(pass.spent, pass.won, pass.code, id).run();
        return json({ ...publicView(pass), hit, spent: pass.spent, tries: pass.tries }, env);
      }

      /* Staff only, and guarded by RESET_KEY. */
      case 'reset': {
        // Fails closed. If RESET_KEY was never set, resetting is off entirely
        // rather than open to anyone who knows the URL.
        if (!env.RESET_KEY || body.key !== env.RESET_KEY) {
          return json({ ok: false, error: 'not allowed' }, env, 403);
        }
        await env.DB.prepare('DELETE FROM passes WHERE id = ?').bind(id).run();
        if (net) await env.DB.prepare('DELETE FROM passes WHERE day = ? AND net = ?').bind(day, net).run();
        return json({ ok: true, reset: true }, env);
      }

      default:
        return json({ ok: false, error: 'unknown action' }, env, 400);
    }
  }
};
