// Galaxy Platform — Cloudflare Worker
// Bindings: DB (D1), MEDIA (R2), STRIPE_SK, PAYPAL_CLIENT_ID, PAYPAL_SK

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

// ── STRIPE ─────────────────────────────────────────────────────
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

// ── PAYPAL ─────────────────────────────────────────────────────
async function getPayPalToken(env) {
  const clientId = env.PAYPAL_CLIENT_ID || 'AbjOkZiNZd83Or_YmzrSZ3QR6e5rdPFjtCPr_DdUCvlu5C9YjOe4EHOfVSuBcsrArWqauV2bBNdKNFvO';
  const secret = env.PAYPAL_SK || 'EJxNRKqalrsv38yCM6QiWq2KcLGun4tjxh6EpG37dvRpHXgqt06FrH55RkW0n4pGAP8Fb5UM-q4vrECa';
  if (!clientId || !secret) throw new Error('PayPal credentials not set');
  const creds = btoa(clientId + ':' + secret);
  const res = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + creds,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('PayPal auth failed: ' + JSON.stringify(data));
  return data.access_token;
}

async function paypalReq(env, path, method = 'GET', body = null) {
  const token = await getPayPalToken(env);
  const res = await fetch('https://api-m.paypal.com' + path, {
    method,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || JSON.stringify(data));
  return data;
}

// ── PASSWORD ───────────────────────────────────────────────────
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
        return new Response(obj.body, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache', ...CORS } });
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

      // ── PAYPAL TEST ────────────────────────────────────────
      if (path === '/api/paypal/test') {
        try {
          const token = await getPayPalToken(env);
          return json({ success: true, preview: token.substring(0, 20) + '...' });
        } catch(e) {
          return json({ success: false, error: e.message });
        }
      }

      // ── PAYPAL CREATE ORDER ────────────────────────────────
      if (path === '/api/paypal/order' && method === 'POST') {
        const { amount, description, user_id, creator_id, post_id, product_id, plan, user_name } = body;
        if (!amount) return err('Missing amount');
        const order = await paypalReq(env, '/v2/checkout/orders', 'POST', {
          intent: 'CAPTURE',
          purchase_units: [{
            amount: { currency_code: 'USD', value: Number(amount).toFixed(2) },
            description: description || 'Galaxy Payment',
          }],
          application_context: {
            return_url: 'https://vygalaxy.dabarey24.workers.dev/?pp=success',
            cancel_url: 'https://vygalaxy.dabarey24.workers.dev/?pp=cancel',
            brand_name: 'Galaxy',
            user_action: 'PAY_NOW',
            landing_page: 'BILLING',
          },
        });
        return json({ id: order.id, status: order.status });
      }

      // ── PAYPAL CAPTURE ─────────────────────────────────────
      if (path === '/api/paypal/capture' && method === 'POST') {
        const { order_id, user_id, creator_id, post_id, product_id, plan, amount, user_name } = body;
        if (!order_id) return err('Missing order_id');
        const capture = await paypalReq(env, '/v2/checkout/orders/' + order_id + '/capture', 'POST', {});
        if (capture.status !== 'COMPLETED') return err('Payment not completed: ' + capture.status);
        const creatorAmount = Math.round(Number(amount) * 0.71 * 100) / 100;
        if (plan === 'tip' && post_id) {
          await env.DB.prepare(
            `INSERT INTO tips (id, post_id, creator_id, from_user_id, from_name, amount, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
          ).bind('tip_' + Date.now(), post_id, creator_id, user_id || '', user_name || '', creatorAmount).run();
          await env.DB.prepare(`UPDATE posts SET tips_count = tips_count + 1 WHERE id = ?`).bind(post_id).run();
        }
        if (plan === 'purchase' && product_id) {
          await env.DB.prepare(
            `INSERT INTO purchases (id, user_id, product_id, price, stripe_pi_id, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`
          ).bind('pur_' + Date.now(), user_id, product_id, creatorAmount, 'paypal_' + order_id).run();
          await env.DB.prepare(`UPDATE products SET sales = sales + 1 WHERE id = ?`).bind(product_id).run();
        }
        return json({ success: true, capture_id: order_id });
      }

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
        const { email, password, name, category } = body;
        if (!email || !password || !name) return err('Missing fields');
        const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
        if (existing) return err('Email already registered', 409);
        const id = 'user_' + Date.now();
        const hash = await hashPassword(password);
        const role = email === 'dabarey24@gmail.com' ? 'admin' : 'user';
        await env.DB.prepare(
          `INSERT INTO users (id, email, password_hash, name, role, category, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
        ).bind(id, email, hash, name, role, category || 'Other').run();
        return json({ id, email, name, role, category: category || 'Other' });
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

      // ── STRIPE PAYMENT ─────────────────────────────────────
      if (path === '/api/pay' && method === 'POST') {
        const { payment_method_id, user_id, user_email, user_name,
                plan, price_usd, creator_id, creator_name,
                product_id, product_title, post_id } = body;

        if (!payment_method_id || !user_email || !price_usd) return err('Missing payment fields');

        const amountCents = Math.round(Number(price_usd) * 100);
        const creatorAmount = Math.round(Number(price_usd) * 0.71 * 100) / 100;

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
              `INSERT INTO tips (id, post_id, creator_id, from_user_id, from_name, amount, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
            ).bind('tip_' + Date.now(), post_id, creator_id, user_id || '', user_name || '', creatorAmount).run();
            await env.DB.prepare(`UPDATE posts SET tips_count = tips_count + 1 WHERE id = ?`).bind(post_id).run();
          }

          if (plan === 'purchase' && product_id) {
            await env.DB.prepare(
              `INSERT INTO purchases (id, user_id, product_id, price, stripe_pi_id, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`
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
          ).bind('sub_' + Date.now(), user_id, creator_id, creator_name, plan, price_usd, sub.status, sub.id, customerId, periodEnd).run();

          if (pi?.status === 'requires_action') return json({ requires_action: true, client_secret: pi.client_secret, subscription_id: sub.id });

          return json({ success: true, subscription_id: sub.id, period_end: periodEnd });
        }
      }


      // ── STRIPE WEBHOOK ─────────────────────────────────────
      if (path === '/api/webhook/stripe' && method === 'POST') {
        const sig = request.headers.get('stripe-signature');
        const rawBody = await request.text();
        
        // Verify webhook signature
        const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
        if (webhookSecret) {
          try {
            // Simple timestamp + signature verification
            const parts = sig.split(',');
            const timestamp = parts.find(p => p.startsWith('t=')).split('=')[1];
            const signatures = parts.filter(p => p.startsWith('v1=')).map(p => p.split('=')[1]);
            const signedPayload = timestamp + '.' + rawBody;
            const enc = new TextEncoder();
            const key = await crypto.subtle.importKey('raw', enc.encode(webhookSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
            const sig_bytes = await crypto.subtle.sign('HMAC', key, enc.encode(signedPayload));
            const computed = Array.from(new Uint8Array(sig_bytes)).map(b => b.toString(16).padStart(2, '0')).join('');
            if (!signatures.includes(computed)) return err('Invalid signature', 400);
          } catch(e) {
            return err('Webhook verification failed', 400);
          }
        }

        const event = JSON.parse(rawBody);
        const data = event.data?.object;

        // Handle subscription events
        if (event.type === 'invoice.payment_succeeded') {
          const subId = data.subscription;
          const customerId = data.customer;
          if (subId) {
            await env.DB.prepare(
              `UPDATE subscriptions SET status='active', period_end=datetime('now', '+1 month') WHERE stripe_sub_id=?`
            ).bind(subId).run();
          }
        }

        if (event.type === 'invoice.payment_failed') {
          const subId = data.subscription;
          if (subId) {
            await env.DB.prepare(
              `UPDATE subscriptions SET status='past_due' WHERE stripe_sub_id=?`
            ).bind(subId).run();
          }
        }

        if (event.type === 'customer.subscription.deleted') {
          const subId = data.id;
          await env.DB.prepare(
            `UPDATE subscriptions SET status='cancelled' WHERE stripe_sub_id=?`
          ).bind(subId).run();
        }

        if (event.type === 'customer.subscription.updated') {
          const subId = data.id;
          const status = data.status;
          const periodEnd = data.current_period_end ? new Date(data.current_period_end * 1000).toISOString() : null;
          await env.DB.prepare(
            `UPDATE subscriptions SET status=?, period_end=? WHERE stripe_sub_id=?`
          ).bind(status, periodEnd, subId).run();
        }

        return json({ received: true });
      }


      // ── BALANCE ────────────────────────────────────────────
      if (path === '/api/balance' && method === 'GET') {
        const userId = url.searchParams.get('user_id');
        if (!userId) return err('Missing user_id');

        // Tips received
        const tips = await env.DB.prepare(
          `SELECT COALESCE(SUM(amount),0) as total FROM tips WHERE creator_id=?`
        ).bind(userId).first();

        // Subscriptions received (active)
        const subs = await env.DB.prepare(
          `SELECT COALESCE(SUM(price),0) as total, COUNT(*) as count FROM subscriptions WHERE creator_id=? AND status='active'`
        ).bind(userId).first();

        // Product sales received
        const sales = await env.DB.prepare(
          `SELECT COALESCE(SUM(pu.price),0) as total FROM purchases pu
           LEFT JOIN products p ON pu.product_id = p.id
           WHERE p.creator_id=?`
        ).bind(userId).first();

        const totalEarned = Number(tips.total||0) + Number(subs.total||0) + Number(sales.total||0);
        const balance = totalEarned; // In real app, subtract payouts already made

        return json({
          balance: Math.round(balance * 100) / 100,
          total_earned: Math.round(totalEarned * 100) / 100,
          subscriber_count: Number(subs.count||0),
          tips_total: Math.round(Number(tips.total||0) * 100) / 100,
          sales_total: Math.round(Number(sales.total||0) * 100) / 100,
        });
      }


      // ── NOTIFICATIONS ──────────────────────────────────────
      if (path === '/api/notifications' && method === 'GET') {
        const userId = url.searchParams.get('user_id');
        if (!userId) return err('Missing user_id');
        const { results } = await env.DB.prepare(
          `SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50`
        ).bind(userId).all();
        return json(results || []);
      }

      if (path === '/api/notifications' && method === 'POST') {
        const { user_id, icon, text, time } = body;
        if (!user_id || !text) return err('Missing fields');
        const id = 'notif_' + Date.now();
        await env.DB.prepare(
          `INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?, ?, ?, ?, ?)`
        ).bind(id, user_id, icon || '🔔', text, time || 'just now').run();
        return json({ id, success: true });
      }

      if (path === '/api/notifications/read' && method === 'POST') {
        const { user_id } = body;
        if (!user_id) return err('Missing user_id');
        await env.DB.prepare(`UPDATE notifications SET read=1 WHERE user_id=?`).bind(user_id).run();
        return json({ success: true });
      }

      // ── MESSAGES ───────────────────────────────────────────
      if (path === '/api/messages' && method === 'GET') {
        const userId = url.searchParams.get('user_id');
        if (!userId) return err('Missing user_id');
        const { results } = await env.DB.prepare(
          `SELECT m.*, 
            u1.name as from_name, u1.avatar as from_avatar,
            u2.name as to_name, u2.avatar as to_avatar
           FROM messages m
           LEFT JOIN users u1 ON m.from_id = u1.id
           LEFT JOIN users u2 ON m.to_id = u2.id
           WHERE m.from_id=? OR m.to_id=?
           ORDER BY m.created_at DESC LIMIT 100`
        ).bind(userId, userId).all();
        return json(results || []);
      }

      if (path === '/api/messages' && method === 'POST') {
        const { from_id, to_id, text } = body;
        if (!from_id || !to_id || !text) return err('Missing fields');
        const id = 'msg_' + Date.now();
        await env.DB.prepare(
          `INSERT INTO messages (id, from_id, to_id, text) VALUES (?, ?, ?, ?)`
        ).bind(id, from_id, to_id, text).run();
        // Push notification to recipient
        const sender = await env.DB.prepare('SELECT name FROM users WHERE id=?').bind(from_id).first();
        const notifId = 'notif_' + Date.now();
        await env.DB.prepare(
          `INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?, ?, ?, ?, ?)`
        ).bind(notifId, to_id, '💬', (sender?.name || 'Someone') + ': ' + text.slice(0, 50), 'just now').run();
        return json({ id, success: true });
      }

      // ── KYC ────────────────────────────────────────────────
      if (path === '/api/kyc' && method === 'POST') {
        const { user_id, user_name, user_email, legal_name, dob, country, payout_method, payout_details } = body;
        if (!user_id) return err('Missing user_id');
        const id = 'kyc_' + Date.now();
        await env.DB.prepare(
          `INSERT OR REPLACE INTO kyc_requests (id, user_id, user_name, user_email, legal_name, dob, country, payout_method, payout_details, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
        ).bind(id, user_id, user_name, user_email, legal_name, dob, country, payout_method, payout_details).run();
        await env.DB.prepare(`UPDATE users SET kyc_status='pending' WHERE id=?`).bind(user_id).run();
        return json({ id, success: true });
      }

      if (path === '/api/kyc' && method === 'GET') {
        const { results } = await env.DB.prepare(
          `SELECT * FROM kyc_requests ORDER BY submitted_at DESC`
        ).all();
        return json(results || []);
      }

      if (path === '/api/kyc/review' && method === 'POST') {
        const { kyc_id, user_id, action } = body;
        if (!kyc_id || !action) return err('Missing fields');
        await env.DB.prepare(`UPDATE kyc_requests SET status=? WHERE id=?`).bind(action, kyc_id).run();
        if (user_id) {
          const verified = action === 'approved' ? 1 : 0;
          await env.DB.prepare(`UPDATE users SET kyc_status=?, verified=? WHERE id=?`).bind(action, verified, user_id).run();
          const notifId = 'notif_' + Date.now();
          const msg = action === 'approved' ? 'Your KYC is approved! You are now verified ✅' : 'Your KYC was rejected. Please resubmit with clearer documents.';
          await env.DB.prepare(
            `INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?, ?, ?, ?, ?)`
          ).bind(notifId, user_id, action === 'approved' ? '✅' : '❌', msg, 'just now').run();
        }
        return json({ success: true });
      }

      // ── PAYOUT REQUESTS ────────────────────────────────────
      if (path === '/api/payouts' && method === 'POST') {
        const { user_id, user_name, user_email, amount, method: payMethod, details } = body;
        if (!user_id || !amount) return err('Missing fields');
        const id = 'payout_' + Date.now();
        await env.DB.prepare(
          `INSERT INTO payout_requests (id, user_id, user_name, user_email, amount, method, details, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
        ).bind(id, user_id, user_name, user_email, amount, payMethod, details).run();
        return json({ id, success: true });
      }

      if (path === '/api/payouts' && method === 'GET') {
        const { results } = await env.DB.prepare(
          `SELECT * FROM payout_requests ORDER BY created_at DESC`
        ).all();
        return json(results || []);
      }

      if (path === '/api/payouts/review' && method === 'POST') {
        const { payout_id, user_id, action, amount } = body;
        if (!payout_id || !action) return err('Missing fields');
        await env.DB.prepare(`UPDATE payout_requests SET status=? WHERE id=?`).bind(action, payout_id).run();
        if (user_id && action === 'paid') {
          await env.DB.prepare(`UPDATE users SET balance=MAX(0,balance-?) WHERE id=?`).bind(amount, user_id).run();
          const notifId = 'notif_' + Date.now();
          await env.DB.prepare(
            `INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?, ?, ?, ?, ?)`
          ).bind(notifId, user_id, '💸', 'Your payout of $' + amount + ' has been sent!', 'just now').run();
        }
        return json({ success: true });
      }

      // ── REVIEWS ────────────────────────────────────────────
      if (path === '/api/reviews' && method === 'GET') {
        const productId = url.searchParams.get('product_id');
        if (!productId) return err('Missing product_id');
        const { results } = await env.DB.prepare(
          `SELECT r.*, u.name as user_name, u.avatar as user_avatar
           FROM reviews r LEFT JOIN users u ON r.user_id = u.id
           WHERE r.product_id=? ORDER BY r.created_at DESC`
        ).bind(productId).all();
        return json(results || []);
      }

      if (path === '/api/reviews' && method === 'POST') {
        const { user_id, product_id, rating, text } = body;
        if (!user_id || !product_id || !rating) return err('Missing fields');
        const id = 'rev_' + Date.now();
        await env.DB.prepare(
          `INSERT INTO reviews (id, user_id, product_id, rating, text) VALUES (?, ?, ?, ?, ?)`
        ).bind(id, user_id, product_id, rating, text || '').run();
        return json({ id, success: true });
      }

      // ── ALL USERS (admin) ──────────────────────────────────
      if (path === '/api/admin/users' && method === 'GET') {
        const { results } = await env.DB.prepare(
          `SELECT id, email, name, bio, avatar, category, price, role, kyc_status, verified, balance, earned, created_at FROM users ORDER BY created_at DESC`
        ).all();
        return json(results || []);
      }

      // ── UPDATE USER PROFILE ────────────────────────────────
      if (path === '/api/users/profile' && method === 'PUT') {
        const { id, name, bio, avatar, cover, category, price, payout_method, payout_details } = body;
        if (!id) return err('Missing id');
        await env.DB.prepare(
          `UPDATE users SET name=?, bio=?, avatar=?, cover=?, category=?, price=?, payout_method=?, payout_details=? WHERE id=?`
        ).bind(name, bio, avatar, cover, category, price, payout_method, payout_details, id).run();
        return json({ success: true });
      }

      return err('Not found', 404);

    } catch (e) {
      console.error(e);
      return err(e.message || 'Server error', 500);
    }
  }
};
