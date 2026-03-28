// netlify/functions/claude-fix.js
// Receives a fix instruction from Make/Telegram
// → fetches index.html from GitHub
// → asks Claude to apply the fix
// → commits and pushes back to GitHub
// → Netlify auto-deploys

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const CLAUDE_KEY    = process.env.ANTHROPIC_API_KEY;
const REPO          = 'oldl/sunspots';
const FILE_PATH     = 'sunspots/index.html';
const BRANCH        = 'main';
const GH_API        = 'https://api.github.com';

exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let instruction;
  try {
    const body = JSON.parse(event.body || '{}');
    instruction = body.instruction || body.text || '';
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  if (!instruction) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing instruction' }) };
  }

  if (!CLAUDE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Missing ANTHROPIC_API_KEY env var' }) };
  }

  try {
    // ── 1. Fetch current file from GitHub ──────────────────────────────
    const ghRes = await fetch(`${GH_API}/repos/${REPO}/contents/${FILE_PATH}?ref=${BRANCH}`, {
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!ghRes.ok) {
      const err = await ghRes.json();
      throw new Error(`GitHub fetch error: ${err.message}`);
    }

    const ghData = await ghRes.json();
    const currentContent = Buffer.from(ghData.content, 'base64').toString('utf-8');
    const fileSha = ghData.sha;

    // ── 2. Ask Claude to apply the fix ─────────────────────────────────
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 8192,
        messages: [{
          role: 'user',
          content: `Tu es l'assistant du projet SunSpots (mini.appvelvet.com/sunspots).
Voici le fichier index.html actuel :

\`\`\`html
${currentContent}
\`\`\`

Instruction : ${instruction}

Réponds UNIQUEMENT avec le fichier HTML complet modifié, sans aucun commentaire avant ou après. 
Ne mets pas de backticks ni de markdown autour. Juste le HTML brut.`,
        }],
      }),
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.json();
      throw new Error(`Claude API error: ${err.error?.message}`);
    }

    const claudeData = await claudeRes.json();
    const newContent = claudeData.content?.[0]?.text || '';

    if (!newContent || !newContent.includes('<!DOCTYPE html>')) {
      throw new Error('Claude did not return valid HTML');
    }

    // ── 3. Push back to GitHub ─────────────────────────────────────────
    const commitMessage = `fix(claude): ${instruction.replace('fix:', '').trim().substring(0, 72)}`;
    const encodedContent = Buffer.from(newContent).toString('base64');

    const pushRes = await fetch(`${GH_API}/repos/${REPO}/contents/${FILE_PATH}`, {
      method: 'PUT',
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: commitMessage,
        content: encodedContent,
        sha: fileSha,
        branch: BRANCH,
      }),
    });

    if (!pushRes.ok) {
      const err = await pushRes.json();
      throw new Error(`GitHub push error: ${err.message}`);
    }

    const pushData = await pushRes.json();
    const commitSha = pushData.commit?.sha?.substring(0, 7);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        message: `✅ Fix appliqué et pushé (${commitSha}) — Netlify redéploie dans ~10s`,
        commit: commitSha,
      }),
    };

  } catch (err) {
    console.error('claude-fix error:', err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ success: false, error: err.message }),
    };
  }
};
