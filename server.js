'use strict';
require('dotenv').config();

const express    = require('express');
const session    = require('express-session');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ══════════════════════════════════════════════
// 1. TRUST PROXY
// Necessário para Trapiche/Vercel (HTTPS via load balancer)
// ══════════════════════════════════════════════
app.set('trust proxy', 1);

// ══════════════════════════════════════════════
// 2. SECURITY — Helmet + headers
// ══════════════════════════════════════════════
app.use(helmet({
  contentSecurityPolicy: false,   // Desabilitado pois o frontend usa CDN de fontes
  crossOriginEmbedderPolicy: false
}));

// Remove header que revela o stack
app.disable('x-powered-by');

// ══════════════════════════════════════════════
// 3. BODY PARSING (limite para evitar abusos)
// ══════════════════════════════════════════════
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));

// ══════════════════════════════════════════════
// 4. SESSION — tokens ficam APENAS no servidor
// Nunca expostos ao frontend
// ══════════════════════════════════════════════
app.use(session({
  secret: process.env.SESSION_SECRET || warnAndReturn('SESSION_SECRET', 'dev-secret-MUDE-EM-PRODUCAO'),
  resave: false,
  saveUninitialized: false,
  name: 'vdc.sid',
  cookie: {
    httpOnly: true,                                    // JS do browser nunca acessa
    secure: process.env.NODE_ENV === 'production',     // HTTPS apenas em prod
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000                        // 8 horas
  }
}));

// ══════════════════════════════════════════════
// 5. RATE LIMITING
// ══════════════════════════════════════════════
const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});

const chatLimiter = rateLimit({
  windowMs: 60_000,
  max: 25,                      // 25 mensagens/min por sessão
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Limite de mensagens atingido. Aguarde 1 minuto.' }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,                      // 10 tentativas de login a cada 15min por IP
  message: { error: 'Muitas tentativas de login. Aguarde.' }
});

app.use('/api', apiLimiter);

// ══════════════════════════════════════════════
// 6. AUTH MIDDLEWARE
// ══════════════════════════════════════════════
function requireAuth(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({ error: 'Não autenticado' });
  }
  next();
}

// ══════════════════════════════════════════════
// 7. USUÁRIOS — definidos no .env como JSON
// Nunca no código-fonte
// ══════════════════════════════════════════════
function getUsers() {
  try {
    return JSON.parse(process.env.USERS_JSON || '[]');
  } catch {
    console.error('USERS_JSON inválido no .env');
    return [];
  }
}

// ══════════════════════════════════════════════
// ROTAS — AUTH
// ══════════════════════════════════════════════

// POST /api/auth/login
app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'E-mail e senha são obrigatórios' });
  }

  const users = getUsers();
  const user = users.find(
    u => u.email.toLowerCase() === email.toLowerCase().trim() && u.password === password
  );

  if (!user) {
    // Delay intencional para dificultar brute-force
    return setTimeout(() => res.status(401).json({ error: 'Credenciais inválidas' }), 500);
  }

  req.session.user = { email: user.email, name: user.name, role: user.role };
  res.json({ name: user.name, role: user.role });
});

// POST /api/auth/logout
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('vdc.sid');
    res.json({ ok: true });
  });
});

// GET /api/auth/me — usado para restaurar sessão ao recarregar a página
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json(req.session.user);
});

// ══════════════════════════════════════════════
// ROTAS — MERCADO LIVRE OAUTH
// ══════════════════════════════════════════════

// Passo 1: redireciona o usuário para a autorização do ML
app.get('/api/ml/connect', requireAuth, (req, res) => {
  const { ML_APP_ID, BASE_URL } = process.env;
  if (!ML_APP_ID || !BASE_URL) {
    return res.status(500).json({ error: 'ML_APP_ID ou BASE_URL não configurado no servidor' });
  }
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: ML_APP_ID,
    redirect_uri: `${BASE_URL}/api/ml/callback`
  });
  res.redirect(`https://auth.mercadolivre.com.br/authorization?${params}`);
});

