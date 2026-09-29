const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function b64urlFromString(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64urlFromBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function pemToPkcs8(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function getGoogleAccessToken(env) {
  const email = env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = (env.GOOGLE_PRIVATE_KEY || '')
    .replace(/\\n/g, '\n')
    .replace(/^["']|["']$/g, '');

  if (!rawKey || !email) {
    throw new Error('Missing credentials. Key length: ' + rawKey.length + ', Email: ' + (email || 'MISSING'));
  }
  if (!rawKey.includes('BEGIN')) {
    throw new Error('Key malformed. First 80 chars: ' + rawKey.substring(0, 80));
  }

  const now = Math.floor(Date.now() / 1000);
  const header = b64urlFromString(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64urlFromString(JSON.stringify({
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  }));
  const toSign = header + '.' + claim;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(rawKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(toSign)
  );
  const jwt = toSign + '.' + b64urlFromBuffer(sigBuf);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt,
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Failed to get Google access token: ' + (data.error_description || data.error || 'unknown'));
  }
  return data.access_token;
}

const SHEET_RANGE = 'Sheet1!A:E';

async function appendToSheet(env, token, values) {
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + env.GOOGLE_SHEET_ID +
    '/values/' + encodeURIComponent(SHEET_RANGE) + ':append?valueInputOption=RAW';
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ values: [values] }),
  });
}

async function getSheetValues(env, token) {
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + env.GOOGLE_SHEET_ID +
    '/values/' + encodeURIComponent(SHEET_RANGE);
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  return res.json();
}

async function updateSheetCell(env, token, row, col, value) {
  const cell = 'Sheet1!' + col + row;
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + env.GOOGLE_SHEET_ID +
    '/values/' + encodeURIComponent(cell) + '?valueInputOption=RAW';
  return fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ values: [[value]] }),
  });
}

async function sendUnlockEmail(env, email, code) {
  const from = env.FROM_EMAIL || 'support@tinhousepress.com';
  const html =
    '<div style="font-family: Georgia, serif; max-width: 520px; margin: 0 auto; padding: 40px 24px; color: #1a1a1a;">' +
    '<h2 style="font-size: 22px; margin-bottom: 8px;">Your Writing Coach is ready.</h2>' +
    '<p style="color: #555; margin-bottom: 32px;">Thank you for your purchase. Use the code below to unlock your personal Writing Coach session.</p>' +
    '<div style="background: #f5f5f5; border-left: 4px solid #c0392b; padding: 24px; text-align: center; margin-bottom: 32px;">' +
    '<div style="font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: #888; margin-bottom: 8px;">Your unlock code</div>' +
    '<div style="font-size: 40px; font-weight: 700; letter-spacing: 0.15em; color: #c0392b; font-family: monospace;">' + code + '</div>' +
    '</div>' +
    '<p style="font-size: 13px; color: #888;">Enter this code in the Writing Coach unlock field. This code is single-use and tied to your purchase.</p>' +
    '<p style="font-size: 13px; color: #888; margin-top: 24px;">Questions? Reply to this email or contact <a href="mailto:support@tinhousepress.com" style="color: #c0392b;">support@tinhousepress.com</a></p>' +
    '<hr style="border: none; border-top: 1px solid #e0e0e0; margin: 32px 0;" />' +
    '<p style="font-size: 11px; color: #aaa;">Tin House Press &middot; tinhousepress.com</p>' +
    '</div>';

  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.RESEND_API_KEY },
    body: JSON.stringify({
      from: 'Tin House Press <' + from + '>',
      to: [email],
      subject: 'Your Writing Coach Unlock Code',
      html: html,
    }),
  });
}

async function callClaude(env, messages, systemPrompt, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5-5',
      max_tokens: maxTokens,
      thinking: { type: 'between_tools' }, // Sonnet 5.5 thinks by default; off keeps output within max_tokens
      system: systemPrompt,
      messages: messages,
    }),
  });
  const parsed = await res.json();
  if (parsed.error) throw new Error(parsed.error.message);
  const block = (parsed.content || []).find(b => b.type === 'text');
  return block ? block.text : '';
}

