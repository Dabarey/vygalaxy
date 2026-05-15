// ═══════════════════════════════════════════════════════════════════════
// GALAXY PAYOUT SYSTEM — Add to your Cloudflare Worker
// Stripe secret key: env.STRIPE_SK
// D1 binding: env.DB (galaxy-db)
// Platform fee: 29% | Creator gets: 71%
// Min payout: $100 PayPal | $500 Bank (Stripe Connect)
// Payout date: 1st of every month (cron trigger)
// Currency: USD
// ═══════════════════════════════════════════════════════════════════════

// ── wrangler.toml additions ─────────────────────────────────────────────
/*
[vars]
PLATFORM_FEE = "0.29"
PAYOUT_MIN_PAYPAL = "100"
PAYOUT_MIN_BANK = "500"

[[d1_databases]]
binding = "DB"
database_name = "galaxy-db"
database_id = "YOUR_D1_ID"

[triggers]
crons = ["0 6 1 * *"]   # 6am UTC on the 1st of every month
*/

// ── D1 SQL — run these once in Cloudflare D1 console ───────────────────
/*
CREATE TABLE IF NOT EXISTS balances (
  creator_id    TEXT PRIMARY KEY,
  balance       REAL DEFAULT 0,
  lifetime      REAL DEFAULT 0,
  updated_at    TEXT
);

CREATE TABLE IF NOT EXISTS payouts (
  id            TEXT PRIMARY KEY,
  creator_id    TEXT NOT NULL,
  amount        REAL NOT NULL,
  fee           REAL NOT NULL,
  method        TEXT NOT NULL,  -- 'stripe' | 'paypal'
  status        TEXT DEFAULT 'pending',  -- pending | processing | paid | failed
  paypal_email  TEXT,
  stripe_account TEXT,
  reference     TEXT,           -- Stripe transfer ID or PayPal batch ID
  requested_at  TEXT NOT NULL,
  paid_at       TEXT,
  note          TEXT
);

CREATE TABLE IF NOT EXISTS payout_settings (
  creator_id    TEXT PRIMARY KEY,
  method        TEXT DEFAULT 'paypal',  -- 'stripe' | 'paypal'
  paypal_email  TEXT,
  stripe_account_id TEXT,
  stripe_onboarded  INTEGER DEFAULT 0,
  country       TEXT,
  updated_at    TEXT
);
*/

// ── Constants ───────────────────────────────────────────────────────────
const PLATFORM_FEE = 0.29;
const CREATOR_SHARE = 0.71;
const MIN_PAYPAL = 100;
const MIN_BANK = 500;

const STRIPE_CONNECT_COUNTRIES = [
  'US','GB','DE','FR','IT','ES','NL','BE','AT','PT','PL',
  'SE','DK','FI','NO','CH','IE','CZ','HU','SK','SI','BG',
  'HR','CY','EE','LV','LT','LU','MT','RO','CA','MX','BR',
  'AU','NZ','SG','HK','JP','MY','TH','PH','AE','ZA','IL'
];

function canUseStripe(country) {
  return STRIPE_CONNECT_COUNTRIES.includes((country||'').toUpperCase());
}

