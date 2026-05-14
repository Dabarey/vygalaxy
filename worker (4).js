// Galaxy Platform — Cloudflare Worker
// Bindings: DB (D1), MEDIA (R2), STRIPE_SK (Secret)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
function err(msg, status = 400) {
  return new Response(JSON.stringify({ error: msg }), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

async function stripeReq(env, path, method = 'GET', params = null) {
  const key = env.STRIPE_SK;
  if (!key) throw new Error('STRIPE_SK not set');
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params ? new URLSearchParams(params).toString() : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Stripe ${res.status}`);
  return data;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Serve index.html for root
    if (path === '/' || path === '/index.html') {
      const obj = await env.MEDIA.get('index.html');
      if (obj) {
        return new Response(obj.body, { headers: { 'Content-Type': 'text/html', ...CORS } });
      }
    }

    let body = {};
    if (method === 'POST' || method === 'PUT') {
      const ct = request.headers.get('Content-Type') || '';
      if (ct.includes('application/json')) {
        try { body = await request.json(); } catch {}
      }
    }

    try {

      // ── POSTS ──────────────────────────────────────────────
      if (path === '/api/posts' && method === 'GET') {
        const { results } = await env.DB.prepare(
          `SELECT p.*, u.name as creator_name, u.avatar as creator_avatar
           FROM posts p LEFT JOIN users u ON p.creator_id = u.id
           ORDER BY p.created_at DESC LIMIT 200`
        ).all();
        return json(results || []);
      }

      if (path === '/api/posts' && method === 'POST') {
        const { creator_id, title, content, tier, media_type, media_url } = body;
        if (!creator_id || !content) return err('Missing fields');
        const id = 'post_' + Date.now();
        await env.DB.prepare(
          `INSERT INTO posts (id, creator_id, title, content, tier, media_type, media_url, tips_count, comments_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, datetime('now'))`
        ).bind(id, creator_id, title || '', content, tier || 'free', media_type || '', media_url || '').run();
        return json({ id, success: true });
      }

      // ── MEDIA UPLOAD ───────────────────────────────────────
      if (path === '/api/upload' && method === 'POST') {
        const formData = await request.formData();
        const file = formData.get('file');
        if (!file) return err('No file provided');
        const ext = file.name?.split('.').pop() || 'bin';
        const key = `media/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
        await env.MEDIA.put(key, file.stream(), {
          httpMetadata: { contentType: file.type || 'application/octet-stream' }
        });
        const publicUrl = `https://pub-${env.R2_PUBLIC_ID || 'your-r2'}.r2.dev/${key}`;
        return json({ url: publicUrl, key });
      }

      // ── USERS ──────────────────────────────────────────────
      if (path === '/api/users/register' && method === 'POST') {
        const { email, password, name } = body;
        if (!email || !password || !name) return err('Missing fields');
        const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
        if (existing) return err('Email already registered', 409);
        const id = 'user_' + Date.now();
        const hash = await hashPassword(password);
        await env.DB.prepare(
          `INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, 'user', datetime('now'))`
        ).bind(id, email, hash, name).run();
        return json({ id, email, name, role: 'user' });
      }

      if (path === '/api/users/login' && method === 'POST') {
        const { email, password } = body;
        if (!email || !password) return err('Missing fields');
        const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
        if (!user) return err('Invalid email or password', 401);
        const valid = await verifyPassword(password, user.password_hash);
        if (!valid) return err('Invalid email or password', 401);
        const { password_hash, ...safe } = user;
        return json(safe);
      }

      if (path === '/api/users/profile' && method === 'PUT') {
        const { id, name, bio, avatar, category, price } = body;
        if (!id) return err('Missing id');
        await env.DB.prepare(
          `UPDATE users SET name=?, bio=?, avatar=?, category=?, price=? WHERE id=?`
        ).bind(name, bio, avatar, category, price, id).run();
        return json({ success: true });
      }

      if (path === '/api/users' && method === 'GET') {
        const id = url.searchParams.get('id');
        if (!id) return err('Missing id');
        const user = await env.DB.prepare('SELECT id,email,name,bio,avatar,category,price,role,created_at FROM users WHERE id=?').bind(id).first();
        if (!user) return err('User not found', 404);
        return json(user);
      }

      // ── PRODUCTS ───────────────────────────────────────────
      if (path === '/api/products' && method === 'GET') {
        const { results } = await env.DB.prepare(
          `SELECT p.*, u.name as creator_name, u.avatar as creator_avatar
           FROM products p LEFT JOIN users u ON p.creator_id = u.id
           ORDER BY p.created_at DESC`
        ).all();
        return json(results || []);
      }

      if (path === '/api/products' && method === 'POST') {
        const { creator_id, title, desc, type, price, emoji, deliverables } = body;
        if (!creator_id || !title || !price) return err('Missing fields');
        const id = 'prod_' + Date.now();
        await env.DB.prepare(
          `INSERT INTO products (id, creator_id, title, desc, type, price, emoji, deliverables, sales, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))`
        ).bind(id, creator_id, title, desc || '', type || 'digital', price, emoji || '📦', JSON.stringify(deliverables || {})).run();
        return json({ id, success: true });
      }

      // ── SUBSCRIPTIONS ──────────────────────────────────────
      if (path === '/api/subscriptions' && method === 'GET') {
        const userId = url.searchParams.get('user_id');
        if (!userId) return err('Missing user_id');
        const { results } = await env.DB.prepare(
          `SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active'`
        ).bind(userId).all();
        return json(results || []);
      }

      // ── PURCHASES ──────────────────────────────────────────
      if (path === '/api/purchases' && method === 'GET') {
        const userId = url.searchParams.get('user_id');
        if (!userId) return err('Missing user_id');
        const { results } = await env.DB.prepare(
          `SELECT pu.*, p.title as product_title, p.emoji, p.deliverables
           FROM purchases pu LEFT JOIN products p ON pu.product_id = p.id
           WHERE pu.user_id = ?`
        ).bind(userId).all();
        return json(results || []);
      }

      // ── PAYMENT ────────────────────────────────────────────
      if (path === '/api/pay' && method === 'POST') {
        const { payment_method_id, user_id, user_email, user_name,
                plan, price_usd, creator_id, creator_name,
                product_id, product_title, post_id } = body;

        if (!payment_method_id || !user_email || !price_usd) return err('Missing payment fields');

        const amountCents = Math.round(Number(price_usd) * 100);
        const creatorAmount = Math.round(Number(price_usd) * 0.71 * 100) / 100; // 71% to creator after 29% platform fee

        const existing = await stripeReq(env, `/customers?email=${encodeURIComponent(user_email)}&limit=1`, 'GET');
        let customerId;
        if (existing.data?.length > 0) {
          customerId = existing.data[0].id;
        } else {
          const c = await stripeReq(env, '/customers', 'POST', { email: user_email, name: user_name || user_email });
          customerId = c.id;
        }

        await stripeReq(env, `/payment_methods/${payment_method_id}/attach`, 'POST', { customer: customerId });
        await stripeReq(env, `/customers/${customerId}`, 'POST', { 'invoice_settings[default_payment_method]': payment_method_id });

        if (plan === 'tip' || plan === 'purchase') {
          const pi = await stripeReq(env, '/payment_intents', 'POST', {
            amount: String(amountCents),
            currency: 'usd',
            customer: customerId,
            payment_method: payment_method_id,
            confirm: 'true',
            'automatic_payment_methods[enabled]': 'true',
            'automatic_payment_methods[allow_redirects]': 'never',
            'metadata[type]': plan,
            'metadata[user_id]': user_id || '',
            'metadata[creator_id]': creator_id || '',
          });

          if (pi.status === 'requires_action') return json({ requires_action: true, client_secret: pi.client_secret });

          if (plan === 'tip' && post_id) {
            await env.DB.prepare(
              `INSERT INTO tips (id, post_id, creator_id, from_user_id, from_name, amount, created_at)
               VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
            ).bind('tip_' + Date.now(), post_id, creator_id, user_id || '', user_name || '', creatorAmount).run();
            await env.DB.prepare(`UPDATE posts SET tips_count = tips_count + 1 WHERE id = ?`).bind(post_id).run();
          }

          if (plan === 'purchase' && product_id) {
            await env.DB.prepare(
              `INSERT INTO purchases (id, user_id, product_id, price, stripe_pi_id, created_at)
               VALUES (?, ?, ?, ?, ?, datetime('now'))`
            ).bind('pur_' + Date.now(), user_id, product_id, creatorAmount, pi.id).run();
            await env.DB.prepare(`UPDATE products SET sales = sales + 1 WHERE id = ?`).bind(product_id).run();
          }

          return json({ success: true, payment_intent_id: pi.id });

        } else {
          const priceObj = await stripeReq(env, '/prices', 'POST', {
            unit_amount: String(amountCents),
            currency: 'usd',
            'recurring[interval]': 'month',
            'product_data[name]': `Galaxy - ${creator_name} (${plan})`,
          });

          const sub = await stripeReq(env, '/subscriptions', 'POST', {
            customer: customerId,
            'items[0][price]': priceObj.id,
            default_payment_method: payment_method_id,
            'metadata[creator_id]': creator_id || '',
            'metadata[user_id]': user_id || '',
            'expand[0]': 'latest_invoice.payment_intent',
          });

          const pi = sub.latest_invoice?.payment_intent;
          const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;

          await env.DB.prepare(
            `INSERT OR REPLACE INTO subscriptions (id, user_id, creator_id, creator_name, plan, price, status, stripe_sub_id, stripe_customer_id, period_end, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
          ).bind('sub_' + Date.now(), user_id, creator_id, creator_name, plan, creatorAmount, sub.status, sub.id, customerId, periodEnd).run();

          if (pi?.status === 'requires_action') return json({ requires_action: true, client_secret: pi.client_secret, subscription_id: sub.id });

          return json({ success: true, subscription_id: sub.id, period_end: periodEnd });
        }
      }

      return err('Not found', 404);

    } catch (e) {
      console.error(e);
      return err(e.message || 'Server error', 500);
    }
  }
};

async function hashPassword(password) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  const hashArr = Array.from(new Uint8Array(bits));
  const saltArr = Array.from(salt);
  return saltArr.map(b => b.toString(16).padStart(2, '0')).join('') + ':' + hashArr.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPassword(password, stored) {
  try {
    const [saltHex, hashHex] = stored.split(':');
    const salt = new Uint8Array(saltHex.match(/.{2}/g).map(b => parseInt(b, 16)));
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
    const hashArr = Array.from(new Uint8Array(bits));
    const computed = hashArr.map(b => b.toString(16).padStart(2, '0')).join('');
    return computed === hashHex;
  } catch { return false; }
}
