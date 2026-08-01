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
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: messages,
    }),
  });
  const parsed = await res.json();
  if (parsed.error) throw new Error(parsed.error.message);
  return parsed.content[0].text;
}

async function handleDiagnose(request, env) {
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
    const text = await callClaude(env, [{ role: 'user', content: userMsg }], system, 1300);
    const clean = text.replace(/```json|```/g, '').trim();
    return json(200, JSON.parse(clean));
  } catch (e) {
    return json(500, { error: e.message });
  }
}

async function handleCoach(request, env) {
  const body = await request.json();

  let system = 'You are a sharp, encouraging writing coach who has read the writer\'s story diagnosis. You know their genre, premise, protagonist, conflict, stakes, and theme. You give specific, practical advice tailored to THEIR story \u2014 never generic writing tips.\n\n' +
    'Story context:\n' + JSON.stringify(body.storyContext, null, 2) + '\n\n' +
    'Be direct and warm. Use the writer\'s specific details in every answer. Keep responses focused \u2014 under 300 words unless a longer answer genuinely serves them. If they ask something unrelated to writing or their story, gently steer back.';

  if (body.isWrapup) {
    const n = body.exchangesLeft;
    system += '\n\nIMPORTANT: This consultation session is wrapping up. The writer has ' + n +
      ' exchange' + (n === 1 ? '' : 's') +
      ' remaining with you. Begin guiding the conversation toward conclusion. Help them consolidate what they have learned, identify their single most important next action, and prepare to step away from coaching and into the work.';
  }

  try {
    const text = await callClaude(env, body.messages, system, 750);
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
    const text = await callClaude(env, body.messages, system, 600);
    const clean = text.replace(/```json|```/g, '').trim();
    return json(200, { summary: JSON.parse(clean) });
  } catch (e) {
    return json(500, { error: e.message });
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
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'POST') {
      if (path === '/api/diagnose')        return handleDiagnose(request, env);
      if (path === '/api/coach')           return handleCoach(request, env);
      if (path === '/api/closing-summary') return handleClosingSummary(request, env);
      if (path === '/api/request-code')    return handleRequestCode(request, env);
      if (path === '/api/verify-code')     return handleVerifyCode(request, env);
    }

    return new Response('Not found', { status: 404, headers: CORS });
  },
};
