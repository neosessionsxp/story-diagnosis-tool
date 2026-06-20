const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ── helpers ──────────────────────────────────────────────────────────────────

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
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

async function callClaude(messages, systemPrompt, maxTokens) {
  const body = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: maxTokens,
    system: systemPrompt,
    messages,
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
    };

    const req = require('https').request(options, res => {
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) return reject(new Error(parsed.error.message));
          resolve(parsed.content[0].text);
        } catch (e) {
          reject(new Error('Failed to parse Claude response'));
        }
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

  const userMsg = `Please diagnose this story:

Genre: ${genre}
Writing Stage: ${stage}
Premise: ${premise}
Protagonist: ${protagonist}
Central Conflict: ${conflict}
Stakes: ${stakes}
Theme: ${theme}`;

  try {
    const text = await callClaude([{ role: 'user', content: userMsg }], system, 1800);
    // Strip any accidental markdown fences
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

// ── server ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];

  if (req.method === 'POST' && url === '/api/diagnose') return handleDiagnose(req, res);
  if (req.method === 'POST' && url === '/api/coach')    return handleCoach(req, res);

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    return sendFile(res, path.join(__dirname, 'index.html'), 'text/html; charset=utf-8');
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`Story Diagnosis Tool running on port ${PORT}`));