// ── Owner notification on free-tier use ──────────────────────────────────────
// Sends the operator a copy of what a free-trial visitor submitted and the
// diagnosis they were given. Off unless OWNER_EMAIL is set, so deploying this
// changes nothing until that secret exists. Every failure is swallowed — this
// is the operator's convenience and must never surface on the writer's screen.
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function notifyOwnerOfTrial(env, { fields, ip, diagnosis }) {
  const to = env.OWNER_EMAIL;
  if (!to || !env.RESEND_API_KEY) return;

  const rows = [
    ['Genre', fields.genre], ['Stage', fields.stage], ['Premise', fields.premise],
    ['Protagonist', fields.protagonist], ['Conflict', fields.conflict],
    ['Stakes', fields.stakes], ['Theme', fields.theme], ['Connection', ip],
  ].map(function (r) {
    return '<tr><td style="vertical-align:top;"><b>' + esc(r[0]) + '</b></td><td>' + esc(r[1] || '\u2014') + '</td></tr>';
  }).join('');

  const html =
    '<div style="font-family:-apple-system,Segoe UI,Helvetica,sans-serif;font-size:14px;color:#1a1a1a;">' +
    '<h2 style="margin:0 0 4px 0;">Free diagnosis used \u2014 Story Diagnosis Tool</h2>' +
    '<p style="color:#666;margin:0 0 20px 0;">' + esc(new Date().toUTCString()) + '</p>' +
    '<table cellpadding="4" style="border-collapse:collapse;margin-bottom:24px;max-width:640px;">' + rows + '</table>' +
    '<h3 style="margin:0 0 8px 0;">Diagnosis produced</h3>' +
    '<pre style="white-space:pre-wrap;background:#f6f6f6;padding:12px;border-radius:4px;font-size:12px;">' +
      esc(JSON.stringify(diagnosis, null, 2)) + '</pre></div>';

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.RESEND_API_KEY },
      body: JSON.stringify({
        from: 'Tin House Press <' + (env.FROM_EMAIL || 'support@tinhousepress.com') + '>',
        to: [to],
        subject: 'Free diagnosis used \u2014 ' + (fields.genre || 'unknown genre'),
        html: html,
      }),
    });
    // Resend reports refusals (unverified sender, bad key, oversized body) as a
    // non-2xx response, not a thrown error. Without this the notification could
    // fail silently forever and look identical to working.
    if (!res.ok) {
      console.error('owner notification rejected by Resend:', res.status, await res.text());
    }
  } catch (err) {
    console.error('owner notification failed:', err.message);
  }
}

/**
 * Per-IP rate limit for the endpoints that spend Anthropic credits.
 *
 * These endpoints take no sign-in by design — the free tier deliberately never
 * asks who a writer is — which also means nothing stopped a script from calling
 * them in a loop and draining the API balance. Cloudflare's native rate-limit
 * binding closes that without a KV counter, so it does not touch the account's
 * shared 1,000 KV writes/day.
 *
 * Fails OPEN: if the binding is missing (a local `wrangler dev` without the
 * unsafe bindings, or a partial deploy) a real writer still gets her diagnosis.
 * A rate limiter that breaks the tool is worse than one that misses an abuser.
 */
async function rateLimited(limiter, request) {
  if (!limiter) return null;
  try {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success } = await limiter.limit({ key: ip });
    if (success) return null;
  } catch (err) {
    console.error('rate limiter failed open:', err.message);
    return null;
  }
  return json(429, {
    error: 'That is a lot of requests in a short time. Please wait a minute and try again.',
  });
}

