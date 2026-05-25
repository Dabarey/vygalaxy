var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization"
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
__name(json, "json");
function err(msg, status = 400) {
  return new Response(JSON.stringify({ error: msg }), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
__name(err, "err");
async function stripeReq(env, path, method = "GET", params = null) {
  const key = env.STRIPE_SK;
  if (!key) throw new Error("STRIPE_SK not set");
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params ? new URLSearchParams(params).toString() : void 0
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Stripe ${res.status}`);
  return data;
}
__name(stripeReq, "stripeReq");
async function getPayPalToken(env) {
  const clientId = env.PAYPAL_CLIENT_ID || "AbjOkZiNZd83Or_YmzrSZ3QR6e5rdPFjtCPr_DdUCvlu5C9YjOe4EHOfVSuBcsrArWqauV2bBNdKNFvO";
  const secret = env.PAYPAL_SK || "EJxNRKqalrsv38yCM6QiWq2KcLGun4tjxh6EpG37dvRpHXgqt06FrH55RkW0n4pGAP8Fb5UM-q4vrECa";
  if (!clientId || !secret) throw new Error("PayPal credentials not set");
  const creds = btoa(clientId + ":" + secret);
  const res = await fetch("https://api-m.paypal.com/v1/oauth2/token", {
    method: "POST",
    headers: { "Authorization": "Basic " + creds, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials"
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("PayPal auth failed: " + JSON.stringify(data));
  return data.access_token;
}
__name(getPayPalToken, "getPayPalToken");
async function paypalReq(env, path, method = "GET", body = null) {
  const token = await getPayPalToken(env);
  const res = await fetch("https://api-m.paypal.com" + path, {
    method,
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : void 0
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || JSON.stringify(data));
  return data;
}
__name(paypalReq, "paypalReq");
async function hashPassword(password) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 1e5, hash: "SHA-256" }, key, 256);
  const hashArr = Array.from(new Uint8Array(bits));
  const saltArr = Array.from(salt);
  return saltArr.map((b) => b.toString(16).padStart(2, "0")).join("") + ":" + hashArr.map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(hashPassword, "hashPassword");
async function verifyPassword(password, stored) {
  try {
    const [saltHex, hashHex] = stored.split(":");
    const salt = new Uint8Array(saltHex.match(/.{2}/g).map((b) => parseInt(b, 16)));
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 1e5, hash: "SHA-256" }, key, 256);
    const hashArr = Array.from(new Uint8Array(bits));
    const computed = hashArr.map((b) => b.toString(16).padStart(2, "0")).join("");
    return computed === hashHex;
  } catch {
    return false;
  }
}
__name(verifyPassword, "verifyPassword");

// ── Balance helper ───────────────────────────────────────────────────────
// Credit referrer: 1% on subs, 2% on video tips — for 12 months from signup
async function creditReferrer(env, referredUserId, amount, type) {
  try {
    const referredUser = await env.DB.prepare("SELECT ref_code, created_at FROM users WHERE id=?").bind(referredUserId).first();
    if (!referredUser?.ref_code) return;
    const monthsOld = (Date.now() - new Date(referredUser.created_at).getTime()) / (1000*60*60*24*30);
    if (monthsOld > 24) return;
    // ref_code is now user ID — simple lookup
    const referrer = await env.DB.prepare(
      "SELECT id FROM users WHERE id=?"
    ).bind(referredUser.ref_code).first();
    if (!referrer) return;
    // Check if referrer has verified video (2% rate) or default 1%
    const referrerUser = await env.DB.prepare("SELECT ref_rate FROM users WHERE id=?").bind(referrer.id).first();
    const pct = (referrerUser?.ref_rate === 2) ? 0.02 : 0.01;
    const bonus = Math.round(amount * pct * 100) / 100;
    if (bonus < 0.01) return;
    await env.DB.prepare(
      "INSERT INTO balances (creator_id,balance,lifetime) VALUES (?,?,?) ON CONFLICT(creator_id) DO UPDATE SET balance=balance+?,lifetime=lifetime+?"
    ).bind(referrer.id, bonus, bonus, bonus, bonus).run();
    await env.DB.prepare("INSERT INTO notifications (id,user_id,icon,text,time) VALUES (?,?,?,?,?)")
      .bind("notif_ref_"+Date.now(), referrer.id, "🎉",
        "Referral bonus: $"+bonus.toFixed(2)+" ("+(pct*100)+"% "+(type==='video'?'video tip':'subscription')+")", "just now").run();
  } catch(e) { console.warn("creditReferrer failed:", e.message); }
}

async function creditBalance(env, creatorId, amountUsd) {
  const creatorEarns = Math.round(amountUsd * 0.71 * 100) / 100;
  if (!creatorId || creatorEarns <= 0) return;
  await env.DB.prepare(`
    INSERT INTO balances (creator_id, balance, lifetime, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(creator_id) DO UPDATE SET
      balance  = balance + excluded.balance,
      lifetime = lifetime + excluded.lifetime,
      updated_at = excluded.updated_at
  `).bind(creatorId, creatorEarns, creatorEarns).run();
}
__name(creditBalance, "creditBalance");

var worker_default = {
  async scheduled(event, env, ctx) {
    if (event.cron === '0 6 1 * *') {
      ctx.waitUntil(processMonthlyPayouts(env));
    }
    // Daily: clean up expired stories from R2
    if (event.cron === '0 3 * * *') {
      ctx.waitUntil((async () => {
        const { results: expired } = await env.DB.prepare(
          "SELECT media_url FROM stories WHERE expires_at < datetime('now')"
        ).all().catch(()=>({results:[]}));
        for (const s of (expired||[])) {
          if (!s.media_url) continue;
          try {
            const key = s.media_url.replace(/^https?:\/\/[^/]+\//, '');
            if (key) await env.MEDIA.delete(key);
          } catch(e) {}
        }
        await env.DB.prepare("DELETE FROM stories WHERE expires_at < datetime('now')").run().catch(()=>{});
      })());
    }
  },
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response("ok", { headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // ── PAYOUT ROUTES ────────────────────────────────────────────────────
    if (path === "/api/payout/balance" && method === "GET") {
      const creatorId = url.searchParams.get("creator_id");
      if (!creatorId) return err("Missing creator_id");
      const bal = await env.DB.prepare("SELECT balance, lifetime FROM balances WHERE creator_id=?").bind(creatorId).first();
      const history = await env.DB.prepare("SELECT * FROM payouts WHERE creator_id=? ORDER BY requested_at DESC LIMIT 20").bind(creatorId).all();
      return json({ balance: bal?.balance||0, lifetime: bal?.lifetime||0, history: history.results||[] });
    }
    if (path === "/api/payout/settings" && method === "GET") {
      const creatorId = url.searchParams.get("creator_id");
      if (!creatorId) return err("Missing creator_id");
      const row = await env.DB.prepare("SELECT * FROM payout_settings WHERE creator_id=?").bind(creatorId).first();
      return json(row || {});
    }
    if (path === "/api/payout/settings" && method === "POST") {
      let body2 = {};
      try { body2 = await request.json(); } catch {}
      const { creator_id, method: m, paypal_email, country,
        bank_name, bank_iban, bank_swift, bank_account, bank_routing,
        bank_sortcode, bank_bsb, bank_transit, bank_institution,
        bank_bankname, bank_country } = body2;
      if (!creator_id) return err("Missing creator_id");
      await env.DB.prepare(`
        INSERT INTO payout_settings (creator_id, method, paypal_email, country,
          bank_name, bank_iban, bank_swift, bank_account, bank_routing,
          bank_sortcode, bank_bsb, bank_transit, bank_institution,
          bank_bankname, bank_country, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(creator_id) DO UPDATE SET
          method=excluded.method, paypal_email=excluded.paypal_email,
          country=excluded.country, bank_name=excluded.bank_name,
          bank_iban=excluded.bank_iban, bank_swift=excluded.bank_swift,
          bank_account=excluded.bank_account, bank_routing=excluded.bank_routing,
          bank_sortcode=excluded.bank_sortcode, bank_bsb=excluded.bank_bsb,
          bank_transit=excluded.bank_transit, bank_institution=excluded.bank_institution,
          bank_bankname=excluded.bank_bankname, bank_country=excluded.bank_country,
          updated_at=excluded.updated_at
      `).bind(
        creator_id, m||"paypal", paypal_email||null, country||null,
        bank_name||null, bank_iban||null, bank_swift||null, bank_account||null,
        bank_routing||null, bank_sortcode||null, bank_bsb||null, bank_transit||null,
        bank_institution||null, bank_bankname||null, bank_country||null
      ).run();
      return json({ ok: true });
    }
    if (path === "/api/payout/request" && method === "POST") {
      let body2 = {};
      try { body2 = await request.json(); } catch {}
      const { creator_id, method: m } = body2;
      if (!creator_id) return err("Missing creator_id");
      const bal = await env.DB.prepare("SELECT balance FROM balances WHERE creator_id=?").bind(creator_id).first();
      const balance = bal?.balance || 0;
      const payoutMethod = m || "paypal";
      const min = payoutMethod === "stripe" ? 500 : 100;
      if (balance < min) return err(`Minimum for ${payoutMethod==="stripe"?"bank transfer":"PayPal"} is $${min}. Your balance is $${balance.toFixed(2)}.`);
      const pending = await env.DB.prepare("SELECT id FROM payouts WHERE creator_id=? AND status IN ('pending','processing')").bind(creator_id).first();
      if (pending) return err("You already have a payout in progress.");
      const settings = await env.DB.prepare("SELECT * FROM payout_settings WHERE creator_id=?").bind(creator_id).first();
      const id = "pay_" + Date.now();
      const now = new Date().toISOString();

      // ── PayPal: fire immediately with email verification ────────────
      if (payoutMethod === "paypal") {
        if (!settings?.paypal_email) return err("No PayPal email saved. Please add it first.");
        try {
          const token = await getPayPalToken(env);
          const batchId = "GALAXY_" + id;

          // Send payout
          const res = await fetch("https://api-m.paypal.com/v1/payments/payouts", {
            method: "POST",
            headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
            body: JSON.stringify({
              sender_batch_header: {
                sender_batch_id: batchId,
                email_subject: "Your GALAXY payout is here!",
                email_message: `You have received a payout of $${balance.toFixed(2)} from GALAXY.`
              },
              items: [{
                recipient_type: "EMAIL",
                amount: { value: balance.toFixed(2), currency: "USD" },
                receiver: settings.paypal_email,
                note: "GALAXY creator payout",
                sender_item_id: id
              }]
            })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.message || JSON.stringify(data));

          const batchId2 = data.batch_header?.payout_batch_id || batchId;

          // Wait 3 seconds then check item status to catch invalid emails
          await new Promise(r => setTimeout(r, 3000));
          const checkRes = await fetch(`https://api-m.paypal.com/v1/payments/payouts/${batchId2}`, {
            headers: { "Authorization": "Bearer " + token }
          });
          const checkData = await checkRes.json();
          const item = checkData.items?.[0];
          const itemStatus = item?.transaction_status || item?.errors?.[0]?.name || "PENDING";

          // These statuses mean the email is invalid / not a PayPal account
          const invalidStatuses = ["RECEIVER_UNREGISTERED", "RECEIVER_UNVERIFIED", "INVALID_EMAIL", "FAILED"];
          if (invalidStatuses.includes(itemStatus)) {
            // Record as failed — balance NOT deducted
            await env.DB.prepare(`
              INSERT INTO payouts (id, creator_id, amount, fee, method, status, paypal_email, reference, requested_at, note)
              VALUES (?, ?, ?, 0, 'paypal', 'failed', ?, ?, datetime('now'), ?)
            `).bind(id, creator_id, balance, settings.paypal_email, batchId2,
              `PayPal rejected: ${itemStatus} — email not registered with PayPal`).run();

            // Notify creator — balance NOT touched
            await env.DB.prepare(`INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?,?,?,?,?)`)
              .bind("notif_"+Date.now(), creator_id, "❌",
                `Payout failed — "${settings.paypal_email}" is not registered with PayPal. Please update your PayPal email and try again.`, "just now").run();

            return err(`Payout failed: "${settings.paypal_email}" is not a registered PayPal account. Your balance has NOT been deducted. Please update your PayPal email.`);
          }

          // Success — record and zero balance
          await env.DB.prepare(`
            INSERT INTO payouts (id, creator_id, amount, fee, method, status, paypal_email, reference, requested_at, paid_at)
            VALUES (?, ?, ?, 0, 'paypal', 'paid', ?, ?, datetime('now'), datetime('now'))
          `).bind(id, creator_id, balance, settings.paypal_email, batchId2).run();

          await env.DB.prepare("UPDATE balances SET balance=0, updated_at=? WHERE creator_id=?").bind(now, creator_id).run();

          await env.DB.prepare(`INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?,?,?,?,?)`)
            .bind("notif_"+Date.now(), creator_id, "💸",
              `Your PayPal payout of $${balance.toFixed(2)} has been sent to ${settings.paypal_email}!`, "just now").run();

          return json({ ok:true, message:`$${balance.toFixed(2)} sent to your PayPal (${settings.paypal_email}). Arrives within 24 hours.`, amount: balance });
        } catch(e) {
          // Network/API error — balance NOT deducted
          return err("PayPal payout failed: " + (e.message || "Unknown error") + ". Your balance has not been changed.");
        }
      }

      // ── Bank transfer: save as pending, process manually on 1st ─────
      await env.DB.prepare(`
        INSERT INTO payouts (id, creator_id, amount, fee, method, status, paypal_email, stripe_account, requested_at)
        VALUES (?, ?, ?, 0, ?, 'pending', ?, ?, datetime('now'))
      `).bind(id, creator_id, balance, payoutMethod, settings?.paypal_email||null, settings?.stripe_account_id||null).run();
      return json({ ok:true, message:`Bank transfer of $${balance.toFixed(2)} requested. We will process it within 3 business days.`, amount: balance });
    }
    // ── END PAYOUT ROUTES ────────────────────────────────────────────────

    if (path === "/" || path === "/index.html" || path === "/privacy" || path === "/terms") {
      const obj = await env.MEDIA.get("index.html");
      if (obj) {
        let html = await obj.text();
        // For /privacy and /terms inject a script to auto-open the right page
        if (path === "/privacy" || path === "/terms") {
          const page = path.slice(1); // 'privacy' or 'terms'
          html = html.replace('</body>', `<script>
(function(){
  var open=function(){
    document.querySelectorAll('.page').forEach(function(x){x.classList.remove('active');});
    var t=document.getElementById('page-${page}');
    if(t){t.classList.add('active');window.scrollTo({top:0});}
  };
  open();setTimeout(open,200);
})();
</script></body>`);
        }
        return new Response(html, { headers: { "Content-Type": "text/html", "Cache-Control": "no-cache", ...CORS } });
      }
    }
    // ── File upload — handle before body parsing to preserve multipart stream
    if (path === "/api/upload" && method === "POST") {
      try {
        const formData = await request.formData();
        const file = formData.get("file");
        const folder = (formData.get("folder") || "misc");
        if (!file) return err("No file provided");
        const originalName = (file.name || "file").replace(/[/\\/]/g, "_");
        const ext = (originalName.split(".").pop() || "bin").toLowerCase();
        const safeName = Date.now() + "_" + Math.random().toString(36).slice(2, 8) + "." + ext;
        const key = folder + "/" + safeName;
        const mimeType = file.type || "application/octet-stream";
        const arrayBuffer = await file.arrayBuffer();
        await env.MEDIA.put(key, arrayBuffer, { httpMetadata: { contentType: mimeType } });
        const publicUrl = "https://pub-022d3c5ab8b14ee3b34dc489dd76125e.r2.dev/" + key;
        return json({ url: publicUrl, key });
      } catch(e) {
        return err("Upload error: " + e.message, 500);
      }
    }

    let body = {};
    if (method === "POST" || method === "PUT") {
      const ct = request.headers.get("Content-Type") || "";
      if (ct.includes("application/json")) {
        try { body = await request.json(); } catch {}
      }
    }
    try {
      if (path === "/api/paypal/test") {
        try {
          const token = await getPayPalToken(env);
          return json({ success: true, preview: token.substring(0, 20) + "..." });
        } catch (e) {
          return json({ success: false, error: e.message });
        }
      }
      if (path === "/api/paypal/order" && method === "POST") {
        const { amount, description, user_id, creator_id, post_id, product_id, plan, user_name } = body;
        if (!amount) return err("Missing amount");
        const order = await paypalReq(env, "/v2/checkout/orders", "POST", {
          intent: "CAPTURE",
          purchase_units: [{
            amount: { currency_code: "USD", value: Number(amount).toFixed(2) },
            description: description || "Galaxy Payment"
          }],
          application_context: {
            return_url: "https://vygalaxy.dabarey24.workers.dev/?pp=success",
            cancel_url: "https://vygalaxy.dabarey24.workers.dev/?pp=cancel",
            brand_name: "Galaxy",
            user_action: "PAY_NOW",
            landing_page: "BILLING"
          }
        });
        return json({ id: order.id, status: order.status });
      }
      if (path === "/api/paypal/capture" && method === "POST") {
        const { order_id, user_id, creator_id, post_id, product_id, plan, amount, user_name } = body;
        if (!order_id) return err("Missing order_id");
        const amountNum = Number(amount||0);
        if (amountNum < 1) return err("Minimum payment is $1.");
        if (plan === "purchase" && amountNum < 5) return err("Minimum product price is $5.");
        const capture = await paypalReq(env, "/v2/checkout/orders/" + order_id + "/capture", "POST", {});
        if (capture.status !== "COMPLETED") return err("Payment not completed: " + capture.status);
        const creatorAmount = Math.round(Number(amount) * 0.71 * 100) / 100;
        if (plan === "tip" && post_id) {
          await env.DB.prepare(
            `INSERT INTO tips (id, post_id, creator_id, from_user_id, from_name, amount, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
          ).bind("tip_" + Date.now(), post_id, creator_id, user_id || "", user_name || "", creatorAmount).run();
          await env.DB.prepare(`UPDATE posts SET tips_count = tips_count + 1 WHERE id = ?`).bind(post_id).run();
        }
        if (plan === "purchase" && product_id) {
          await env.DB.prepare(
            `INSERT INTO purchases (id, user_id, product_id, price, stripe_pi_id, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`
          ).bind("pur_" + Date.now(), user_id, product_id, creatorAmount, "paypal_" + order_id).run();
          await env.DB.prepare(`UPDATE products SET sales = sales + 1 WHERE id = ?`).bind(product_id).run();
        }
        // Credit creator balance for PayPal payments
        if (creator_id) await creditBalance(env, creator_id, Number(amount));
        return json({ success: true, capture_id: order_id });
      }
      if (path === "/api/posts" && method === "GET") {
        const creatorId = url.searchParams.get("creator_id");
        if (creatorId) {
          const { results: results2 } = await env.DB.prepare(
            `SELECT p.*, u.name as creator_name, u.avatar as creator_avatar
             FROM posts p LEFT JOIN users u ON p.creator_id = u.id
             WHERE p.creator_id = ?
             ORDER BY p.created_at DESC LIMIT 100`
          ).bind(creatorId).all();
          return json(results2 || []);
        }
        const { results } = await env.DB.prepare(
          `SELECT p.*, u.name as creator_name, u.avatar as creator_avatar
           FROM posts p LEFT JOIN users u ON p.creator_id = u.id
           ORDER BY p.created_at DESC LIMIT 200`
        ).all();
        return json(results || []);
      }
      if (path === "/api/posts" && method === "POST") {
        const { creator_id, title, content, tier, media_type, media_url } = body;
        if (!creator_id || !content) return err("Missing fields");
        const id = "post_" + Date.now();
        await env.DB.prepare(
          `INSERT INTO posts (id, creator_id, title, content, tier, media_type, media_url, tips_count, comments_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, datetime('now'))`
        ).bind(id, creator_id, title || "", content, tier || "free", media_type || "", media_url || "").run();
        return json({ id, success: true });
      }
      if (path.startsWith("/api/posts/") && method === "DELETE") {
        const postId = path.split("/")[3];
        // Get media_url before deleting so we can remove from R2
        const post = await env.DB.prepare("SELECT media_url FROM posts WHERE id=?").bind(postId).first();
        await env.DB.prepare("DELETE FROM posts WHERE id=?").bind(postId).run();
        // Delete from R2 if media exists
        if (post?.media_url) {
          try {
            // Extract R2 key from public URL
            // e.g. https://pub-xxx.r2.dev/posts/filename.jpg -> posts/filename.jpg
            const r2Key = post.media_url.replace(/^https?:\/\/[^/]+\//, '');
            if (r2Key && !r2Key.startsWith('http')) {
              await env.MEDIA.delete(r2Key);
            }
          } catch(e) {
            console.warn('R2 delete failed:', e.message);
          }
        }
        return json({ success: true });
      }
      
      // ── Presigned upload URL for direct R2 upload ──────────────────────
      // ── Base64 upload endpoint (JSON, no multipart) ────────────────────
      if (path === "/api/upload/b64" && method === "POST") {
        const { key, mimeType, data } = body;
        if (!key || !mimeType || !data) return err("Missing key, mimeType or data");
        // Decode base64
        const binaryStr = atob(data);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        await env.MEDIA.put(key, bytes.buffer, {
          httpMetadata: { contentType: mimeType }
        });
        const publicUrl = "https://pub-022d3c5ab8b14ee3b34dc489dd76125e.r2.dev/" + key;
        return json({ url: publicUrl, key });
      }

      if (path === "/api/upload/presign" && method === "POST") {
        const { key, mimeType } = body;
        if (!key || !mimeType) return err("Missing key or mimeType");
        const allowed = ["image/jpeg","image/jpg","image/png","image/webp","image/gif","video/mp4","video/webm","video/quicktime","video/mov"];
        if (!allowed.includes(mimeType)) return err("File type not allowed: " + mimeType);
        if (key.includes("..") || key.startsWith("/")) return err("Invalid key");
        try {
          const signedUrl = await env.MEDIA.createMultipartUpload ? null : null; // fallback below
          // Generate presigned URL via R2 binding
          const url = await env.MEDIA.createPresignedUrl("PUT", key, {
            expiresIn: 300,
            httpMetadata: { contentType: mimeType }
          }).catch(async () => {
            // If createPresignedUrl not available, use Workers R2 presigned URL
            return null;
          });
          if (url) {
            const publicUrl = "https://pub-022d3c5ab8b14ee3b34dc489dd76125e.r2.dev/" + key;
            return json({ url, publicUrl, key });
          }
          // Fallback: direct upload through Worker
          return json({ url: null, publicUrl: null, key, fallback: true });
        } catch(e) {
          return err("Presign failed: " + e.message);
        }
      }

      if (path === "/api/upload/sign" && method === "POST") {
        const { key, mimeType } = body;
        if (!key || !mimeType) return err("Missing key or mimeType");
        const allowed = ["image/jpeg","image/png","image/webp","image/gif","video/mp4","video/webm","video/quicktime"];
        if (!allowed.includes(mimeType)) return err("File type not allowed");
        if (key.includes("..") || key.startsWith("/")) return err("Invalid key");
        const url2 = await env.MEDIA_BUCKET.createPresignedUrl("PUT", key, {
          expiresIn: 300,
          httpMetadata: { contentType: mimeType }
        });
        return json({ url: url2, publicUrl: "https://pub-022d3c5ab8b14ee3b34dc489dd76125e.r2.dev/" + key });
      }
      // ── Google OAuth ──────────────────────────────────────────────────────
      if (path === "/api/auth/google" && method === "POST") {
        const { id_token, ref_code } = body;
        if (!id_token) return err("Missing id_token");

        // Verify Google ID token via Google's tokeninfo endpoint
        const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${id_token}`);
        const payload = await verifyRes.json();

        if (!verifyRes.ok || payload.error) return err("Invalid Google token");
        if (payload.aud !== "402119272532-8e7gddl466tn5nasbb07uiivjp7rlrrh.apps.googleusercontent.com") {
          return err("Token audience mismatch");
        }

        const email = payload.email;
        const name = payload.name || email.split('@')[0];
        const avatar = payload.picture || '';
        const googleId = payload.sub;

        // Check if user exists
        let user = await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first();

        if (!user) {
          // Create new user
          const id = "user_" + Date.now();
          const role = email === "dabarey24@gmail.com" ? "admin" : "user";
          await env.DB.prepare(
            `INSERT INTO users (id, email, name, avatar, role, category, google_id, ref_code, created_at)
             VALUES (?, ?, ?, ?, ?, 'Other', ?, ?, datetime('now'))`
          ).bind(id, email, name, avatar, role, googleId, ref_code||null).run();
          user = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(id).first();
        } else if (!user.google_id) {
          // Link Google to existing account
          await env.DB.prepare("UPDATE users SET google_id=?, avatar=COALESCE(NULLIF(avatar,''),?) WHERE id=?")
            .bind(googleId, avatar, user.id).run();
        }

        const { password_hash, ...safe } = user;
        return json({ ...safe, avatar: avatar || safe.avatar });
      }

      // ── Forgot password ───────────────────────────────────────────────
      if (path === "/api/auth/forgot-password" && method === "POST") {
        const { email } = body;
        if (!email) return err("Missing email");
        const user = await env.DB.prepare("SELECT id, name FROM users WHERE email=?").bind(email).first();
        if (!user) return json({ success: true }); // Don't reveal if email exists
        // Generate reset token
        const token = crypto.randomUUID().replace(/-/g,'');
        const expires = new Date(Date.now() + 60*60*1000).toISOString(); // 1 hour
        await env.DB.prepare("UPDATE users SET reset_token=?, reset_expires=? WHERE id=?")
          .bind(token, expires, user.id).run().catch(async ()=>{
            // Add columns if missing
            await env.DB.prepare("ALTER TABLE users ADD COLUMN reset_token TEXT").run().catch(()=>{});
            await env.DB.prepare("ALTER TABLE users ADD COLUMN reset_expires TEXT").run().catch(()=>{});
            await env.DB.prepare("UPDATE users SET reset_token=?, reset_expires=? WHERE id=?")
              .bind(token, expires, user.id).run();
          });
        const resetUrl = "https://galaxyvy.com/?reset=" + token;
        // Send email via Resend
        if (env.RESEND_API_KEY) {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + env.RESEND_API_KEY },
            body: JSON.stringify({
              from: "GALAXY <vino@galaxyvy.com>",
              to: email,
              subject: "Reset your GALAXY password",
              html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#0a0000;color:#fff;border-radius:16px">
                <h2 style="font-family:Georgia,serif;font-weight:400;margin-bottom:8px">Password Reset</h2>
                <p style="color:rgba(255,255,255,.6);font-size:14px;margin-bottom:24px">Hi ${user.name}, click the button below to set a new password. This link expires in 1 hour.</p>
                <a href="${resetUrl}" style="display:inline-block;background:linear-gradient(135deg,#d4a843,#b8902e);color:#0a0000;text-decoration:none;padding:14px 28px;border-radius:100px;font-weight:700;font-size:15px">Reset password →</a>
                <p style="color:rgba(255,255,255,.3);font-size:12px;margin-top:24px">If you didn't request this, ignore this email. Your password won't change.</p>
              </div>`
            })
          });
        }
        return json({ success: true });
      }

      // ── Reset password (verify token + set new password) ─────────────
      if (path === "/api/auth/reset-password" && method === "POST") {
        const { token, password } = body;
        if (!token || !password) return err("Missing fields");
        if (password.length < 6) return err("Password too short");
        const user = await env.DB.prepare(
          "SELECT id FROM users WHERE reset_token=? AND reset_expires > datetime('now')"
        ).bind(token).first();
        if (!user) return err("Invalid or expired reset link");
        const hash = await hashPassword(password);
        await env.DB.prepare("UPDATE users SET password_hash=?, reset_token=NULL, reset_expires=NULL WHERE id=?")
          .bind(hash, user.id).run();
        return json({ success: true });
      }

      if (path === "/api/db/migrate" && method === "POST") {
        // Run migrations
        const migrations = [
          "ALTER TABLE users ADD COLUMN cert_status TEXT DEFAULT 'unsubmitted'",
          "ALTER TABLE users ADD COLUMN reset_token TEXT",
          "ALTER TABLE users ADD COLUMN reset_expires TEXT",
          "ALTER TABLE users ADD COLUMN ref_rate INTEGER DEFAULT 1",
          `CREATE TABLE IF NOT EXISTS cert_requests (id TEXT PRIMARY KEY, user_id TEXT, user_name TEXT, user_email TEXT, category TEXT, cert_url TEXT, status TEXT DEFAULT 'pending', submitted_at TEXT)`
        ];
        const results = [];
        for (const sql of migrations) {
          try { await env.DB.prepare(sql).run(); results.push({sql:'ok'}); }
          catch(e) { results.push({sql:'skip:'+e.message.slice(0,50)}); }
        }
        return json({ results });
      }

      if (path === "/api/users/register" && method === "POST") {
        const { email, password, name, category, ref_code } = body;
        if (!email || !password || !name) return err("Missing fields");
        const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
        if (existing) return err("Email already registered", 409);
        const id = "user_" + Date.now();
        const hash = await hashPassword(password);
        const role = email === "dabarey24@gmail.com" ? "admin" : "user";
        await env.DB.prepare(
          `INSERT INTO users (id, email, password_hash, name, role, category, ref_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        ).bind(id, email, hash, name, role, category || "Other", ref_code||null).run();
        return json({ id, email, name, role, category: category || "Other" });
      }
      if (path === "/api/users/login" && method === "POST") {
        const { email, password } = body;
        if (!email || !password) return err("Missing fields");
        const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
        if (!user) return err("Invalid email or password", 401);
        const valid = await verifyPassword(password, user.password_hash);
        if (!valid) return err("Invalid email or password", 401);
        const { password_hash, ...safe } = user;
        return json(safe);
      }
      if (path === "/api/users" && method === "GET") {
        const id = url.searchParams.get("id");
        const role = url.searchParams.get("role");
        if (role === "creator") {
          const { results } = await env.DB.prepare(
            `SELECT id,name,bio,avatar,cover,category,price,role,verified,kyc_status,subs_count,created_at FROM users WHERE role!='admin' ORDER BY created_at DESC`
          ).all();
          return json(results || []);
        }
        if (!id) return err("Missing id");
        const user = await env.DB.prepare("SELECT id,email,name,bio,avatar,cover,category,price,role,verified,kyc_status,cert_status,ref_rate,subs_count,created_at FROM users WHERE id=?").bind(id).first();
        if (!user) return err("User not found", 404);
        return json(user);
      }
      if (path === "/api/products" && method === "GET") {
        const creatorId = url.searchParams.get("creator_id");
        const normalize = rows => (rows||[]).map(p => ({
          ...p,
          creatorId:    p.creator_id,
          creatorName:  p.creator_name  || '',
          creatorAvatar:p.creator_avatar || '',
          desc:         p.desc || p.description || '',
          sales:        p.sales || p.sales_count || 0,
          includes:     p.deliverables ? (() => { try { const d=JSON.parse(p.deliverables); return d.lessons?.map(l=>l.title)||d.includes||[]; } catch(e){ return []; } })() : [],
        }));
        if (creatorId) {
          const { results } = await env.DB.prepare(
            `SELECT p.*, u.name as creator_name, u.avatar as creator_avatar
             FROM products p LEFT JOIN users u ON p.creator_id = u.id
             WHERE p.creator_id=? ORDER BY p.created_at DESC`
          ).bind(creatorId).all();
          return json(normalize(results));
        }
        const { results } = await env.DB.prepare(
          `SELECT p.*, u.name as creator_name, u.avatar as creator_avatar
           FROM products p LEFT JOIN users u ON p.creator_id = u.id
           ORDER BY p.created_at DESC`
        ).all();
        return json(normalize(results));
      }
      if (path === "/api/products" && method === "POST") {
        const { id: clientId, creator_id, creator_name, creator_avatar, title, desc, description, type, price, emoji, deliverables, cover_url, sample_url, preview } = body;
        if (!creator_id || !title || !price) return err("Missing fields");
        if (Number(price) < 5) return err("Minimum product price is $5.");
        const id = clientId || ("prod_" + Date.now());
        const finalDesc = description || desc || "";
        // Add columns if missing
        for (const col of ["cover_url TEXT","sample_url TEXT","preview TEXT","creator_name TEXT","creator_avatar TEXT","description TEXT","category TEXT"]) {
          await env.DB.prepare(`ALTER TABLE products ADD COLUMN ${col}`).run().catch(()=>{});
        }
        await env.DB.prepare(
          `INSERT OR REPLACE INTO products (id, creator_id, creator_name, creator_avatar, title, desc, description, type, price, emoji, deliverables, cover_url, sample_url, preview, category, sales, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))`
        ).bind(id, creator_id, creator_name||'', creator_avatar||'', title, finalDesc, finalDesc, type||"digital", price, emoji||"📦", typeof deliverables==='string'?deliverables:JSON.stringify(deliverables||{}), cover_url||'', sample_url||'', preview||'', category||'').run();
        return json({ id, success: true });
      }
      if (path.match(/^\/api\/products\/[^\/]+\/analytics$/) && method === "GET") {
        const productId = path.split("/")[3];
        const { results } = await env.DB.prepare(
          `SELECT pu.created_at, u.name as buyer_name, pu.amount
           FROM purchases pu LEFT JOIN users u ON pu.user_id = u.id
           WHERE pu.product_id=? ORDER BY pu.created_at DESC LIMIT 20`
        ).bind(productId).all().catch(()=>({results:[]}));
        const prod = await env.DB.prepare("SELECT sales, price FROM products WHERE id=?").bind(productId).first().catch(()=>null);
        return json({ recent: results||[], sales: prod?.sales||0, price: prod?.price||0 });
      }

      // ── Product analytics ─────────────────────────────────────────────
      if (path.match(/^\/api\/products\/[^/]+\/analytics$/) && method === "GET") {
        const productId = path.split("/")[3];
        // Get recent purchases for this product
        const { results: recent } = await env.DB.prepare(
          `SELECT p.buyer_name, p.amount, p.created_at
           FROM purchases p WHERE p.product_id=?
           ORDER BY p.created_at DESC LIMIT 20`
        ).bind(productId).all().catch(()=>({results:[]}));
        // Get total sales from product record
        const prod = await env.DB.prepare("SELECT sales, price FROM products WHERE id=?").bind(productId).first().catch(()=>null);
        return json({ recent: recent||[], sales: prod?.sales||0, price: prod?.price||0 });
      }

      if (path.startsWith("/api/products/") && method === "DELETE") {
        const productId = path.split("/")[3];
        const prod = await env.DB.prepare("SELECT cover_url, sample_url FROM products WHERE id=?").bind(productId).first();
        await env.DB.prepare("DELETE FROM products WHERE id=?").bind(productId).run();
        // Delete cover and sample from R2
        for (const url of [prod?.cover_url, prod?.sample_url]) {
          if (!url) continue;
          try {
            const key = url.replace(/^https?:\/\/[^/]+\//, '');
            if (key && !key.startsWith('http')) await env.MEDIA.delete(key);
          } catch(e) {}
        }
        return json({ success: true });
      }

      if (path === "/api/subscriptions" && method === "GET") {
        const userId = url.searchParams.get("user_id");
        if (!userId) return err("Missing user_id");
        const { results } = await env.DB.prepare(
          `SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active'`
        ).bind(userId).all();
        return json(results || []);
      }
      if (path === "/api/purchases" && method === "GET") {
        const userId = url.searchParams.get("user_id");
        if (!userId) return err("Missing user_id");
        const { results } = await env.DB.prepare(
          `SELECT pu.*, p.title as product_title, p.emoji, p.deliverables
           FROM purchases pu LEFT JOIN products p ON pu.product_id = p.id
           WHERE pu.user_id = ?`
        ).bind(userId).all();
        return json(results || []);
      }
      if (path === "/api/pay" && method === "POST") {
        const {
          payment_method_id, user_id, user_email, user_name, plan, price_usd,
          creator_id, creator_name, product_id, product_title, post_id
        } = body;
        if (!payment_method_id || !price_usd) return err("Missing payment fields");
        const amountUsd = Number(price_usd);
        const originalPrice = Number(body.original_price || price_usd);
        if (amountUsd < 0.5) return err("Minimum payment is $0.50.");
        if ((plan === "subscription" || plan === "purchase") && Number(body.original_price || price_usd) < 2) return err("Minimum price is $2.");
        const amountCents = Math.round(Number(amountUsd) * 100);
        const creatorAmount = Math.round(originalPrice * 0.71 * 100) / 100;
        // Get real email from D1 if not provided
        let resolvedEmail = user_email;
        if (!resolvedEmail && user_id) {
          const u = await env.DB.prepare("SELECT email FROM users WHERE id=?").bind(user_id).first().catch(()=>null);
          resolvedEmail = u?.email || '';
        }
        if (!resolvedEmail) return err("Could not find user email for Stripe");
        const existing = await stripeReq(env, `/customers?email=${encodeURIComponent(resolvedEmail)}&limit=1`, "GET");
        let customerId;
        if (existing.data?.length > 0) {
          customerId = existing.data[0].id;
        } else {
          const c = await stripeReq(env, "/customers", "POST", { email: resolvedEmail, name: user_name || resolvedEmail });
          customerId = c.id;
        }
        await stripeReq(env, `/payment_methods/${payment_method_id}/attach`, "POST", { customer: customerId });
        await stripeReq(env, `/customers/${customerId}`, "POST", { "invoice_settings[default_payment_method]": payment_method_id });
        if (plan === "tip" || plan === "purchase") {
          const pi = await stripeReq(env, "/payment_intents", "POST", {
            amount: String(amountCents),
            currency: "usd",
            customer: customerId,
            payment_method: payment_method_id,
            confirm: "true",
            "automatic_payment_methods[enabled]": "true",
            "automatic_payment_methods[allow_redirects]": "never",
            "metadata[plan]": plan,
            "metadata[user_id]": user_id || "",
            "metadata[creator_id]": creator_id || "",
            "metadata[post_id]": post_id || "",
            "metadata[product_id]": product_id || ""
          });
          if (pi.status === "requires_action") return json({ requires_action: true, client_secret: pi.client_secret });
          if (plan === "tip" && post_id) {
            await env.DB.prepare(
              `INSERT INTO tips (id, post_id, creator_id, from_user_id, from_name, amount, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
            ).bind("tip_" + Date.now(), post_id, creator_id, user_id || "", user_name || "", creatorAmount).run();
            await env.DB.prepare(`UPDATE posts SET tips_count = tips_count + 1 WHERE id = ?`).bind(post_id).run();
          }
          if (plan === "purchase" && product_id) {
            await env.DB.prepare(
              `INSERT INTO purchases (id, user_id, product_id, price, stripe_pi_id, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`
            ).bind("pur_" + Date.now(), user_id, product_id, creatorAmount, pi.id).run();
            await env.DB.prepare(`UPDATE products SET sales = sales + 1 WHERE id = ?`).bind(product_id).run();
          }
          // Credit creator balance
          if (creator_id) await creditBalance(env, creator_id, originalPrice);
          return json({ success: true, payment_intent_id: pi.id });
        } else {
          // Subscription
          try {
            const priceObj = await stripeReq(env, "/prices", "POST", {
              unit_amount: String(amountCents),
              currency: "usd",
              "recurring[interval]": "month",
              "product_data[name]": `Galaxy - ${creator_name||'Creator'}`
            });
            if (!priceObj?.id) return err("Stripe price creation failed: " + JSON.stringify(priceObj));
            const sub = await stripeReq(env, "/subscriptions", "POST", {
              customer: customerId,
              "items[0][price]": priceObj.id,
              default_payment_method: payment_method_id,
              "metadata[creator_id]": creator_id || "",
              "metadata[user_id]": user_id || "",
              "expand[0]": "latest_invoice.payment_intent"
            });
            if (!sub?.id) return err("Stripe subscription creation failed: " + JSON.stringify(sub));
            const pi = sub.latest_invoice?.payment_intent;
            const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1e3).toISOString() : null;
            await env.DB.prepare(
              `INSERT OR REPLACE INTO subscriptions (id, user_id, creator_id, creator_name, plan, price, status, stripe_sub_id, stripe_customer_id, period_end, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
            ).bind("sub_" + Date.now(), user_id||'', creator_id||'', creator_name||'Creator', plan||'subscription', Number(price_usd)||0, sub.status||'active', sub.id||'', customerId||'', periodEnd||null).run();
            if (pi?.status === "requires_action") return json({ requires_action: true, client_secret: pi.client_secret, subscription_id: sub.id });
            try { await creditReferrer(env, user_id, price_usd, 'sub'); } catch(e) {}
            // Update creator subs_count
            await env.DB.prepare("UPDATE users SET subs_count = COALESCE(subs_count,0)+1 WHERE id=?").bind(creator_id||'').run().catch(()=>{});
            // Notify creator
            await env.DB.prepare("INSERT INTO notifications (id,user_id,icon,text,time) VALUES (?,?,?,?,?)")
              .bind("notif_sub_"+Date.now(), creator_id||'', "⭐", (user_name||"Someone")+" subscribed to you!", "just now").run().catch(()=>{});
            return json({ success: true, subscription_id: sub.id, period_end: periodEnd });
          } catch(subErr) {
            return err("Subscription failed: " + (subErr.message || String(subErr)), 500);
          }
        }
      }
      if (path === "/api/webhook/stripe" && method === "POST") {
        const sig = request.headers.get("stripe-signature");
        const rawBody = await request.text();
        const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
        if (webhookSecret) {
          try {
            const parts = sig.split(",");
            const timestamp = parts.find((p) => p.startsWith("t=")).split("=")[1];
            const signatures = parts.filter((p) => p.startsWith("v1=")).map((p) => p.split("=")[1]);
            const signedPayload = timestamp + "." + rawBody;
            const enc = new TextEncoder();
            const key = await crypto.subtle.importKey("raw", enc.encode(webhookSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
            const sig_bytes = await crypto.subtle.sign("HMAC", key, enc.encode(signedPayload));
            const computed = Array.from(new Uint8Array(sig_bytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
            if (!signatures.includes(computed)) return err("Invalid signature", 400);
          } catch (e) {
            return err("Webhook verification failed", 400);
          }
        }
        const event = JSON.parse(rawBody);
        const data = event.data?.object;

        if (event.type === "payment_intent.succeeded") {
          const meta = data.metadata || {};
          const creatorId = meta.creator_id;
          const amountUsd = (data.amount || 0) / 100;
          if (creatorId) await creditBalance(env, creatorId, amountUsd);
        }

        if (event.type === "invoice.payment_succeeded") {
          const subId = data.subscription;
          if (subId) {
            // Use actual period end from Stripe, not +1 month estimate
            const periodEnd = data.lines?.data?.[0]?.period?.end
              ? new Date(data.lines.data[0].period.end * 1000).toISOString()
              : null;
            await env.DB.prepare(
              `UPDATE subscriptions SET status='active'${periodEnd ? ", period_end='" + periodEnd + "'" : ", period_end=datetime('now', '+1 month')"} WHERE stripe_sub_id=?`
            ).bind(subId).run();
            // Credit creator — use stored price (original, before fee passthrough)
            const sub = await env.DB.prepare(
              `SELECT creator_id, price FROM subscriptions WHERE stripe_sub_id=?`
            ).bind(subId).first();
            if (sub?.creator_id) await creditBalance(env, sub.creator_id, Number(sub.price));
          }
        }
        if (event.type === "invoice.payment_failed") {
          const subId = data.subscription;
          if (subId) {
            await env.DB.prepare(
              `UPDATE subscriptions SET status='past_due' WHERE stripe_sub_id=?`
            ).bind(subId).run();
          }
        }
        if (event.type === "customer.subscription.deleted") {
          const subId = data.id;
          await env.DB.prepare(
            `UPDATE subscriptions SET status='cancelled' WHERE stripe_sub_id=?`
          ).bind(subId).run();
        }
        if (event.type === "customer.subscription.updated") {
          const subId = data.id;
          const status = data.status;
          const periodEnd = data.current_period_end ? new Date(data.current_period_end * 1e3).toISOString() : null;
          await env.DB.prepare(
            `UPDATE subscriptions SET status=?, period_end=? WHERE stripe_sub_id=?`
          ).bind(status, periodEnd, subId).run();
        }
        return json({ received: true });
      }
      // ── Cancel subscription ──────────────────────────────────────────────
      // ── Confirm subscription — update subs_count + notify creator ────────
      // ── Stripe Connect ───────────────────────────────────────────────────
      // Start onboarding — returns a Stripe Connect onboarding URL
      if (path === "/api/stripe/connect/onboard" && method === "POST") {
        const { user_id, email } = body;
        if (!user_id) return err("Missing user_id");
        // Check if already has an account
        let settings = await env.DB.prepare("SELECT stripe_account_id FROM payout_settings WHERE creator_id=?").bind(user_id).first().catch(()=>null);
        let accountId = settings?.stripe_account_id;
        if (!accountId) {
          // Create Express account
          const acct = await stripeReq(env, "/accounts", "POST", {
            type: "express",
            email: email || "",
            capabilities: { transfers: { requested: "true" } },
            business_type: "individual",
          });
          if (!acct?.id) return err("Could not create Stripe account");
          accountId = acct.id;
          await env.DB.prepare("INSERT INTO payout_settings (id,creator_id,stripe_account_id) VALUES (?,?,?) ON CONFLICT(creator_id) DO UPDATE SET stripe_account_id=?")
            .bind("ps_"+user_id, user_id, accountId, accountId).run().catch(async ()=>{
              await env.DB.prepare("UPDATE payout_settings SET stripe_account_id=? WHERE creator_id=?").bind(accountId, user_id).run().catch(()=>{});
            });
          await env.DB.prepare("UPDATE users SET stripe_account_id=? WHERE id=?").bind(accountId, user_id).run().catch(()=>{});
        }
        // Create account link for onboarding
        const link = await stripeReq(env, "/account_links", "POST", {
          account: accountId,
          refresh_url: "https://galaxyvy.com/?stripe_connect=refresh",
          return_url: "https://galaxyvy.com/?stripe_connect=success",
          type: "account_onboarding",
        });
        return json({ url: link.url, account_id: accountId });
      }

      // Check Stripe Connect status
      if (path === "/api/stripe/connect/status" && method === "GET") {
        const userId = url.searchParams.get("user_id");
        if (!userId) return err("Missing user_id");
        const settings = await env.DB.prepare("SELECT stripe_account_id, stripe_onboarded FROM payout_settings WHERE creator_id=?").bind(userId).first().catch(()=>null);
        if (!settings?.stripe_account_id) return json({ connected: false });
        // Check with Stripe
        try {
          const acct = await stripeReq(env, `/accounts/${settings.stripe_account_id}`, "GET");
          const onboarded = acct.details_submitted && acct.charges_enabled;
          if (onboarded) {
            await env.DB.prepare("UPDATE payout_settings SET stripe_onboarded=1 WHERE creator_id=?").bind(userId).run().catch(()=>{});
          }
          return json({ connected: true, onboarded, account_id: settings.stripe_account_id });
        } catch(e) {
          return json({ connected: !!settings.stripe_account_id, onboarded: !!settings.stripe_onboarded });
        }
      }

      // Auto payout via Stripe Connect
      if (path === "/api/payout/stripe" && method === "POST") {
        const { user_id, amount } = body;
        if (!user_id || !amount) return err("Missing fields");
        const settings = await env.DB.prepare("SELECT stripe_account_id, stripe_onboarded FROM payout_settings WHERE creator_id=?").bind(user_id).first().catch(()=>null);
        if (!settings?.stripe_account_id) return err("No Stripe account connected. Please complete onboarding first.");
        if (!settings.stripe_onboarded) return err("Stripe account not fully verified yet.");
        const bal = await env.DB.prepare("SELECT balance FROM balances WHERE creator_id=?").bind(user_id).first().catch(()=>null);
        const available = bal?.balance || 0;
        if (amount > available) return err(`Insufficient balance. Available: $${available.toFixed(2)}`);
        // Transfer to connected account
        const amountCents = Math.round(amount * 100);
        const transfer = await stripeReq(env, "/transfers", "POST", {
          amount: String(amountCents),
          currency: "usd",
          destination: settings.stripe_account_id,
          description: "Galaxy creator payout",
        });
        if (!transfer?.id) return err("Transfer failed");
        // Deduct balance
        await env.DB.prepare("UPDATE balances SET balance=balance-? WHERE creator_id=?").bind(amount, user_id).run();
        // Record payout
        await env.DB.prepare("INSERT INTO payouts (id,creator_id,amount,method,status,created_at) VALUES (?,?,?,'stripe','paid',datetime('now'))")
          .bind("pay_"+Date.now(), user_id, amount).run().catch(()=>{});
        // Notify creator
        await env.DB.prepare("INSERT INTO notifications (id,user_id,icon,text,time) VALUES (?,?,?,?,?)")
          .bind("notif_pay_"+Date.now(), user_id, "💸", "$"+amount.toFixed(2)+" sent to your Stripe account!", "just now").run().catch(()=>{});
        return json({ success: true, transfer_id: transfer.id });
      }

      if (path === "/api/subscriptions/confirm" && method === "POST") {
        const { user_id, user_name, creator_id } = body;
        if (!creator_id) return err("Missing creator_id");
        // Increment subs_count
        await env.DB.prepare("UPDATE users SET subs_count=COALESCE(subs_count,0)+1 WHERE id=?")
          .bind(creator_id).run().catch(()=>{});
        // Notify creator
        await env.DB.prepare("INSERT INTO notifications (id,user_id,icon,text,time) VALUES (?,?,?,?,?)")
          .bind("notif_sub_"+Date.now(), creator_id, "⭐", (user_name||"Someone")+" subscribed to you!", "just now")
          .run().catch(()=>{});
        return json({ ok: true });
      }

      if (path === "/api/subscriptions/cancel" && method === "POST") {
        const { user_id, creator_id, stripe_sub_id } = body;
        if (!user_id || !creator_id) return err("Missing fields");
        // Find the active subscription
        const sub = await env.DB.prepare(
          `SELECT * FROM subscriptions WHERE user_id=? AND creator_id=? LIMIT 1`
        ).bind(user_id, creator_id).first();
        // Cancel in Stripe
        const subIdToCancel = stripe_sub_id || sub?.stripe_sub_id;
        if (subIdToCancel) {
          try {
            await stripeReq(env, `/subscriptions/${subIdToCancel}`, "POST", {
              cancel_at_period_end: "true"
            });
          } catch(e) { console.warn("Stripe cancel failed:", e.message); }
        }
        // Update D1 if record exists
        if (sub) {
          await env.DB.prepare(`UPDATE subscriptions SET status='cancelling' WHERE id=?`).bind(sub.id).run();
        } else {
          // Insert cancelling record so UI reflects state
          await env.DB.prepare(`INSERT OR IGNORE INTO subscriptions (id,user_id,creator_id,status,created_at) VALUES (?,?,?,'cancelling',datetime('now'))`)
            .bind('sub_'+Date.now(), user_id, creator_id).run().catch(()=>{});
        }
        return json({ ok: true, message: "Subscription cancelled." });
      }

      if (path === "/api/balance" && method === "GET") {
        const userId = url.searchParams.get("user_id");
        if (!userId) return err("Missing user_id");
        const tips = await env.DB.prepare(
          `SELECT COALESCE(SUM(amount),0) as total FROM tips WHERE creator_id=?`
        ).bind(userId).first();
        const subs = await env.DB.prepare(
          `SELECT COALESCE(SUM(price),0) as total, COUNT(*) as count FROM subscriptions WHERE creator_id=? AND status='active'`
        ).bind(userId).first();
        const sales = await env.DB.prepare(
          `SELECT COALESCE(SUM(pu.price),0) as total FROM purchases pu
           LEFT JOIN products p ON pu.product_id = p.id
           WHERE p.creator_id=?`
        ).bind(userId).first();
        const totalEarned = Number(tips.total || 0) + Number(subs.total || 0) + Number(sales.total || 0);
        return json({
          balance: Math.round(totalEarned * 100) / 100,
          total_earned: Math.round(totalEarned * 100) / 100,
          subscriber_count: Number(subs.count || 0),
          tips_total: Math.round(Number(tips.total || 0) * 100) / 100,
          sales_total: Math.round(Number(sales.total || 0) * 100) / 100
        });
      }
      if (path === "/api/notifications" && method === "GET") {
        const userId = url.searchParams.get("user_id");
        if (!userId) return err("Missing user_id");
        const { results } = await env.DB.prepare(
          `SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50`
        ).bind(userId).all();
        return json(results || []);
      }
      if (path === "/api/notifications" && method === "POST") {
        const { user_id, icon, text, time } = body;
        if (!user_id || !text) return err("Missing fields");
        const id = "notif_" + Date.now();
        await env.DB.prepare(
          `INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?, ?, ?, ?, ?)`
        ).bind(id, user_id, icon || "🔔", text, time || "just now").run();
        return json({ id, success: true });
      }
      if (path === "/api/notifications/read" && method === "POST") {
        const { user_id } = body;
        if (!user_id) return err("Missing user_id");
        await env.DB.prepare(`UPDATE notifications SET read=1 WHERE user_id=?`).bind(user_id).run();
        return json({ success: true });
      }
      if (path === "/api/messages" && method === "GET") {
        const userId = url.searchParams.get("user_id");
        if (!userId) return err("Missing user_id");
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
      if (path === "/api/messages" && method === "POST") {
        const { from_id, to_id, text, from_name } = body;
        if (!from_id || !to_id || !text) return err("Missing fields");
        const id = "msg_" + Date.now();
        const sender = await env.DB.prepare("SELECT name FROM users WHERE id=?").bind(from_id).first();
        await env.DB.prepare(
          `INSERT INTO messages (id, from_id, to_id, from_name, text, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`
        ).bind(id, from_id, to_id, sender?.name||from_name||'', text).run();
        // Messages go to Messages tab only — not notifications
        return json({ id, success: true });
      }
      if (path === "/api/kyc" && method === "POST") {
        const { user_id, user_name, user_email, legal_name, dob, country, payout_method, payout_details, id_front_url, id_back_url, selfie_url } = body;
        if (!user_id) return err("Missing user_id");
        const id = "kyc_" + Date.now();
        // Check if columns exist, if not use basic insert
        try {
          await env.DB.prepare(
            `INSERT OR REPLACE INTO kyc_requests (id, user_id, user_name, user_email, legal_name, dob, country, payout_method, payout_details, id_front_url, id_back_url, selfie_url, status, submitted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`
          ).bind(id, user_id, user_name||'', user_email||'', legal_name||'', dob||'', country||'', payout_method||'bank', payout_details||'', id_front_url||'', id_back_url||'', selfie_url||'').run();
        } catch(e) {
          // Fallback without doc columns if they don't exist yet
          await env.DB.prepare(
            `INSERT OR REPLACE INTO kyc_requests (id, user_id, user_name, user_email, legal_name, dob, country, payout_method, payout_details, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
          ).bind(id, user_id, user_name||'', user_email||'', legal_name||'', dob||'', country||'', payout_method||'bank', payout_details||'').run();
        }
        await env.DB.prepare(`UPDATE users SET kyc_status='pending' WHERE id=?`).bind(user_id).run();
        return json({ id, success: true });
      }
      if (path === "/api/kyc" && method === "GET") {
        const { results } = await env.DB.prepare(
          `SELECT * FROM kyc_requests ORDER BY COALESCE(submitted_at, created_at) DESC`
        ).all();
        return json(results || []);
      }
      if (path === "/api/kyc/review" && method === "POST") {
        const { kyc_id, user_id, action } = body;
        if (!kyc_id || !action) return err("Missing fields");
        await env.DB.prepare(`UPDATE kyc_requests SET status=? WHERE id=?`).bind(action, kyc_id).run();
        if (user_id) {
          const verified = action === "approved" ? 1 : 0;
          await env.DB.prepare(`UPDATE users SET kyc_status=?, verified=? WHERE id=?`).bind(action, verified, user_id).run();
          const notifId = "notif_" + Date.now();
          const msg = action === "approved" ? "Your KYC is approved! You are now verified ✅" : "Your KYC was rejected. Please resubmit with clearer documents.";
          await env.DB.prepare(
            `INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?, ?, ?, ?, ?)`
          ).bind(notifId, user_id, action === "approved" ? "✅" : "❌", msg, "just now").run();
        }
        return json({ success: true });
      }
      if (path === "/api/payouts" && method === "POST") {
        const { user_id, user_name, user_email, amount, method: payMethod, details } = body;
        if (!user_id || !amount) return err("Missing fields");
        const id = "payout_" + Date.now();
        await env.DB.prepare(
          `INSERT INTO payout_requests (id, user_id, user_name, user_email, amount, method, details, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
        ).bind(id, user_id, user_name, user_email, amount, payMethod, details).run();
        return json({ id, success: true });
      }
      if (path === "/api/payouts" && method === "GET") {
        const { results } = await env.DB.prepare(
          `SELECT * FROM payout_requests ORDER BY created_at DESC`
        ).all();
        return json(results || []);
      }
      if (path === "/api/payouts/review" && method === "POST") {
        const { payout_id, user_id, action, amount } = body;
        if (!payout_id || !action) return err("Missing fields");
        await env.DB.prepare(`UPDATE payout_requests SET status=? WHERE id=?`).bind(action, payout_id).run();
        if (user_id && action === "paid") {
          await env.DB.prepare(`UPDATE users SET balance=MAX(0,balance-?) WHERE id=?`).bind(amount, user_id).run();
          const notifId = "notif_" + Date.now();
          await env.DB.prepare(
            `INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?, ?, ?, ?, ?)`
          ).bind(notifId, user_id, "💸", "Your payout of $" + amount + " has been sent!", "just now").run();
        }
        return json({ success: true });
      }
      if (path === "/api/reviews" && method === "GET") {
        const productId = url.searchParams.get("product_id");
        if (!productId) return err("Missing product_id");
        const { results } = await env.DB.prepare(
          `SELECT r.*, u.name as user_name, u.avatar as user_avatar
           FROM reviews r LEFT JOIN users u ON r.user_id = u.id
           WHERE r.product_id=? ORDER BY r.created_at DESC`
        ).bind(productId).all();
        return json(results || []);
      }
      if (path === "/api/reviews" && method === "POST") {
        const { user_id, product_id, rating, text } = body;
        if (!user_id || !product_id || !rating) return err("Missing fields");
        const id = "rev_" + Date.now();
        await env.DB.prepare(
          `INSERT INTO reviews (id, user_id, product_id, rating, text) VALUES (?, ?, ?, ?, ?)`
        ).bind(id, user_id, product_id, rating, text || "").run();
        return json({ id, success: true });
      }
      // ── Admin: list all payouts ──────────────────────────────────────────
      if (path === "/api/admin/payouts" && method === "GET") {
        const { results } = await env.DB.prepare(`
          SELECT p.*, ps.paypal_email, ps.bank_name, ps.bank_iban, ps.bank_swift,
            ps.bank_account, ps.bank_routing, ps.bank_sortcode, ps.bank_bankname, ps.bank_country,
            u.name as creator_name, u.email as creator_email
          FROM payouts p
          LEFT JOIN payout_settings ps ON p.creator_id = ps.creator_id
          LEFT JOIN users u ON p.creator_id = u.id
          ORDER BY p.requested_at DESC LIMIT 200
        `).all();
        return json({ payouts: results || [] });
      }

      // ── Admin: mark payout paid or rejected ─────────────────────────────
      if (path === "/api/admin/payouts/mark-paid" && method === "POST") {
        const { payout_id, reference, action } = body;
        if (!payout_id) return err("Missing payout_id");
        const payout = await env.DB.prepare("SELECT * FROM payouts WHERE id=?").bind(payout_id).first();
        if (!payout) return err("Payout not found", 404);
        const newStatus = action === "rejected" ? "rejected" : "paid";
        const now = new Date().toISOString();
        await env.DB.prepare(
          "UPDATE payouts SET status=?, reference=?, paid_at=? WHERE id=?"
        ).bind(newStatus, reference||"manual", now, payout_id).run();
        if (newStatus === "paid") {
          // Deduct only the payout amount from balance
          await env.DB.prepare(
            "UPDATE balances SET balance=MAX(0, balance-?), updated_at=? WHERE creator_id=?"
          ).bind(Number(payout.amount)||0, now, payout.creator_id).run();
          // Notify creator
          await env.DB.prepare(
            `INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?,?,?,?,?)`
          ).bind("notif_"+Date.now(), payout.creator_id, "💸",
            `Your payout of $${Number(payout.amount).toFixed(2)} has been sent!`, "just now").run();
        } else {
          await env.DB.prepare(
            `INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?,?,?,?,?)`
          ).bind("notif_"+Date.now(), payout.creator_id, "❌",
            `Your payout request of $${Number(payout.amount).toFixed(2)} was rejected. Please contact support.`, "just now").run();
        }
        return json({ ok: true });
      }

      // ── Admin: verify/unverify user ─────────────────────────────────────
      if (path === "/api/admin/users/verify" && method === "POST") {
        const { user_id, verified } = body;
        if (!user_id) return err("Missing user_id");
        await env.DB.prepare("UPDATE users SET verified=? WHERE id=?").bind(verified?1:0, user_id).run();
        if (verified) {
          await env.DB.prepare(`INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?,?,?,?,?)`)
            .bind("notif_"+Date.now(), user_id, "✅", "Your account has been verified!", "just now").run();
        }
        return json({ ok: true });
      }

      if (path === "/api/admin/users" && method === "GET") {
        const { results } = await env.DB.prepare(
          `SELECT id, email, name, bio, avatar, category, price, role, kyc_status, verified, balance, earned, created_at FROM users ORDER BY created_at DESC`
        ).all();
        return json(results || []);
      }
      if (path === "/api/users/profile" && method === "PUT") {
        const { id, name, bio, avatar, cover, category, price, payout_method, payout_details } = body;
        if (!id) return err("Missing id");
        await env.DB.prepare(
          `UPDATE users SET name=?, bio=?, avatar=?, cover=?, category=?, price=?, payout_method=?, payout_details=? WHERE id=?`
        ).bind(name || "", bio || "", avatar || "", cover || "", category || "Other", price || 9, payout_method || "", payout_details || "", id).run();
        const updated = await env.DB.prepare(
          `SELECT id,email,name,bio,avatar,cover,category,price,role,verified,kyc_status FROM users WHERE id=?`
        ).bind(id).first();
        return json({ success: true, user: updated });
      }
      if (path === "/api/users/profile" && method === "GET") {
        const id = url.searchParams.get("id");
        if (!id) return err("Missing id");
        const user = await env.DB.prepare(
          `SELECT id,email,name,bio,avatar,cover,category,price,role,verified,kyc_status FROM users WHERE id=?`
        ).bind(id).first();
        if (!user) return err("User not found", 404);
        return json(user);
      }
      if (path.startsWith("/media/") && method === "GET") {
        const key = path.slice(7);
        const obj = await env.MEDIA.get(key);
        if (!obj) return err("Not found", 404);
        const headers = { ...CORS };
        if (obj.httpMetadata?.contentType) headers["Content-Type"] = obj.httpMetadata.contentType;
        headers["Cache-Control"] = "public, max-age=31536000";
        return new Response(obj.body, { headers });
      }
      // ── Professional certification ──────────────────────────────────────
      // Debug: check cert table
      if (path === "/api/cert/check" && method === "GET") {
        try {
          const {results} = await env.DB.prepare("SELECT COUNT(*) as cnt FROM cert_requests").all();
          return json({ table_exists: true, count: results?.[0]?.cnt||0 });
        } catch(e) {
          return json({ table_exists: false, error: e.message });
        }
      }

      if (path === "/api/cert" && method === "POST") {
        const { user_id, user_name, user_email, category, cert_url } = body;
        if (!user_id || !cert_url) return err("Missing fields");
        // Ensure table exists
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS cert_requests (
          id TEXT PRIMARY KEY, user_id TEXT, user_name TEXT, user_email TEXT,
          category TEXT, cert_url TEXT, status TEXT DEFAULT 'pending', submitted_at TEXT
        )`).run().catch(()=>{});
        const id = "cert_" + Date.now();
        await env.DB.prepare(
          `INSERT OR REPLACE INTO cert_requests (id,user_id,user_name,user_email,category,cert_url,status,submitted_at)
           VALUES (?,?,?,?,?,?,'pending',datetime('now'))`
        ).bind(id, user_id, user_name||'', user_email||'', category||'', cert_url).run();
        // Update user cert status
        try {
          await env.DB.prepare("ALTER TABLE users ADD COLUMN cert_status TEXT DEFAULT 'unsubmitted'").run();
        } catch(e) {} // column may already exist
        await env.DB.prepare("UPDATE users SET cert_status='pending' WHERE id=?").bind(user_id).run();
        // Notify admin
        const admin = await env.DB.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").first();
        if (admin) {
          await env.DB.prepare("INSERT INTO notifications (id,user_id,icon,text,time) VALUES (?,?,?,?,?)")
            .bind("notif_cert_req_"+Date.now(), admin.id, "📋",
              (user_name||'A user')+" submitted a "+( category||'professional')+" certificate for verification", "just now").run().catch(()=>{});
        }
        return json({ id, success: true });
      }

      if (path === "/api/cert" && method === "GET") {
        const userId = url.searchParams.get("user_id");
        if (userId) {
          const row = await env.DB.prepare("SELECT * FROM cert_requests WHERE user_id=? ORDER BY submitted_at DESC LIMIT 1").bind(userId).first();
          return json(row || { status: null });
        }
        const { results } = await env.DB.prepare("SELECT * FROM cert_requests ORDER BY submitted_at DESC").all().catch(()=>({results:[]}));
        return json(results || []);
      }

      if (path === "/api/cert/review" && method === "POST") {
        const { id, user_id, action } = body;
        if (!id || !action) return err("Missing fields");
        await env.DB.prepare("UPDATE cert_requests SET status=? WHERE id=?").bind(action, id).run();
        if (user_id) {
          await env.DB.prepare("UPDATE users SET cert_status=?, verified=? WHERE id=?")
            .bind(action, action==='approved'?1:0, user_id).run().catch(()=>{});
          const msg = action === 'approved'
            ? "Your professional certificate is verified! Your badge is now active on your profile. ✅"
            : "Your certificate was rejected. Please resubmit with a clearer document.";
          await env.DB.prepare("INSERT INTO notifications (id,user_id,icon,text,time) VALUES (?,?,?,?,?)")
            .bind("notif_cert_"+Date.now(), user_id, action==='approved'?"🏅":"❌", msg, "just now").run();
        }
        return json({ success: true });
      }

      // ── Referral video submissions ──────────────────────────────────────
      // ── Boost ────────────────────────────────────────────────────────────
      // ── Boost Stripe payment intent ──────────────────────────────────────
      if (path === "/api/stripe/boost" && method === "POST") {
        const { amount, user_id, boost_type, target_id } = body;
        if (!amount || !user_id) return err("Missing fields");
        // amount comes in cents already (Math.round(dollars*100))
        const amountCents = typeof amount === 'number' ? Math.round(amount) : parseInt(amount);
        if (!amountCents || amountCents < 100) return err("Minimum boost is $1");
        // Ensure boosts table exists
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS boosts (
          id TEXT PRIMARY KEY, user_id TEXT, type TEXT, target_id TEXT,
          amount REAL, created_at TEXT, expires_at TEXT, active INTEGER DEFAULT 1
        )`).run().catch(()=>{});
        const pi = await stripeReq(env, "/payment_intents", "POST", {
          amount: String(amountCents),
          currency: "usd",
          metadata: { type: "boost", boost_type: boost_type||"profile", target_id: target_id||"", user_id }
        });
        return json({ client_secret: pi.client_secret });
      }

      if (path === "/api/boost" && method === "POST") {
        const { user_id, type, target_id, amount } = body; // type: profile|product
        if (!user_id || !type || !target_id || !amount) return err("Missing fields");
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS boosts (
          id TEXT PRIMARY KEY, user_id TEXT, type TEXT, target_id TEXT,
          amount REAL, created_at TEXT, expires_at TEXT, active INTEGER DEFAULT 1
        )`).run().catch(()=>{});
        const id = "boost_" + Date.now();
        const expires = new Date(Date.now() + 7*24*60*60*1000).toISOString();
        await env.DB.prepare(
          `INSERT INTO boosts (id,user_id,type,target_id,amount,created_at,expires_at,active)
           VALUES (?,?,?,?,?,datetime('now'),?,1)`
        ).bind(id, user_id, type, target_id, amount, expires).run();
        // Credit platform (dabarey24) — boost payment goes to platform
        return json({ id, success: true, expires_at: expires });
      }

      if (path === "/api/boost/active" && method === "GET") {
        const type = url.searchParams.get("type") || "profile";
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS boosts (
          id TEXT PRIMARY KEY, user_id TEXT, type TEXT, target_id TEXT,
          amount REAL, created_at TEXT, expires_at TEXT, active INTEGER DEFAULT 1
        )`).run().catch(()=>{});
        const { results } = await env.DB.prepare(
          `SELECT b.*, u.name as user_name, u.avatar as user_avatar, u.category as user_category
           FROM boosts b LEFT JOIN users u ON b.user_id=u.user_id
           WHERE b.type=? AND b.active=1 AND b.expires_at > datetime('now')
           ORDER BY b.amount DESC`
        ).bind(type).all().catch(()=>({results:[]}));
        return json(results || []);
      }

      // ── Referral stats ───────────────────────────────────────────────────
      if (path === "/api/ref/stats" && method === "GET") {
        const userId = url.searchParams.get("user_id");
        if (!userId) return err("Missing user_id");
        const user = await env.DB.prepare("SELECT name, handle FROM users WHERE id=?").bind(userId).first();
        const handle = (user?.handle || user?.name || '').toLowerCase().replace(/\s+/g, '_');
        // Find all users who were referred by this user
        const { results: referred } = await env.DB.prepare(
          `SELECT id, name, avatar, created_at FROM users WHERE ref_code=?`
        ).bind(userId).all(); // ref_code stores referrer's user ID
        // Get notifications to calculate earned amount
        const { results: notifs } = await env.DB.prepare(
          `SELECT text FROM notifications WHERE user_id=? AND icon='🎉' AND text LIKE 'Referral bonus%'`
        ).bind(userId).all();
        let totalEarned = 0;
        notifs.forEach(n => {
          const m = (n.text||'').match(/\$([0-9.]+)/);
          if (m) totalEarned += parseFloat(m[1]) || 0;
        });
        // Build user list with earned per user (approximate from notifications)
        const users = (referred||[]).map(u => ({ ...u, earned: 0 }));
        return json({ count: users.length, earned: totalEarned, users });
      }

      if (path === "/api/ref/video" && method === "POST") {
        const { user_id, user_name, url } = body;
        if (!user_id || !url) return err("Missing fields");
        const id = "refvid_" + Date.now();
        await env.DB.prepare(
          `INSERT OR REPLACE INTO ref_videos (id, user_id, user_name, url, status, submitted_at)
           VALUES (?, ?, ?, ?, 'pending', datetime('now'))`
        ).bind(id, user_id, user_name||'', url).run();
        return json({ id, success: true });
      }

      if (path === "/api/ref/video" && method === "GET") {
        const userId = url.searchParams.get("user_id");
        if (userId) {
          const row = await env.DB.prepare("SELECT * FROM ref_videos WHERE user_id=? ORDER BY submitted_at DESC LIMIT 1").bind(userId).first();
          return json(row || { status: null });
        }
        // Admin — get all
        const { results } = await env.DB.prepare("SELECT * FROM ref_videos ORDER BY submitted_at DESC").all();
        return json(results || []);
      }

      if (path === "/api/ref/video/review" && method === "POST") {
        const { id, user_id, action } = body;
        if (!id || !action) return err("Missing fields");
        await env.DB.prepare("UPDATE ref_videos SET status=? WHERE id=?").bind(action, id).run();
        if (action === "approved" && user_id) {
          // Set ref_rate to 2% on user
          await env.DB.prepare("UPDATE users SET ref_rate=2 WHERE id=?").bind(user_id).run();
          await env.DB.prepare("INSERT INTO notifications (id,user_id,icon,text,time) VALUES (?,?,?,?,?)")
            .bind("notif_refvid_"+Date.now(), user_id, "🎉",
              "Your promotional video was verified! You now earn 2% referral commission.", "just now").run();
        }
        return json({ success: true });
      }

      // ── Stories ──────────────────────────────────────────────────────────
      if (path === "/api/stories" && method === "GET") {
        const { results } = await env.DB.prepare(`
          SELECT s.*, u.name as creator_name, u.avatar as creator_avatar
          FROM stories s LEFT JOIN users u ON s.creator_id = u.id
          WHERE s.expires_at > datetime('now')
          ORDER BY s.created_at DESC LIMIT 200
        `).all();
        return json(results || []);
      }

      if (path === "/api/stories" && method === "POST") {
        const { creator_id, creator_name, creator_avatar, media_url, media_type, caption } = body;
        if (!creator_id || !media_url) return err("Missing fields");
        const id = "story_" + Date.now();
        await env.DB.prepare(`
          INSERT INTO stories (id, creator_id, creator_name, creator_avatar, media_url, media_type, caption, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now', '+24 hours'))
        `).bind(id, creator_id, creator_name||'', creator_avatar||'', media_url, media_type||'image', caption||'').run();
        return json({ id, success: true });
      }

      // ── Post view count ────────────────────────────────────────────────
      if (path.match(/^\/api\/posts\/[^/]+\/view$/) && method === "POST") {
        const postId = path.split("/")[3];
        try {
          await env.DB.prepare("ALTER TABLE posts ADD COLUMN views INTEGER DEFAULT 0").run();
        } catch(e) {}
        await env.DB.prepare("UPDATE posts SET views=COALESCE(views,0)+1 WHERE id=?").bind(postId).run().catch(()=>{});
        return json({ ok: true });
      }

      if (path === "/api/comments" && method === "GET") {
        const postId = url.searchParams.get("post_id");
        if (!postId) return err("Missing post_id");
        const { results } = await env.DB.prepare(
          `SELECT * FROM comments WHERE post_id=? ORDER BY created_at ASC LIMIT 100`
        ).bind(postId).all();
        return json(results || []);
      }
      if (path === "/api/comments" && method === "POST") {
        const { post_id, user_id, user_name, avatar, text } = body;
        if (!post_id || !text) return err("Missing fields");
        const id = "cmt_" + Date.now();
        await env.DB.prepare(
          `INSERT INTO comments (id, post_id, user_id, user_name, avatar, text) VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(id, post_id, user_id || "", user_name || "", avatar || "", text).run();
        await env.DB.prepare(`UPDATE posts SET comments_count = comments_count + 1 WHERE id=?`).bind(post_id).run();
        return json({ id, success: true });
      }
      return err("Not found", 404);
    } catch (e) {
      console.error(e);
      return err(e.message || "Server error", 500);
    }
  }
};
// ── AUTO PAYOUT CRON ────────────────────────────────────────────────────
// Runs on the 1st of every month at 6am UTC
// Add to wrangler.toml:
//   [triggers]
//   crons = ["0 6 1 * *"]

async function processMonthlyPayouts(env) {
  const now = new Date().toISOString();
  // Get all pending payout requests
  const { results: pending } = await env.DB.prepare(
    `SELECT p.*,
      ps.paypal_email, ps.stripe_account_id, ps.bank_name, ps.bank_iban, ps.bank_swift,
      ps.bank_account, ps.bank_routing, ps.bank_sortcode, ps.bank_bankname, ps.bank_country
     FROM payouts p
     LEFT JOIN payout_settings ps ON p.creator_id = ps.creator_id
     WHERE p.status = 'pending'`
  ).all();

  for (const payout of pending) {
    try {
      if (payout.method === 'paypal' && payout.paypal_email) {
        // ── PayPal Payout (automatic) ─────────────────────────────────
        const token = await getPayPalToken(env);
        const batchId = 'GALAXY_' + payout.id;
        const res = await fetch('https://api-m.paypal.com/v1/payments/payouts', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            sender_batch_header: {
              sender_batch_id: batchId,
              email_subject: 'Your GALAXY payout is here!',
              email_message: `You've received a payout of $${payout.amount.toFixed(2)} from GALAXY.`
            },
            items: [{
              recipient_type: 'EMAIL',
              amount: { value: payout.amount.toFixed(2), currency: 'USD' },
              receiver: payout.paypal_email,
              note: 'GALAXY creator payout',
              sender_item_id: payout.id
            }]
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || JSON.stringify(data));
        const batchStatus = data.batch_header?.payout_batch_id || batchId;

        await env.DB.prepare(
          `UPDATE payouts SET status='paid', reference=?, paid_at=? WHERE id=?`
        ).bind(batchStatus, now, payout.id).run();

        // Zero out balance
        await env.DB.prepare(
          `UPDATE balances SET balance=0, updated_at=? WHERE creator_id=?`
        ).bind(now, payout.creator_id).run();

        // Notify creator
        await env.DB.prepare(
          `INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?,?,?,?,?)`
        ).bind('notif_'+Date.now()+'_'+payout.creator_id, payout.creator_id, '💸',
          `Your payout of $${payout.amount.toFixed(2)} has been sent to your PayPal!`, 'just now').run();

      } else if (payout.method === 'stripe' && payout.bank_iban) {
        // ── Bank transfer — mark as processing, admin sends manually ──
        // (Auto bank transfer requires Stripe Connect onboarding)
        await env.DB.prepare(
          `UPDATE payouts SET status='processing', note=?, paid_at=? WHERE id=?`
        ).bind(
          `Bank: ${payout.bank_name} | IBAN: ${payout.bank_iban} | Bank: ${payout.bank_bankname} | Country: ${payout.bank_country}`,
          now, payout.id
        ).run();

        // Notify creator
        await env.DB.prepare(
          `INSERT INTO notifications (id, user_id, icon, text, time) VALUES (?,?,?,?,?)`
        ).bind('notif_'+Date.now()+'_'+payout.creator_id, payout.creator_id, '🏦',
          `Your bank transfer of $${payout.amount.toFixed(2)} is being processed. Allow 3–5 business days.`, 'just now').run();

      } else {
        await env.DB.prepare(
          `UPDATE payouts SET status='failed', note='Missing payout destination' WHERE id=?`
        ).bind(payout.id).run();
      }
    } catch (e) {
      console.error('Payout failed for', payout.id, e.message);
      await env.DB.prepare(
        `UPDATE payouts SET status='failed', note=? WHERE id=?`
      ).bind(e.message || 'Unknown error', payout.id).run();
    }
  }

  console.log(`Processed ${pending.length} payouts`);
}

export { worker_default as default };
