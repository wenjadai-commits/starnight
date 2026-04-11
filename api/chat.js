const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const RATE_LIMIT = 30;
const RATE_WINDOW = 60000;

const rateMap = new Map();

const BANNED_PHRASES = [
  '我會一直陪你', '只有我懂你', '你只需要我', '你還有我',
  '我不會離開你', '你應該',
];

const LANGUAGE_HINTS = {
  'zh-TW': {
    replyRule: '用繁體中文回覆',
    riskRule: '使用者提到想死、自傷、自殺時：表達關心，導向撥打 1925 安心專線',
    styleHints: {
      '溫柔傾聽': '語氣溫柔，以傾聽和共感為主，不主動給建議。',
      '給我建議': '在共感之後，可以適度給一個簡短的實用建議。',
      '理性分析': '語氣平穩冷靜，用理性的方式幫使用者整理思緒，不要太感性。',
    },
    unknownMood: '未知',
    nicknameLine: name => `使用者的暱稱是「${name}」，可以偶爾使用，但不要每句都叫。`,
    styleLine: hint => `使用者偏好的陪伴風格：${hint}`,
    policyLine: hint => `\n\n## 本次回應策略\n${hint}`,
    moodPrefix: mood => `[使用者目前的心情：${mood}]`,
  },
  en: {
    replyRule: 'Reply in English only',
    riskRule: 'If the user mentions suicide or self-harm, respond with care and encourage contacting a real person or calling Taiwan hotline 1925',
    styleHints: {
      '溫柔傾聽': 'Use a gentle tone centered on listening and empathy. Do not proactively give advice.',
      '給我建議': 'After empathy, you may offer one short practical suggestion.',
      '理性分析': 'Use a calm and rational tone to help the user organize their thoughts without sounding cold.',
    },
    unknownMood: 'unknown',
    nicknameLine: name => `The user prefers the nickname "${name}". You may use it occasionally, but not in every reply.`,
    styleLine: hint => `Preferred support style: ${hint}`,
    policyLine: hint => `\n\n## Response policy for this turn\n${hint}`,
    moodPrefix: mood => `[Current mood: ${mood}]`,
  },
  ja: {
    replyRule: '返答は日本語のみで行う',
    riskRule: 'ユーザーが死にたい、自傷、自殺に言及した場合は、気遣いを示し、現実の人や台湾の 1925 ホットラインにつながるよう促す',
    styleHints: {
      '溫柔傾聽': 'やさしい口調で、傾聴と共感を中心にする。自分から助言しすぎない。',
      '給我建議': '共感のあとで、短く実用的な提案を一つだけしてもよい。',
      '理性分析': '落ち着いた理性的な口調で、考えを整理する手助けをする。冷たくしすぎない。',
    },
    unknownMood: '不明',
    nicknameLine: name => `ユーザーの呼び名は「${name}」。自然な時だけ時々使い、毎回は使わない。`,
    styleLine: hint => `希望する寄り添い方: ${hint}`,
    policyLine: hint => `\n\n## 今回の応答方針\n${hint}`,
    moodPrefix: mood => `[今の気分: ${mood}]`,
  },
};

function normalizeLanguage(language) {
  return ['zh-TW', 'en', 'ja'].includes(language) ? language : 'zh-TW';
}

function getLanguageConfig(language) {
  return LANGUAGE_HINTS[normalizeLanguage(language)] || LANGUAGE_HINTS['zh-TW'];
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.headers['x-real-ip'] || 'unknown';
}

function getRateLimitKey(req) {
  const body = req.body || {};
  if (body.userId && typeof body.userId === 'string') return 'uid:' + body.userId;
  return 'ip:' + getClientIp(req);
}

function checkRate(key) {
  const now = Date.now();
  const entry = rateMap.get(key);
  if (!entry || now - entry.start > RATE_WINDOW) {
    rateMap.set(key, { start: now, count: 1 });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT;
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && typeof item.content === 'string' && typeof item.role === 'string')
    .map(item => ({
      role: item.role === 'assistant' ? 'assistant' : 'user',
      content: item.content.trim().slice(0, 1500),
    }))
    .filter(item => item.content);
}

