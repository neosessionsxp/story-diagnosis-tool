const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';

function callClaude(messages, systemPrompt, maxTokens) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': ANTHROPIC_API_KEY,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // Serve index.html
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, (err, content) => {
      if (err) { res.writeHead(500); return res.end('Server error'); }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(content);
    });
    return;
  }

  // POST /api/diagnose
  if (req.method === 'POST' && req.url === '/api/diagnose') {
    try {
      const { genre, stage, premise, protagonist, conflict, stakes, theme } = await readBody(req);

      if (!genre || !stage || !premise || !protagonist || !conflict || !stakes || !theme) {
        return json(res, 400, { error: 'All fields are required.' });
      }

      const systemPrompt = `You are an expert literary agent and developmental editor.
Analyze the story concept provided and return ONLY a valid JSON object with this exact structure:
{
  "viability_score": <integer 1-100>,
  "score_label": "<one punchy phrase describing the score>",
  "verdict": "<2-3 sentence honest assessment of the concept's potential>",
  "working": ["<strength 1>", "<strength 2>", "<strength 3>"],
  "missing": [
    {"issue": "<gap 1>", "fix": "<concrete fix 1>"},
    {"issue": "<gap 2>", "fix": "<concrete fix 2>"},
    {"issue": "<gap 3>", "fix": "<concrete fix 3>"}
  ],
  "green_light": "<exactly one of: Write It Now | Develop Further First | Major Rethink Needed>",
  "comparable_titles": ["<title 1>", "<title 2>", "<title 3>"],
  "next_steps": ["<step 1>", "<step 2>", "<step 3>"],
  "upgrade_prompt": "<one sentence inviting them to write with a coach>"
}
Return ONLY the JSON, no markdown fences, no preamble.`;

      const userMessage = `Genre: ${genre}\nWriting stage: ${stage}\nPremise: ${premise}\nProtagonist: ${protagonist}\nCentral conflict: ${conflict}\nStakes: ${stakes}\nTheme: ${theme}`;

      const raw = await callClaude([{ role: 'user', content: userMessage }], systemPrompt, 1800);
      const cleaned = raw.replace(/```json|```/g, '').trim();
      const result = JSON.parse(cleaned);
      return json(res, 200, result);
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // POST /api/coach
  if (req.method === 'POST' && req.url === '/api/coach') {
    try {
      const { messages, storyData } = await readBody(req);

      if (!messages || !storyData) {
        return json(res, 400, { error: 'Missing messages or storyData.' });
      }

      const storyContext = `Story details:
- Genre: ${storyData.genre}
- Stage: ${storyData.stage}
- Premise: ${storyData.premise}
- Protagonist: ${storyData.protagonist}
- Conflict: ${storyData.conflict}
- Stakes: ${storyData.stakes}
- Theme: ${storyData.theme}`;

      const systemPrompt = `You are an expert writing coach helping a fiction author develop their story.
Always use the specific story details provided — never be generic.
${storyContext}
Write with the sensibility of a literary editor: precise, encouraging, craft-focused.`;

      const reply = await callClaude(messages, systemPrompt, 1000);
      return json(res, 200, { reply });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Story Diagnosis server running on port ${PORT}`);
});