// Passo 2: ML redireciona de volta com o código de autorização
app.get('/api/ml/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    return res.redirect(`/?ml_error=${encodeURIComponent(error || 'Autorização negada pelo usuário')}`);
  }

  const { ML_APP_ID, ML_APP_SECRET, BASE_URL } = process.env;

  try {
    // Troca o código pelo token de acesso
    const tokenRes = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: ML_APP_ID,
        client_secret: ML_APP_SECRET,
        code,
        redirect_uri: `${BASE_URL}/api/ml/callback`
      })
    });

    const tokens = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(tokens.message || 'Erro ao trocar código pelo token');

    // Busca dados do vendedor
    const meRes = await fetch('https://api.mercadolibre.com/users/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const me = await meRes.json();
    if (!meRes.ok) throw new Error('Erro ao buscar dados do vendedor');

    // Salva tokens NA SESSÃO DO SERVIDOR — nunca vai ao browser
    req.session.ml = {
      accessToken:  tokens.access_token,
      refreshToken: tokens.refresh_token,
      sellerId:     String(me.id),
      sellerName:   me.nickname || me.first_name || 'Vendedor',
      connectedAt:  new Date().toISOString()
    };

    res.redirect('/?ml_connected=1');
  } catch (e) {
    console.error('[ML Callback]', e.message);
    res.redirect(`/?ml_error=${encodeURIComponent(e.message)}`);
  }
});

// GET /api/ml/status — frontend checa se ML está conectado
app.get('/api/ml/status', requireAuth, (req, res) => {
  const ml = req.session.ml;
  if (ml?.accessToken) {
    res.json({
      connected:   true,
      seller:      ml.sellerName,
      sellerId:    ml.sellerId,
      connectedAt: ml.connectedAt
    });
  } else {
    res.json({ connected: false });
  }
});

// DELETE /api/ml/disconnect
app.delete('/api/ml/disconnect', requireAuth, (req, res) => {
  delete req.session.ml;
  res.json({ ok: true });
});

// ══════════════════════════════════════════════
// HELPER — ML API PROXY (com auto-refresh)
// ══════════════════════════════════════════════
async function mlFetch(session, path) {
  const ml = session.ml;
  if (!ml?.accessToken) {
    const err = new Error('Mercado Livre não conectado. Conecte na seção de Configurações.');
    err.status = 401;
    throw err;
  }

  const doRequest = (token) =>
    fetch(`https://api.mercadolibre.com${path}`, {
      headers: { Authorization: `Bearer ${token}` }
    });

  let res = await doRequest(ml.accessToken);

  // Token expirado → tenta renovar automaticamente
  if (res.status === 401 && ml.refreshToken) {
    try {
      const rfRes = await fetch('https://api.mercadolibre.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type:    'refresh_token',
          client_id:     process.env.ML_APP_ID,
          client_secret: process.env.ML_APP_SECRET,
          refresh_token: ml.refreshToken
        })
      });

      const newTokens = await rfRes.json();
      if (rfRes.ok) {
        session.ml.accessToken = newTokens.access_token;
        if (newTokens.refresh_token) session.ml.refreshToken = newTokens.refresh_token;
        res = await doRequest(newTokens.access_token);
      }
    } catch (rfErr) {
      console.warn('[ML Refresh]', rfErr.message);
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.message || `ML API retornou ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ══════════════════════════════════════════════
// ROTAS — ML DATA (proxy seguro)
// ══════════════════════════════════════════════

// GET /api/ml/orders
app.get('/api/ml/orders', requireAuth, async (req, res) => {
  try {
    const { sellerId } = req.session.ml || {};
    if (!sellerId) return res.status(400).json({ error: 'ML não conectado' });
    const data = await mlFetch(req.session,
      `/orders/search?seller=${sellerId}&sort=date_desc&limit=30`
    );
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// GET /api/ml/items
app.get('/api/ml/items', requireAuth, async (req, res) => {
  try {
    const { sellerId } = req.session.ml || {};
    if (!sellerId) return res.status(400).json({ error: 'ML não conectado' });

    const search = await mlFetch(req.session, `/users/${sellerId}/items/search?limit=20`);
    const ids = (search.results || []).slice(0, 12);

    const settled = await Promise.allSettled(
      ids.map(id => mlFetch(req.session, `/items/${id}`))
    );
    const items = settled
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);

    res.json({ results: items });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// GET /api/ml/search?q=...
app.get('/api/ml/search', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 200);
  if (!q) return res.status(400).json({ error: 'Parâmetro q obrigatório' });

  try {
    const { sellerId } = req.session.ml || {};
    const path = sellerId
      ? `/sites/MLB/search?seller_id=${sellerId}&q=${encodeURIComponent(q)}&limit=15`
      : `/sites/MLB/search?q=${encodeURIComponent(q)}&limit=15`;
    const data = await mlFetch(req.session, path);
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// GET /api/ml/claims (devoluções/reclamações)
app.get('/api/ml/claims', requireAuth, async (req, res) => {
  try {
    const { sellerId } = req.session.ml || {};
    if (!sellerId) return res.status(400).json({ error: 'ML não conectado' });
    const data = await mlFetch(req.session,
      `/post-purchase/v1/claims/search?seller_id=${sellerId}&status=opened&limit=20`
    );
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// GET /api/ml/shipments (envios recentes)
app.get('/api/ml/shipments', requireAuth, async (req, res) => {
  try {
    const { sellerId } = req.session.ml || {};
    if (!sellerId) return res.status(400).json({ error: 'ML não conectado' });
    const data = await mlFetch(req.session,
      `/shipments/search?seller_id=${sellerId}&sort=date_desc&limit=20`
    );
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════
// ROTAS — GEMINI AI (proxy seguro)
// Chave fica apenas no servidor
// ══════════════════════════════════════════════

async function askGemini(messages, systemPrompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY não configurado no servidor');

  // Sanitiza e limita conteúdo
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content || '').slice(0, 8000) }]
  }));

  const body = {
    ...(systemPrompt && {
      systemInstruction: { parts: [{ text: String(systemPrompt).slice(0, 4000) }] }
    }),
    contents,
    generationConfig: {
      maxOutputTokens: 1024,
      temperature: 0.7,
      topP: 0.85
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' }
    ]
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Gemini error ${res.status}`);

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini não retornou resposta');
  return text;
}