function buildSystemPrompt({ language, policyHint, nickname, aiStyle }) {
  const lang = getLanguageConfig(language);
  const styleHint = lang.styleHints[aiStyle];

  const basePrompt = `你是「Starfold」App 裡的短期情緒出口。你不是 AI 伴侶，不是心理治療師，不是長期陪伴者。

## 你的定位
- 讓使用者有一個低負擔的情緒出口
- 提供短暫被接住的感覺
- 避免使用者對你形成依賴
- 在風險情況下導向真人支持

## 回應規則
- ${lang.replyRule}
- 回應最多 2 句話，簡短溫暖
- 不主動追問、不延長對話
- 不做心理分析、不模擬診斷
- 不說「我會一直陪你」「你還有我」等依附性語句
- 不主動詢問自傷的細節、方法或計畫

## 風險回應
- ${lang.riskRule}
- 不要給任何可能協助自我傷害的資訊
- 不要用模糊語句帶過危機訊號`;

  let personalization = '';
  if (nickname && typeof nickname === 'string' && nickname.trim()) {
    personalization += `\n${lang.nicknameLine(nickname.trim().slice(0, 20))}`;
  }
  if (aiStyle && styleHint) {
    personalization += `\n${lang.styleLine(styleHint)}`;
  }

  const policyAddendum = policyHint ? lang.policyLine(policyHint) : '';
  return basePrompt + personalization + policyAddendum;
}

function buildMessages(body) {
  const language = normalizeLanguage(body.language);
  const lang = getLanguageConfig(language);
  const messages = [{ role: 'system', content: buildSystemPrompt(body) }];

  sanitizeHistory(body.history).slice(-6).forEach(item => {
    messages.push(item);
  });

  const message = String(body.message || '').trim().slice(0, 2000);
  const mood = typeof body.mood === 'string' ? body.mood.trim() : '';
  const userContent =
    mood && mood !== lang.unknownMood
      ? `${lang.moodPrefix(mood)}\n${message}`
      : message;

  messages.push({ role: 'user', content: userContent });
  return messages;
}

async function callOpenAI({ apiKey, model, messages }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 150,
        temperature: 0.7,
      }),
    });

    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {}

    if (!response.ok) {
      const errType = data?.error?.type || data?.error?.code || '';
      if (errType.includes('insufficient_quota') || response.status === 429) {
        throw new Error('quota_exceeded');
      }
      if (errType.includes('invalid_api_key') || response.status === 401) {
        throw new Error('invalid_api_key');
      }
      if (errType.includes('model_not_found') || response.status === 404) {
        throw new Error('model_not_found');
      }
      throw new Error('ai_service_error');
    }

    let reply = data?.choices?.[0]?.message?.content || '';
    BANNED_PHRASES.forEach(phrase => {
      reply = reply.replace(new RegExp(phrase, 'gi'), '');
    });
    reply = reply.trim();

    if (!reply) throw new Error('empty_response');
    return reply;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('ai_timeout');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = async (req, res) => {
  const allowedOrigins = [
    'https://wenjadai-commits.github.io',
    'http://localhost:3000',
    'http://127.0.0.1:5500',
  ];
  const origin = req.headers.origin || '';

  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const rateLimitKey = getRateLimitKey(req);
  if (!checkRate(rateLimitKey)) {
    return res.status(429).json({ error: 'rate_limit' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  if (!apiKey) {
    return res.status(500).json({ error: 'missing_api_key' });
  }

  try {
    const message = String(req.body?.message || '').trim();
    if (!message) {
      return res.status(400).json({ error: 'invalid_message' });
    }

    const reply = await callOpenAI({
      apiKey,
      model,
      messages: buildMessages({
        message,
        mood: req.body?.mood,
        history: req.body?.history,
        policyHint: req.body?.policyHint,
        nickname: req.body?.nickname,
        aiStyle: req.body?.aiStyle,
        language: req.body?.language,
      }),
    });

    return res.status(200).json({ reply });
  } catch (error) {
    const code = error?.message || 'server_error';
    if (code === 'quota_exceeded') return res.status(429).json({ error: code });
    if (code === 'invalid_api_key') return res.status(401).json({ error: code });
    if (code === 'model_not_found') return res.status(404).json({ error: code });
    if (code === 'ai_timeout') return res.status(504).json({ error: code });
    if (code === 'empty_response') return res.status(502).json({ error: code });
    if (code === 'ai_service_error') return res.status(502).json({ error: code });
    console.error('chat api error:', error);
    return res.status(500).json({ error: 'server_error' });
  }
};
