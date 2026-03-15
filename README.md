# slack-side-voice

Minimal Bun Slack bot that supports installing the same app into multiple workspaces. It passively listens to channel messages and sends AI-generated private commentary back to the message author with `chat.postEphemeral`.

## Files

- `index.ts` - single-file bot server with Slack OAuth, event handling, and SQLite install storage
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
https://your-domain.example/slack/oauth/callback
```

3. Make sure the Events API request URL matches:

```text
https://your-domain.example/slack/events
```

4. Copy `.env.example` to `.env` and fill in the values.
5. Install dependencies:

```bash
bun install
```

## Run

```bash
bun run dev
```

Then open:

```text
https://your-domain.example/slack/install
```

Install the app into each workspace you want to support.

## Notes

- The bot must still be invited to channels it should monitor.
- `SLACK_CHANNEL_ID` is optional and applies globally across all installed workspaces.
- Workspace installs are stored in a local SQLite file.
- `OPENAI_MODEL` defaults to `gpt-4.1-mini`.