// POST /api/chat
app.post('/api/chat', requireAuth, chatLimiter, async (req, res) => {
  const { messages, systemPrompt } = req.body || {};

  // Validações de entrada
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages deve ser um array não vazio' });
  }
  if (messages.length > 40) {
    return res.status(400).json({ error: 'Histórico muito longo (máx 40 mensagens)' });
  }
  for (const m of messages) {
    if (!m.role || !m.content || typeof m.content !== 'string') {
      return res.status(400).json({ error: 'Formato de mensagem inválido' });
    }
  }

  try {
    const text = await askGemini(messages, systemPrompt);
    res.json({ text });
  } catch (e) {
    console.error('[Chat]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ai/status — frontend checa se IA está configurada
app.get('/api/ai/status', requireAuth, (req, res) => {
  res.json({ configured: !!process.env.GEMINI_API_KEY });
});

// ══════════════════════════════════════════════
// STATIC FILES
// ══════════════════════════════════════════════
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  etag: true
}));

// SPA catch-all — serve index.html para qualquer rota não-API
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Rota não encontrada' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ══════════════════════════════════════════════
// START
// ══════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`✅ VDC Dashboard rodando em http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY)  console.warn('⚠️  GEMINI_API_KEY não definido — IA desativada');
  if (!process.env.ML_APP_ID)       console.warn('⚠️  ML_APP_ID não definido — OAuth ML desativado');
  if (!process.env.ML_APP_SECRET)   console.warn('⚠️  ML_APP_SECRET não definido');
  if (!process.env.BASE_URL)        console.warn('⚠️  BASE_URL não definido — callback ML pode falhar');
  if (process.env.SESSION_SECRET === 'dev-secret-MUDE-EM-PRODUCAO') {
    console.warn('⚠️  SESSION_SECRET não definido — use uma string aleatória longa em produção!');
  }
});

// ══════════════════════════════════════════════
// UTILS
// ══════════════════════════════════════════════
function warnAndReturn(key, fallback) {
  if (!process.env[key]) console.warn(`⚠️  ${key} não definido no .env`);
  return process.env[key] || fallback;
}
