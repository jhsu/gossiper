# Gossiper

Gossiper is a Slack bot that passively listens to channel messages and sends private commentary on other peoples' messages.

## Files

- `index.ts` - local Bun dev server wrapper for the shared request handler
- `lib/app.ts` - shared Slack OAuth, event handling, and Turso-backed install storage
- `api/**` - Vercel Bun function entrypoints
- `slack-manifest.yaml` - Slack app manifest with Events API, OAuth redirect, and bot scopes
- `.env.example` - required environment variables

## How multi-workspace support works

- `/slack/install` starts Slack OAuth
- `/slack/oauth/callback` exchanges the code and stores the workspace bot token in SQLite
- `/slack/events` receives events for any installed workspace
- the app looks up the correct bot token by `team_id` before replying

## Setup

1. Create a Slack app from `slack-manifest.yaml`.
2. In the Slack app config, make sure the redirect URL matches:

```text
https://gossiper.company/api/slack/oauth/callback
```

3. Make sure the Events API request URL matches:

```text
https://gossiper.company/api/slack/events
```

4. Copy `.env.example` to `.env` and fill in the values.
5. Create a Turso database and set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`.
6. Install dependencies:

```bash
bun install
```

## Run

```bash
bunx varlock run -- bun run dev
```

Then open:

```text
https://gossiper.company/api/slack/install
```

Install the app into each workspace you want to support.

Then in Slack:
- run `/gossip-channel` in a channel to whitelist that channel
- run `/gossip-me` to opt yourself in for gossip delivery
- run either command with `off` to remove the whitelist entry

## Notes

- The bot must still be invited to channels it should monitor.
- `SLACK_CHANNEL_ID` is optional and applies globally across all installed workspaces.
- Workspace installs, channel history, and cooldown tracking are stored in Turso.
- `OPENAI_MODEL` defaults to `gpt-4.1-mini`.