async function handleDiagnose(request, env, ctx) {
  const blocked = await rateLimited(env.DIAGNOSE_LIMIT, request);
  if (blocked) return blocked;

  const body = await request.json();

  const system = 'You are a senior story analyst and developmental editor with 20+ years of experience evaluating manuscripts for major publishers. You give honest, precise, actionable diagnoses \u2014 not flattery. You understand commercial viability, genre conventions, and literary craft equally well.\n\n' +
'Respond ONLY with a valid JSON object. No markdown, no code fences, no preamble. The JSON must match this exact shape:\n\n' +
'{\n' +
'  "score": <integer 1-100>,\n' +
'  "verdict": "<one punchy sentence \u2014 the single most important truth about this story right now>",\n' +
'  "whatsWorking": ["<strength 1>", "<strength 2>", "<strength 3>"],\n' +
'  "critical": [\n' +
'    { "issue": "<problem title>", "detail": "<explanation>", "fix": "<concrete fix>" },\n' +
'    { "issue": "<problem title>", "detail": "<explanation>", "fix": "<concrete fix>" },\n' +
'    { "issue": "<problem title>", "detail": "<explanation>", "fix": "<concrete fix>" }\n' +
'  ],\n' +
'  "greenLight": "<2-3 sentences: should they write this book? Why or why not?>",\n' +
'  "comparables": ["<Title by Author (year)>", "<Title by Author (year)>", "<Title by Author (year)>"],\n' +
'  "nextSteps": ["<action 1>", "<action 2>", "<action 3>"]\n' +
'}\n\n' +
'Score guide: 80-100 = strong commercial/literary potential, move forward confidently; 60-79 = solid foundation, specific work needed; 40-59 = interesting premise but structural problems; below 40 = significant rethinking required.';

  const userMsg = 'Please diagnose this story:\n\nGenre: ' + body.genre +
    '\nWriting Stage: ' + body.stage +
    '\nPremise: ' + body.premise +
    '\nProtagonist: ' + body.protagonist +
    '\nCentral Conflict: ' + body.conflict +
    '\nStakes: ' + body.stakes +
    '\nTheme: ' + body.theme;

  try {
    // 1800, not 1300. The 1300 value came from the old Railway server.js and NOTES
    // treated it as the "correct" pre-migration number, but it truncates this schema
    // mid-string and JSON.parse then throws "Unterminated string in JSON" at the user.
    // The diagnose payload (verdict + 3 strengths + 3 critical issue/detail/fix triples
    // + greenLight + 3 comparables + 3 nextSteps) needs the headroom. Do not lower
    // without measuring real completions first. 2400 since the Sonnet 5.5 switch
    // (2026-09-30): its tokenizer counts the same text as up to ~35% more tokens.
    const text = await callClaude(env, [{ role: 'user', content: userMsg }], system, 2400);
    const clean = text.replace(/```json|```/g, '').trim();
    const diagnosis = JSON.parse(clean);

    // Fire-and-forget: the writer's result is already complete, and a Resend
    // hiccup must not turn a successful diagnosis into an error on her screen.
    if (ctx) {
      ctx.waitUntil(notifyOwnerOfTrial(env, {
        fields: body,
        ip: request.headers.get('CF-Connecting-IP') || 'unknown',
        diagnosis: diagnosis,
      }));
    }

    return json(200, diagnosis);
  } catch (e) {
    return json(500, { error: e.message });
  }
}

/**
 * Prepare the coach conversation for prompt caching.
 *
 * A consultation runs up to 20 exchanges and the whole history is resent on
 * every one of them, so the history — not the system prompt — is what costs
 * money here. Marking the end of the previous turn as a cache breakpoint lets
 * each new exchange re-read everything before it at roughly a tenth of the
 * normal input price. Nothing else about the request changes.
 *
 * `extraInstruction`, when given, is appended to the final user message so it
 * sits after the breakpoint and leaves the cached prefix intact.
 *
 * The cache entry lives 5 minutes by default. A writer who steps away mid-
 * consultation simply pays full price on their next message — a miss is only
 * ever a lost discount, never an error.
 */
function cacheableCoachMessages(rawMessages, extraInstruction) {
  const messages = (rawMessages || []).map((m) => ({
    role: m.role,
    content: typeof m.content === 'string'
      ? [{ type: 'text', text: m.content }]
      : m.content.slice(),
  }));
  if (messages.length === 0) return messages;

  if (extraInstruction) {
    const last = messages[messages.length - 1];
    last.content = last.content.concat([{ type: 'text', text: extraInstruction }]);
  }

  // Breakpoint on the turn before the new one: everything up to that point is
  // byte-identical to the previous request, which is exactly what can be reused.
  const prior = messages[messages.length - 2];
  if (prior && prior.content.length > 0) {
    const i = prior.content.length - 1;
    prior.content[i] = Object.assign({}, prior.content[i], {
      cache_control: { type: 'ephemeral' },
    });
  }
  return messages;
}