function cors(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

// ── Route handler — add inside your main fetch() ────────────────────────
export async function handlePayoutRoutes(request, env, url) {
  const path = url.pathname;
  if (request.method === 'OPTIONS') return cors({});

  // Credit balance when a payment succeeds
  if (path === '/api/webhooks/stripe' && request.method === 'POST') {
    return handleStripeWebhook(request, env);
  }

  // Creator: get their balance + payout history
  if (path === '/api/payout/balance' && request.method === 'GET') {
    return handleGetBalance(request, env, url);
  }

  // Creator: save payout settings (PayPal email / country)
  if (path === '/api/payout/settings' && request.method === 'POST') {
    return handleSaveSettings(request, env);
  }

  // Creator: get payout settings
  if (path === '/api/payout/settings' && request.method === 'GET') {
    return handleGetSettings(request, env, url);
  }

  // Creator: request withdrawal
  if (path === '/api/payout/request' && request.method === 'POST') {
    return handlePayoutRequest(request, env);
  }

  // Stripe Connect: start onboarding
  if (path === '/api/stripe/connect' && request.method === 'POST') {
    return handleStripeConnect(request, env);
  }

  // Stripe Connect: callback after onboarding
  if (path === '/api/stripe/connect/callback' && request.method === 'GET') {
    return handleStripeCallback(request, env, url);
  }

  // Admin: list pending payouts
  if (path === '/api/admin/payouts' && request.method === 'GET') {
    return handleAdminPayouts(request, env);
  }

  // Admin: mark payout as paid
  if (path === '/api/admin/payouts/mark-paid' && request.method === 'POST') {
    return handleMarkPaid(request, env);
  }

  return null; // not handled here
}

// ── Stripe webhook → credit creator balance ─────────────────────────────
async function handleStripeWebhook(request, env) {
  const payload = await request.text();
  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return cors({ error: 'Invalid JSON' }, 400);
  }

  // payment_intent.succeeded fires for subscriptions, tips, product purchases
  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const meta = pi.metadata || {};
    const creatorId = meta.creator_id;
    const grossUsd = pi.amount / 100; // Stripe amounts are in cents
    const creatorEarns = parseFloat((grossUsd * CREATOR_SHARE).toFixed(2));

    if (creatorId && creatorEarns > 0) {
      await env.DB.prepare(`
        INSERT INTO balances (creator_id, balance, lifetime, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(creator_id) DO UPDATE SET
          balance   = balance + excluded.balance,
          lifetime  = lifetime + excluded.lifetime,
          updated_at = excluded.updated_at
      `).bind(creatorId, creatorEarns, creatorEarns, new Date().toISOString()).run();
    }
  }

  return cors({ received: true });
}

// ── Get balance + history ───────────────────────────────────────────────
async function handleGetBalance(request, env, url) {
  const creatorId = url.searchParams.get('creator_id');
  if (!creatorId) return cors({ error: 'Missing creator_id' }, 400);

  const bal = await env.DB.prepare(
    'SELECT balance, lifetime FROM balances WHERE creator_id = ?'
  ).bind(creatorId).first();

  const history = await env.DB.prepare(
    'SELECT * FROM payouts WHERE creator_id = ? ORDER BY requested_at DESC LIMIT 20'
  ).bind(creatorId).all();

  return cors({
    balance: bal?.balance || 0,
    lifetime: bal?.lifetime || 0,
    history: history.results || [],
  });
}

// ── Save payout settings ────────────────────────────────────────────────
async function handleSaveSettings(request, env) {
  const { creator_id, method, paypal_email, country } = await request.json();
  if (!creator_id) return cors({ error: 'Missing creator_id' }, 400);

  await env.DB.prepare(`
    INSERT INTO payout_settings (creator_id, method, paypal_email, country, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(creator_id) DO UPDATE SET
      method       = excluded.method,
      paypal_email = excluded.paypal_email,
      country      = excluded.country,
      updated_at   = excluded.updated_at
  `).bind(creator_id, method || 'paypal', paypal_email || null, country || null, new Date().toISOString()).run();

  return cors({ ok: true });
}

// ── Get payout settings ─────────────────────────────────────────────────
async function handleGetSettings(request, env, url) {
  const creatorId = url.searchParams.get('creator_id');
  if (!creatorId) return cors({ error: 'Missing creator_id' }, 400);
  const row = await env.DB.prepare(
    'SELECT * FROM payout_settings WHERE creator_id = ?'
  ).bind(creatorId).first();
  return cors(row || {});
}

