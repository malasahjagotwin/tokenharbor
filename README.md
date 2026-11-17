# Token Harbor automation

Fast Playwright-based flow to create a Token Harbor account, verify email via the inbox worker, enable free models, and mint an API key.

## Requirements
- Node.js
- `playwright-core` resolvable from this folder (or set `NODE_PATH` to where it's installed)
- Chromium at `/repl/tools/bin/chromium` (override with `CHROMIUM_PATH`)
- Email inbox worker at `https://thmail.malasahjago.workers.dev` (override with `MAIL_API`) that exposes `/`, `/read?key=...`

## Usage
```bash
# from this folder (needs playwright-core in module resolution)
NODE_PATH=/path/to/node_modules node create-account.js

# optional env
EMAIL_PREFIX=myuser EMAIL_DOMAIN=leluhurcy.us.ci KEY_LABEL=opencode \
DISCORD_TOKEN=... DISCORD_CHANNEL_ID=... \
node create-account.js
```

Outputs: `accounts/<prefix>.json` with `{email,password,api_key,...}` and browser state in `state/<prefix>.state.json`.

## Notes
- Polls the inbox worker every 2s for the verification email (faster than fixed sleeps).
- Reuses a single browser context for signup → verify → dashboard to avoid re-login.
- Keep `thmail` worker access-controlled; it currently lists/reads inbox contents without auth.