async function handleCoach(request, env) {
  const body = await request.json();

  const system = 'You are a sharp, encouraging writing coach who has read the writer\'s story diagnosis. You know their genre, premise, protagonist, conflict, stakes, and theme. You give specific, practical advice tailored to THEIR story \u2014 never generic writing tips.\n\n' +
    'Story context:\n' + JSON.stringify(body.storyContext, null, 2) + '\n\n' +
    'Be direct and warm. Use the writer\'s specific details in every answer. Keep responses focused \u2014 under 300 words unless a longer answer genuinely serves them. If they ask something unrelated to writing or their story, gently steer back.';

  // The wrap-up instruction deliberately does NOT go on `system`. Prompt caching
  // matches on an exact prefix and `system` sits at the front of it, so editing
  // it on the final exchanges would discard the cached conversation at the point
  // the conversation is longest and re-reading it costs the most. It rides on the
  // last user message instead, which lands after the cache breakpoint.
  let wrapup = null;
  if (body.isWrapup) {
    const n = body.exchangesLeft;
    wrapup = 'IMPORTANT: This consultation session is wrapping up. The writer has ' + n +
      ' exchange' + (n === 1 ? '' : 's') +
      ' remaining with you. Begin guiding the conversation toward conclusion. Help them consolidate what they have learned, identify their single most important next action, and prepare to step away from coaching and into the work.';
  }

  try {
    // 1000, not 750. Coach returns prose so truncation degrades quietly rather than
    // throwing, which makes it the easy one to under-size without noticing.
    const text = await callClaude(env, cacheableCoachMessages(body.messages, wrapup), system, 1000);
    return json(200, { reply: text });
  } catch (e) {
    return json(500, { error: e.message });
  }
}

async function handleClosingSummary(request, env) {
  const body = await request.json();

  const system = 'You are a senior story analyst writing a closing summary for a writer who has just completed a 20-exchange coaching consultation about their story. You have read the entire conversation.\n\n' +
    'Story context:\n' + JSON.stringify(body.storyContext, null, 2) + '\n\n' +
    'Synthesize the consultation into a concrete action plan. Respond ONLY with a valid JSON object \u2014 no markdown, no code fences, no preamble:\n\n' +
    '{\n' +
    '  "actionPlan": "<2-3 sentences summarizing the writer\'s clear path forward, based on what was discussed>",\n' +
    '  "topPriorities": ["<priority 1 \u2014 concrete and specific>", "<priority 2>", "<priority 3>"],\n' +
    '  "nextMilestone": "<one specific, achievable milestone they should aim for next>"\n' +
    '}\n\n' +
    'Be specific to THEIR story and the actual conversation. No generic writing advice.';

  try {
    // 800, not 600 — same reasoning as handleDiagnose. This endpoint also JSON.parses
    // its result, so a truncated completion surfaces as a parse error, not a short answer.
    const text = await callClaude(env, body.messages, system, 800);
    const clean = text.replace(/```json|```/g, '').trim();
    return json(200, { summary: JSON.parse(clean) });
  } catch (e) {
    return json(500, { error: e.message });
  }
}

