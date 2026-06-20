const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'support@tinhousepress.com';
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n').replace(/^["']|["']$/g, '');

// ── helpers ───────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), ...headers },
    }, res => {
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── Google Sheets JWT auth ────────────────────────────────────────────────────

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function getGoogleAccessToken() {
  if (!GOOGLE_PRIVATE_KEY || !GOOGLE_SERVICE_ACCOUNT_EMAIL) {
    throw new Error(`Missing credentials. Key length: ${GOOGLE_PRIVATE_KEY.length}, Email: ${GOOGLE_SERVICE_ACCOUNT_EMAIL || 'MISSING'}`);
  }
  if (!GOOGLE_PRIVATE_KEY.includes('BEGIN')) {
    throw new Error(`Key malformed. First 80 chars: ${GOOGLE_PRIVATE_KEY.substring(0, 80)}`);
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claim = base64url(Buffer.from(JSON.stringify({
    iss: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })));
  const toSign = `${header}.${claim}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(toSign);
  const sig = base64url(sign.sign(GOOGLE_PRIVATE_KEY));
  const jwt = `${toSign}.${sig}`;

  const res = await httpsPost('oauth2.googleapis.com', '/token', {},
    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  );
  const data = JSON.parse(res.body);
  if (!data.access_token) {
    console.error('Google token response:', res.body);
    throw new Error('Failed to get Google access token: ' + (data.error_description || data.error || res.body.substring(0, 200)));
  }
  return data.access_token;
}

async function appendToSheet(token, values) {
  const range = 'Sheet1!A:E';
  const url = `/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW`;
  const res = await httpsPost('sheets.googleapis.com', url,
    { Authorization: `Bearer ${token}` },
    { values: [values] }
  );
  return res;
}

async function getSheetValues(token) {
  const range = 'Sheet1!A:E';
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'sheets.googleapis.com',
      path: `/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${encodeURIComponent(range)}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => resolve(JSON.parse(raw)));
    });
    req.on('error', reject);
    req.end();
  });
}

async function updateSheetCell(token, row, col, value) {
  const cell = `Sheet1!${col}${row}`;
  const url = `/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${encodeURIComponent(cell)}?valueInputOption=RAW`;
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ values: [[value]] });
    const options = {
      hostname: 'sheets.googleapis.com',
      path: url,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${token}`,
      },
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => resolve(raw));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Email via Resend ──────────────────────────────────────────────────────────

async function sendUnlockEmail(email, code) {
  const res = await httpsPost('api.resend.com', '/emails',
    { Authorization: `Bearer ${RESEND_API_KEY}` },
    {
      from: `Tin House Press <${FROM_EMAIL}>`,
      to: [email],
      subject: 'Your Writing Coach Unlock Code',
      html: `
        <div style="font-family: 'Georgia', serif; max-width: 520px; margin: 0 auto; padding: 40px 24px; color: #1a1a1a;">
          <h2 style="font-size: 22px; margin-bottom: 8px;">Your Writing Coach is ready.</h2>
          <p style="color: #555; margin-bottom: 32px;">Thank you for your purchase. Use the code below to unlock your personal Writing Coach session.</p>
          <div style="background: #f5f5f5; border-left: 4px solid #c0392b; padding: 24px; text-align: center; margin-bottom: 32px;">
            <div style="font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: #888; margin-bottom: 8px;">Your unlock code</div>
            <div style="font-size: 40px; font-weight: 700; letter-spacing: 0.15em; color: #c0392b; font-family: monospace;">${code}</div>
          </div>
          <p style="font-size: 13px; color: #888;">Enter this code in the Writing Coach unlock field. This code is single-use and tied to your purchase.</p>
          <p style="font-size: 13px; color: #888; margin-top: 24px;">Questions? Reply to this email or contact <a href="mailto:support@tinhousepress.com" style="color: #c0392b;">support@tinhousepress.com</a></p>
          <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 32px 0;" />
          <p style="font-size: 11px; color: #aaa;">Tin House Press · tinhousepress.com</p>
        </div>
      `,
    }
  );
  return res;
}

// ── Claude ────────────────────────────────────────────────────────────────────

async function callClaude(messages, systemPrompt, maxTokens) {
  const body = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: maxTokens,
    system: systemPrompt,
    messages,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
    }, res => {
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) return reject(new Error(parsed.error.message));
          resolve(parsed.content[0].text);
        } catch (e) { reject(new Error('Failed to parse Claude response')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── route handlers ────────────────────────────────────────────────────────────

async function handleDiagnose(req, res) {
  const { genre, stage, premise, protagonist, conflict, stakes, theme } = await readBody(req);

  const system = `You are a senior story analyst and developmental editor with 20+ years of experience evaluating manuscripts for major publishers. You give honest, precise, actionable diagnoses — not flattery. You understand commercial viability, genre conventions, and literary craft equally well.

Respond ONLY with a valid JSON object. No markdown, no code fences, no preamble. The JSON must match this exact shape:

{
  "score": <integer 1–100>,
  "verdict": "<one punchy sentence — the single most important truth about this story right now>",
  "whatsWorking": ["<strength 1>", "<strength 2>", "<strength 3>"],
  "critical": [
    { "issue": "<problem title>", "detail": "<explanation>", "fix": "<concrete fix>" },
    { "issue": "<problem title>", "detail": "<explanation>", "fix": "<concrete fix>" },
    { "issue": "<problem title>", "detail": "<explanation>", "fix": "<concrete fix>" }
  ],
  "greenLight": "<2–3 sentences: should they write this book? Why or why not?>",
  "comparables": ["<Title by Author (year)>", "<Title by Author (year)>", "<Title by Author (year)>"],
  "nextSteps": ["<action 1>", "<action 2>", "<action 3>"]
}

Score guide: 80–100 = strong commercial/literary potential, move forward confidently; 60–79 = solid foundation, specific work needed; 40–59 = interesting premise but structural problems; below 40 = significant rethinking required.`;

  const userMsg = `Please diagnose this story:\n\nGenre: ${genre}\nWriting Stage: ${stage}\nPremise: ${premise}\nProtagonist: ${protagonist}\nCentral Conflict: ${conflict}\nStakes: ${stakes}\nTheme: ${theme}`;

  try {
    const text = await callClaude([{ role: 'user', content: userMsg }], system, 1800);
    const clean = text.replace(/```json|```/g, '').trim();
    const data = JSON.parse(clean);
    sendJSON(res, 200, data);
  } catch (e) {
    console.error('Diagnose error:', e.message);
    sendJSON(res, 500, { error: e.message });
  }
}

async function handleCoach(req, res) {
  const { messages, storyContext } = await readBody(req);

  const system = `You are a sharp, encouraging writing coach who has read the writer's story diagnosis. You know their genre, premise, protagonist, conflict, stakes, and theme. You give specific, practical advice tailored to THEIR story — never generic writing tips.

Story context:
${JSON.stringify(storyContext, null, 2)}

Be direct and warm. Use the writer's specific details in every answer. Keep responses focused — under 300 words unless a longer answer genuinely serves them. If they ask something unrelated to writing or their story, gently steer back.`;

  try {
    const text = await callClaude(messages, system, 1000);
    sendJSON(res, 200, { reply: text });
  } catch (e) {
    console.error('Coach error:', e.message);
    sendJSON(res, 500, { error: e.message });
  }
}