// ── Creator requests withdrawal ─────────────────────────────────────────
async function handlePayoutRequest(request, env) {
  const { creator_id, method } = await request.json();
  if (!creator_id) return cors({ error: 'Missing creator_id' }, 400);

  // Get balance
  const bal = await env.DB.prepare(
    'SELECT balance FROM balances WHERE creator_id = ?'
  ).bind(creator_id).first();
  const balance = bal?.balance || 0;

  // Get settings
  const settings = await env.DB.prepare(
    'SELECT * FROM payout_settings WHERE creator_id = ?'
  ).bind(creator_id).first();

  const payoutMethod = method || settings?.method || 'paypal';
  const min = payoutMethod === 'stripe' ? MIN_BANK : MIN_PAYPAL;

  if (balance < min) {
    return cors({ error: `Minimum balance for ${payoutMethod === 'stripe' ? 'bank transfer' : 'PayPal'} is $${min}. Your balance is $${balance.toFixed(2)}.` }, 400);
  }

  // Check no pending payout already exists
  const pending = await env.DB.prepare(
    "SELECT id FROM payouts WHERE creator_id = ? AND status = 'pending'"
  ).bind(creator_id).first();
  if (pending) {
    return cors({ error: 'You already have a pending payout request. It will be processed on the 1st of next month.' }, 400);
  }

  // Check not already requested this month
  const thisMonth = new Date().toISOString().slice(0, 7); // "2025-05"
  const thisMonthPayout = await env.DB.prepare(
    "SELECT id FROM payouts WHERE creator_id = ? AND requested_at LIKE ? AND status != 'failed'"
  ).bind(creator_id, `${thisMonth}%`).first();
  if (thisMonthPayout) {
    return cors({ error: 'You have already requested a payout this month.' }, 400);
  }

  const id = 'pay_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const fee = parseFloat((balance * PLATFORM_FEE).toFixed(2)); // already deducted at earn time, this is just for record
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO payouts (id, creator_id, amount, fee, method, status, paypal_email, stripe_account, requested_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `).bind(id, creator_id, balance, fee, payoutMethod, settings?.paypal_email || null, settings?.stripe_account_id || null, now).run();

  return cors({
    ok: true,
    message: `Payout of $${balance.toFixed(2)} via ${payoutMethod === 'stripe' ? 'bank transfer' : 'PayPal'} requested. Will be processed on the 1st of next month.`,
    payout_id: id,
    amount: balance,
    method: payoutMethod,
  });
}

// ── Stripe Connect — generate onboarding link ───────────────────────────
async function handleStripeConnect(request, env) {
  const { creator_id, email, country } = await request.json();
  if (!canUseStripe(country)) {
    return cors({ error: 'Bank transfer not available in your country. Please use PayPal.' }, 400);
  }

  const stripe = getStripe(env);

  // Create Express account
  const account = await stripe('/v1/accounts', 'POST', {
    type: 'express',
    country: country.toUpperCase(),
    email,
    capabilities: { transfers: { requested: 'true' } },
    metadata: { creator_id },
  });

  // Save account ID
  await env.DB.prepare(`
    INSERT INTO payout_settings (creator_id, stripe_account_id, country, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(creator_id) DO UPDATE SET
      stripe_account_id = excluded.stripe_account_id,
      country = excluded.country,
      updated_at = excluded.updated_at
  `).bind(creator_id, account.id, country, new Date().toISOString()).run();

  // Generate onboarding link
  const link = await stripe('/v1/account_links', 'POST', {
    account: account.id,
    refresh_url: 'https://vygalaxy.dabarey24.workers.dev/api/stripe/connect/callback?status=refresh&creator_id=' + creator_id,
    return_url: 'https://vygalaxy.dabarey24.workers.dev/api/stripe/connect/callback?status=complete&creator_id=' + creator_id,
    type: 'account_onboarding',
  });

  return cors({ url: link.url });
}

// ── Stripe Connect — callback ───────────────────────────────────────────
async function handleStripeCallback(request, env, url) {
  const status = url.searchParams.get('status');
  const creatorId = url.searchParams.get('creator_id');

  if (status === 'complete' && creatorId) {
    await env.DB.prepare(
      'UPDATE payout_settings SET stripe_onboarded = 1, method = ? WHERE creator_id = ?'
    ).bind('stripe', creatorId).run();
  }

  // Redirect back to the app
  return Response.redirect('https://vygalaxy.pages.dev/?stripe_connect=' + status, 302);
}

// ── Cron: process all pending payouts on the 1st ────────────────────────
// Add this to your Worker's scheduled() handler:
// export async function scheduled(event, env, ctx) {
//   if (event.cron === '0 6 1 * *') {
//     ctx.waitUntil(processMonthlyPayouts(env));
//   }
// }
export async function processMonthlyPayouts(env) {
  const stripe = getStripe(env);
  const pending = await env.DB.prepare(
    "SELECT p.*, ps.stripe_account_id, ps.paypal_email FROM payouts p LEFT JOIN payout_settings ps ON p.creator_id = ps.creator_id WHERE p.status = 'pending'"
  ).all();

  for (const payout of pending.results) {
    try {
      if (payout.method === 'stripe' && payout.stripe_account_id) {
        // Stripe Transfer
        const transfer = await stripe('/v1/transfers', 'POST', {
          amount: Math.round(payout.amount * 100), // cents
          currency: 'usd',
          destination: payout.stripe_account_id,
          metadata: { payout_id: payout.id, creator_id: payout.creator_id },
        });

        await env.DB.prepare(
          "UPDATE payouts SET status = 'paid', reference = ?, paid_at = ? WHERE id = ?"
        ).bind(transfer.id, new Date().toISOString(), payout.id).run();

        // Zero out balance
        await env.DB.prepare(
          'UPDATE balances SET balance = 0, updated_at = ? WHERE creator_id = ?'
        ).bind(new Date().toISOString(), payout.creator_id).run();

      } else if (payout.method === 'paypal' && payout.paypal_email) {
        // PayPal — mark as processing, you send manually or via PayPal Payouts API
        // To automate: integrate PayPal Payouts API here
        await env.DB.prepare(
          "UPDATE payouts SET status = 'processing', note = 'Send via PayPal to: ' || paypal_email WHERE id = ?"
        ).bind(payout.id).run();

      } else {
        await env.DB.prepare(
          "UPDATE payouts SET status = 'failed', note = 'Missing payout destination' WHERE id = ?"
        ).bind(payout.id).run();
      }
    } catch (err) {
      await env.DB.prepare(
        "UPDATE payouts SET status = 'failed', note = ? WHERE id = ?"
      ).bind(err.message || 'Unknown error', payout.id).run();
    }
  }
}

// ── Admin: list pending payouts ─────────────────────────────────────────
async function handleAdminPayouts(request, env) {
  const rows = await env.DB.prepare(
    "SELECT p.*, u.name as creator_name, u.email as creator_email FROM payouts p LEFT JOIN profiles u ON p.creator_id = u.id ORDER BY p.requested_at DESC LIMIT 100"
  ).all();
  return cors({ payouts: rows.results || [] });
}

// ── Admin: mark payout as paid manually ────────────────────────────────
async function handleMarkPaid(request, env) {
  const { payout_id, reference } = await request.json();
  if (!payout_id) return cors({ error: 'Missing payout_id' }, 400);

  const payout = await env.DB.prepare('SELECT * FROM payouts WHERE id = ?').bind(payout_id).first();
  if (!payout) return cors({ error: 'Payout not found' }, 404);

  await env.DB.prepare(
    "UPDATE payouts SET status = 'paid', reference = ?, paid_at = ? WHERE id = ?"
  ).bind(reference || 'manual', new Date().toISOString(), payout_id).run();

  // Zero out creator balance
  await env.DB.prepare(
    'UPDATE balances SET balance = 0, updated_at = ? WHERE creator_id = ?'
  ).bind(new Date().toISOString(), payout.creator_id).run();

  return cors({ ok: true });
}

// ── Stripe API helper ───────────────────────────────────────────────────
function getStripe(env) {
  return async function stripe(path, method = 'GET', body = null) {
    const opts = {
      method,
      headers: {
        'Authorization': 'Bearer ' + env.STRIPE_SK,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': '2023-10-16',
      },
    };
    if (body) {
      opts.body = Object.entries(flattenStripe(body))
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
    }
    const res = await fetch('https://api.stripe.com' + path, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Stripe error');
    return data;
  };
}

// Stripe needs nested objects flattened: { metadata: { a: 1 } } → { 'metadata[a]': 1 }
function flattenStripe(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flattenStripe(v, key));
    } else {
      out[key] = v;
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// HOW TO WIRE INTO YOUR MAIN WORKER fetch() HANDLER
// ═══════════════════════════════════════════════════════════════════════
/*
import { handlePayoutRoutes, processMonthlyPayouts } from './worker-payouts.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle payout routes first
    const payoutResponse = await handlePayoutRoutes(request, env, url);
    if (payoutResponse) return payoutResponse;

    // ... rest of your existing routes
  },

  async scheduled(event, env, ctx) {
    if (event.cron === '0 6 1 * *') {
      ctx.waitUntil(processMonthlyPayouts(env));
    }
  }
};
*/

// ═══════════════════════════════════════════════════════════════════════
// IMPORTANT: Add creator_id to Stripe PaymentIntent metadata
// when creating charges so the webhook can credit the right creator.
//
// In your existing charge code add:
// metadata: { creator_id: 'the-creator-uuid', plan: 'subscription' }
// ═══════════════════════════════════════════════════════════════════════