// Tell the owner that somebody said they paid.
//
// This endpoint issues an unlock code to anyone who types an email address —
// nothing checks PayPal, and the paywall copy ("After paying, enter your PayPal
// email to receive your unlock code") is the entire security model. Until
// 2026-08-31 that was also invisible: an honest $19 buyer and a stranger
// helping themselves produced exactly the same silence.
//
// This does not gate anything. It puts every claim in front of a human, so the
// $19 can be checked against the PayPal transaction list while the claim is
// still fresh.
async function notifyOwnerOfUnlockClaim(env, email, ip) {
  const to = env.OWNER_EMAIL;
  if (!to || !env.RESEND_API_KEY) return;

  const html =
    '<div style="font-family:-apple-system,Segoe UI,Helvetica,sans-serif;font-size:14px;color:#1a1a1a;">' +
    '<h2 style="margin:0 0 4px 0;">Unlock code issued — Story Diagnosis Tool</h2>' +
    '<p style="color:#666;margin:0 0 20px 0;">' + esc(new Date().toUTCString()) + '</p>' +
    '<p style="background:#fdecea;padding:12px;border-radius:4px;margin:0 0 20px 0;color:#8b2016;">' +
    '<b>Unverified.</b> This person clicked &ldquo;I&rsquo;ve paid&rdquo; and a code was emailed to them. ' +
    'Nothing here confirms a payment. Search PayPal for this address to check the $19 arrived.</p>' +
    '<table cellpadding="4" style="border-collapse:collapse;">' +
    '<tr><td><b>Email</b></td><td>' + esc(email) + '</td></tr>' +
    '<tr><td><b>Amount expected</b></td><td>$19</td></tr>' +
    '<tr><td><b>Connection</b></td><td>' + esc(ip || '—') + '</td></tr>' +
    '</table></div>';

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.RESEND_API_KEY },
      body: JSON.stringify({
        from: 'Tin House Press <' + (env.FROM_EMAIL || 'support@tinhousepress.com') + '>',
        to: [to],
        subject: 'Unlock code issued — UNVERIFIED — ' + email,
        html: html,
      }),
    });
    if (!res.ok) console.error('unlock-claim notification rejected:', res.status, await res.text());
  } catch (e) {
    console.error('unlock-claim notification failed:', e.message);
  }
}

async function handleRequestCode(request, env) {
  try {
    const body = await request.json();
    const email = body.email;
    if (!email || !email.includes('@')) return json(400, { error: 'Valid email required.' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const token = await getGoogleAccessToken(env);

    await appendToSheet(env, token, [
      email.toLowerCase(), code, new Date().toISOString(), 'false', 'story-diagnosis',
    ]);
    await sendUnlockEmail(env, email, code);

    // Never lets an alerting failure turn a successful unlock into an error on
    // the buyer's screen — she has her code either way.
    await notifyOwnerOfUnlockClaim(env, email, request.headers.get('CF-Connecting-IP') || '');

    return json(200, { ok: true });
  } catch (e) {
    console.error('Request code error:', e.message);
    return json(500, { error: 'Failed to send code. Please try again.' });
  }
}

async function handleVerifyCode(request, env) {
  try {
    const body = await request.json();
    const email = body.email;
    const code = body.code;
    if (!email || !code) return json(400, { error: 'Email and code required.' });

    if (env.MASTER_CODE && code === env.MASTER_CODE) return json(200, { ok: true });

    const token = await getGoogleAccessToken(env);
    const data = await getSheetValues(env, token);
    const rows = data.values || [];

    let matchRow = -1;
    for (let i = 0; i < rows.length; i++) {
      const rowEmail = rows[i][0];
      const rowCode = rows[i][1];
      const rowUsed = rows[i][3];
      if (
        rowEmail && rowEmail.toLowerCase() === email.toLowerCase() &&
        rowCode === code &&
        rowUsed !== 'true'
      ) {
        matchRow = i + 1;
        break;
      }
    }

    if (matchRow === -1) return json(400, { error: 'Invalid or already used code.' });

    await updateSheetCell(env, token, matchRow, 'D', 'true');
    return json(200, { ok: true });
  } catch (e) {
    console.error('Verify code error:', e.message);
    return json(500, { error: 'Verification failed. Please try again.' });
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'POST') {
      if (path === '/api/diagnose')        return handleDiagnose(request, env, ctx);
      if (path === '/api/coach') {
        const blocked = await rateLimited(env.COACH_LIMIT, request);
        return blocked || handleCoach(request, env);
      }
      if (path === '/api/closing-summary') {
        const blocked = await rateLimited(env.COACH_LIMIT, request);
        return blocked || handleClosingSummary(request, env);
      }
      if (path === '/api/request-code')    return handleRequestCode(request, env);
      if (path === '/api/verify-code')     return handleVerifyCode(request, env);
    }

    return new Response('Not found', { status: 404, headers: CORS });
  },
};
