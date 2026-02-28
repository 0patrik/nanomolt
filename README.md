# nanomolt

Telegram bot that bridges voice and text to OpenCode, with automatic session attach.

## Setup

1. Copy `.env.example` to `.env` and fill in required values.
2. Install dependencies: `npm install`
3. Run locally: `npm run dev`

## OpenCode integration

- Starts `opencode serve` from `OPENCODE_HOME` if present.
- Attaches sessions via `opencode attach` in a separate terminal.

## Environment

- `BOT_TOKEN`
- `ALLOWED_USER_ID`
- `OPENCODE_URL`
- `OPENCODE_BIN`
- `OPENCODE_HOME`
- `OPENCODE_ATTACH_MODE`
- `OPENCODE_ATTACH_APP`
