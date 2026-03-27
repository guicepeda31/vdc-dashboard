# VDC Dashboard

Dashboard operacional interno para o Mercado Livre, com Gestor Virtual IA (Gemini).

## Arquitetura

```
Browser (index.html)
      │  cookies httpOnly (sessão)
      │  /api/*  (sem chaves visíveis)
      ▼
Express (server.js)
      ├─ Sessão servidor → ML tokens ficam AQUI
      ├─ /api/chat ──────────────► Gemini AI
      ├─ /api/ml/* ──────────────► Mercado Livre API
      └─ /api/auth/* ────────────► auth por sessão
```

**Chaves de API nunca chegam ao navegador.**

---

## Deploy na Trapiche.cloud

### 1. Suba o projeto no GitHub

```bash
git init
git add .
git commit -m "primeiro commit"
git remote add origin https://github.com/seu-usuario/vdc-dashboard.git
git push -u origin main
```

> Crie um `.gitignore` com `.env` e `node_modules/` antes de subir.

### 2. Deploy na Trapiche

1. Acesse [dashboard.trapiche.cloud](https://dashboard.trapiche.cloud)
2. Clique em **"Novo Deploy"**
3. Selecione seu repositório no GitHub
4. A Trapiche detecta automaticamente o Node.js e usa o script `start`
5. Seu app ficará em `https://vdc.ssr.trapiche.site`

### 3. Configure as variáveis de ambiente

No painel da Trapiche, vá em **Configurações do deploy → Variáveis de Ambiente** e adicione:

| Variável         | Valor                                             |
|-----------------|---------------------------------------------------|
| `NODE_ENV`      | `production`                                      |
| `BASE_URL`      | `https://vdc.ssr.trapiche.site` (seu domínio)    |
| `SESSION_SECRET`| string aleatória longa (veja abaixo)              |
| `USERS_JSON`    | JSON com usuários (veja abaixo)                   |
| `ML_APP_ID`     | ID do App Mercado Livre                           |
| `ML_APP_SECRET` | Secret do App Mercado Livre                       |
| `GEMINI_API_KEY`| Chave da API Google AI Studio                     |

**Gerar SESSION_SECRET:**
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

**Formato USERS_JSON:**
```json
[
  {"email":"usuario@empresa.com","password":"Senha@Forte123!","name":"Nome","role":"Admin"}
]
```

---

## Configurar o App Mercado Livre

1. Acesse [developers.mercadolibre.com.br](https://developers.mercadolibre.com.br)
2. Crie um novo App ou acesse um existente
3. Em **"Redirect URIs"**, adicione exatamente:
   ```
   https://SEU_DOMINIO/api/ml/callback
   ```
4. Copie o **App ID** e o **Client Secret**
5. Configure como variáveis de ambiente no servidor

---

## Deploy na Vercel (alternativa)

A Vercel suporta Node.js nativamente. Crie um `vercel.json`:

```json
{
  "version": 2,
  "builds": [{ "src": "server.js", "use": "@vercel/node" }],
  "routes": [{ "src": "/(.*)", "dest": "server.js" }]
}
```

Configure as mesmas variáveis de ambiente no painel da Vercel.

---

## Desenvolvimento local

```bash
# Clone e instale
git clone https://github.com/seu-usuario/vdc-dashboard.git
cd vdc-dashboard
npm install

# Configure as variáveis
cp .env.example .env
# Edite o .env com suas chaves

# Rode o servidor
npm run dev   # com hot-reload (Node 18+)
# ou
npm start
```

Acesse: http://localhost:3000

---

## Segurança

| Aspecto              | Como está protegido                                      |
|---------------------|----------------------------------------------------------|
| Chaves de API        | Apenas em variáveis de ambiente no servidor              |
| ML Access Token      | Armazenado na sessão do servidor (httpOnly cookie)       |
| Autenticação         | Sessão httpOnly, com delay anti-brute-force              |
| Rate limiting        | 120 req/min geral, 25 msg/min no chat de IA              |
| Headers HTTP         | Helmet.js — remove headers que revelam o stack           |
| Inputs               | Sanitizados e limitados em tamanho no servidor           |
| Cookie de sessão     | `httpOnly=true`, `secure=true` (prod), `sameSite=lax`   |

### Melhorias recomendadas para produção

- [ ] Migrar senhas para hashes `bcrypt` no `USERS_JSON`
- [ ] Adicionar `express-session` com store persistente (Redis ou SQLite)
- [ ] Configurar domínio personalizado com SSL na Trapiche
- [ ] Ativar logs de acesso e monitoramento
- [ ] Considerar 2FA para o login

---

## Estrutura do projeto

```
vdc-dashboard/
├── server.js          # Backend Express
├── package.json
├── .env.example       # Template de variáveis
├── .gitignore
├── README.md
└── public/
    └── index.html     # Frontend (sem chaves de API)
```

---

## Rotas da API

| Método | Rota                   | Descrição                          |
|--------|------------------------|------------------------------------|
| POST   | `/api/auth/login`      | Login com e-mail e senha           |
| POST   | `/api/auth/logout`     | Logout e destruição da sessão      |
| GET    | `/api/auth/me`         | Dados do usuário logado            |
| GET    | `/api/ml/connect`      | Inicia OAuth com Mercado Livre     |
| GET    | `/api/ml/callback`     | Callback OAuth do ML               |
| GET    | `/api/ml/status`       | Status da conexão ML               |
| DELETE | `/api/ml/disconnect`   | Remove conexão ML da sessão        |
| GET    | `/api/ml/orders`       | Pedidos recentes                   |
| GET    | `/api/ml/items`        | Produtos do catálogo               |
| GET    | `/api/ml/search?q=...` | Busca de produtos                  |
| GET    | `/api/ml/claims`       | Reclamações/devoluções abertas     |
| GET    | `/api/ml/shipments`    | Envios recentes                    |
| POST   | `/api/chat`            | Chat com Gemini IA                 |
| GET    | `/api/ai/status`       | Status da IA                       |