// POST /api/request-code  { email }
async function handleRequestCode(req, res) {
  try {
    const { email } = await readBody(req);
    if (!email || !email.includes('@')) return sendJSON(res, 400, { error: 'Valid email required.' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const token = await getGoogleAccessToken();

    // Log: email, code, timestamp, used, source
    await appendToSheet(token, [email.toLowerCase(), code, new Date().toISOString(), 'false', 'story-diagnosis']);

    await sendUnlockEmail(email, code);
    sendJSON(res, 200, { ok: true });
  } catch (e) {
    console.error('Request code error:', e.message);
    sendJSON(res, 500, { error: 'Failed to send code. Please try again.' });
  }
}

// POST /api/verify-code  { email, code }
async function handleVerifyCode(req, res) {
  try {
    const { email, code } = await readBody(req);
    if (!email || !code) return sendJSON(res, 400, { error: 'Email and code required.' });

    const token = await getGoogleAccessToken();
    const data = await getSheetValues(token);
    const rows = data.values || [];

    // Find matching row (email + code + not used)
    let matchRow = -1;
    for (let i = 1; i < rows.length; i++) {
      const [rowEmail, rowCode, , rowUsed] = rows[i];
      if (
        rowEmail && rowEmail.toLowerCase() === email.toLowerCase() &&
        rowCode === code &&
        rowUsed !== 'true'
      ) {
        matchRow = i + 1; // Sheets rows are 1-indexed, +1 for header
        break;
      }
    }

    if (matchRow === -1) return sendJSON(res, 400, { error: 'Invalid or already used code.' });

    // Mark as used
    await updateSheetCell(token, matchRow, 'D', 'true');
    sendJSON(res, 200, { ok: true });
  } catch (e) {
    console.error('Verify code error:', e.message);
    sendJSON(res, 500, { error: 'Verification failed. Please try again.' });
  }
}

// ── server ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];

  if (req.method === 'POST' && url === '/api/diagnose')      return handleDiagnose(req, res);
  if (req.method === 'POST' && url === '/api/coach')         return handleCoach(req, res);
  if (req.method === 'POST' && url === '/api/request-code')  return handleRequestCode(req, res);
  if (req.method === 'POST' && url === '/api/verify-code')   return handleVerifyCode(req, res);

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    return sendFile(res, path.join(__dirname, 'index.html'), 'text/html; charset=utf-8');
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`Story Diagnosis Tool running on port ${PORT}`));
