# WhatsApp Nova Bot

Nova is a WhatsApp group bot with:
- Dynamic personality per member
- Layered memory (short context + long facts)
- Smart prompt context retrieval
- Multi-key Gemini rotation with retry/cooldown on quota errors
- Tavily/Serper web search fallback
- SQLite storage with automatic migration from legacy JSON files

## Setup
1. Install dependencies:
```bash
npm install
```
2. Configure `.env` (see `.env.example`).
   - For multiple groups: `TARGET_GROUP_NAMES=Nova,NovaAcademy`
3. Start:
```bash
npm start
```
4. Scan the QR code in terminal.

If WhatsApp Web bootstrap is unstable, tune retries in `.env`:
- `INIT_RETRY_ATTEMPTS` (default `5`)
- `INIT_RETRY_DELAY_MS` (default `3000`)

## Commands
- `/edit <number>`: set short-context size
- `/edit all`: use full available history context (with internal safety cap)
- `/set false`: disable startup WhatsApp history sync
- `/set <number>`: sync latest `<number>` messages on startup
- `/set all`: sync all available messages on startup
- `/member`: rebuild `members.json` from last `MEMBERS_BOOTSTRAP_LIMIT` human messages via AI
- `/status`: current counters and relationship snapshot
- `/mood`: show current mood/affinity with requester
- `/mood <accountName> <value>`: manually set affinity (-100..100), admin only
- `/help`: command list

## Admin Guardrails
Set admin IDs in `.env`:
```env
ADMIN_WA_IDS=2010xxxxxxx,2012xxxxxxx
```
If empty, commands are allowed for everyone (with warning log).

## Storage
- Main storage: `nova.sqlite`
- Members export: `members.json`
- Legacy files (`database.json`, `context.json`, `members.json`) are auto-migrated one time.

## Tests
```bash
npm test
```
