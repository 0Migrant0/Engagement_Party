/*
  Worker للدعوة: يقدّم الصفحة من الأصول الثابتة + واجهة تهاني الزوار عبر D1
  GET  /api/wishes  → { wishes: [...], total: n }
  POST /api/wishes  → { ok: true, wish: {...}, total: n }
*/
const MAX_STORED = 500;
const MIN_GAP_MS = 8000;

const CORS_HEADERS = {
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400'
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS }
  });
}

const clean = (s, max) =>
  String(s == null ? '' : s)
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

let schema = null;
function ensureSchema(env) {
  if (!schema) {
    schema = env.DB
      .prepare(
        'CREATE TABLE IF NOT EXISTS wishes (' +
          'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
          'name TEXT NOT NULL, ' +
          'text TEXT NOT NULL, ' +
          'ts INTEGER NOT NULL, ' +
          'ip TEXT)'
      )
      .run()
      .catch((err) => {
        schema = null;
        throw err;
      });
  }
  return schema;
}

async function listWishes(env) {
  await ensureSchema(env);
  const rows = await env.DB
    .prepare('SELECT id, name, text, ts FROM wishes ORDER BY id DESC LIMIT 200')
    .all();
  const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM wishes').first('n');
  return json({ wishes: rows.results || [], total: Number(total) || 0 });
}

async function hashIp(request) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('wish:' + ip));
  return [...new Uint8Array(buf).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function addWish(request, env) {
  let body;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return json({ ok: false, error: 'تعذّر قراءة الرسالة.' }, 400);
  }

  const name = clean(body.name, 40);
  const text = clean(body.text, 240);
  if (name.length < 2) return json({ ok: false, error: 'اكتبوا الاسم أولاً.' }, 400);
  if (text.length < 2) return json({ ok: false, error: 'اكتبوا تهنئة قصيرة (حرفين على الأقل).' }, 400);

  await ensureSchema(env);
  const ip = await hashIp(request);
  const now = Date.now();

  const last = await env.DB
    .prepare('SELECT ts FROM wishes WHERE ip = ? ORDER BY id DESC LIMIT 1')
    .bind(ip)
    .first('ts');
  if (last && now - Number(last) < MIN_GAP_MS) {
    return json({ ok: false, error: 'لحظة واحدة فقط… أرسلوا تهنئة أخرى بعد قليل.' }, 429);
  }

  const res = await env.DB
    .prepare('INSERT INTO wishes (name, text, ts, ip) VALUES (?, ?, ?, ?)')
    .bind(name, text, now, ip)
    .run();

  await env.DB
    .prepare('DELETE FROM wishes WHERE id NOT IN (SELECT id FROM wishes ORDER BY id DESC LIMIT ?)')
    .bind(MAX_STORED)
    .run();

  const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM wishes').first('n');
  const id = (res.meta && res.meta.last_row_id) || 0;
  return json({ ok: true, wish: { id, name, text, ts: now }, total: Number(total) || 0 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/wishes') {
      try {
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
        if (request.method === 'GET') return await listWishes(env);
        if (request.method === 'POST') return await addWish(request, env);
        return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, POST, OPTIONS', ...CORS_HEADERS } });
      } catch (err) {
        console.error('wishes api failed', err && err.message);
        return json({ ok: false, error: 'تعذّر الوصول إلى تهاني الضيوف.' }, 503);
      }
    }

    return env.ASSETS.fetch(request);
  }
};
