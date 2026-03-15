import { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

const port = Number(Bun.env.PORT ?? 3000);
const slackSigningSecret = must("SLACK_SIGNING_SECRET");
const slackClientId = must("SLACK_CLIENT_ID");
const slackClientSecret = must("SLACK_CLIENT_SECRET");
const openaiApiKey = must("OPENAI_API_KEY");
const publicBaseUrl = Bun.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
const redirectUri = Bun.env.SLACK_REDIRECT_URI ?? (publicBaseUrl ? `${publicBaseUrl}/slack/oauth/callback` : undefined);
const channelWhitelist = new Set(
  (Bun.env.SLACK_CHANNEL_WHITELIST ?? Bun.env.SLACK_CHANNEL_ID ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const userWhitelist = new Set(
  (Bun.env.SLACK_USER_WHITELIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const gossipCooldownMs = Number(Bun.env.GOSSIP_COOLDOWN_MS ?? 300_000);
const gossipProbability = Number(Bun.env.GOSSIP_PROBABILITY ?? 0.6);
const openaiModel = Bun.env.OPENAI_MODEL ?? "gpt-4.1-mini";
const installUrl = publicBaseUrl ? `${publicBaseUrl}/slack/install` : "/slack/install";
const dbPath = Bun.env.DATABASE_PATH ?? "./slack-side-voice.sqlite";
const botScopes = ["channels:history", "groups:history", "chat:write"];

if (!redirectUri) {
  throw new Error("Set SLACK_REDIRECT_URI or PUBLIC_BASE_URL");
}

// Short channel history: key = "teamId:channelId", value = last 20 messages
const channelHistory = new Map<string, Array<{ userId: string; text: string }>>();
const HISTORY_MAX = 20;

// Cooldown tracking: key = "teamId:channelId:userId", value = Date.now() of last gossip
const lastGossiped = new Map<string, number>();

const openai = createOpenAI({ apiKey: openaiApiKey });
const db = new Database(dbPath, { create: true });

db.exec(`
  CREATE TABLE IF NOT EXISTS slack_installs (
    team_id TEXT PRIMARY KEY,
    team_name TEXT,
    bot_user_id TEXT NOT NULL,
    bot_token TEXT NOT NULL,
    scope TEXT,
    installed_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const upsertInstall = db.query(`
  INSERT INTO slack_installs (team_id, team_name, bot_user_id, bot_token, scope, installed_at, updated_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
  ON CONFLICT(team_id) DO UPDATE SET
    team_name = excluded.team_name,
    bot_user_id = excluded.bot_user_id,
    bot_token = excluded.bot_token,
    scope = excluded.scope,
    updated_at = excluded.updated_at
`);

const findInstall = db.query(`
  SELECT team_id, team_name, bot_user_id, bot_token, scope, installed_at, updated_at
  FROM slack_installs
  WHERE team_id = ?1
`);

const listInstalls = db.query(`
  SELECT team_id, team_name, installed_at, updated_at
  FROM slack_installs
  ORDER BY updated_at DESC
`);

Bun.serve({
  port,
  hostname: "0.0.0.0",
  routes: {
    "/": () => homepage(),
    "/health": () => json({ ok: true, timestamp: new Date().toISOString() }),
    "/slack/install": () => Response.redirect(authorizeUrl(), 302),
    "/slack/oauth/callback": async (req) => handleOAuthCallback(req),
    "/slack/events": {
      POST: async (req) => {
        const rawBody = await req.text();

        if (!isValidSlackRequest(req, rawBody, slackSigningSecret)) {
          return json({ error: "invalid signature" }, 401);
        }

        const payload = JSON.parse(rawBody) as SlackEnvelope;
        const eventType = payload.type === "event_callback" ? payload.event.type : payload.type;
        const eventTeamId = payload.type === "event_callback" ? payload.team_id : "n/a";
        console.log(`[event] type=${eventType} team=${eventTeamId}`);

        if (payload.type === "url_verification") {
          return json({ challenge: payload.challenge });
        }

        if (payload.type === "event_callback" && payload.event.type === "message") {
          void handleMessageEvent(payload);
        }
        return json({ ok: true });
      },
    },
  },
});

console.log(`Listening on http://localhost:${port}`);
console.log(`Install URL: ${installUrl}`);
console.log(`OAuth redirect URI: ${redirectUri}`);
console.log(`Database: ${dbPath}`);

async function handleMessageEvent(payload: Extract<SlackEnvelope, { type: "event_callback" }>) {
  const event = payload.event;
  const teamId = payload.team_id;

  if (!teamId || event.user == null || event.bot_id != null || event.subtype != null) return;
  if (channelWhitelist.size > 0 && !channelWhitelist.has(event.channel)) return;

  const install = getInstall(teamId);
  if (!install) {
    console.warn(`No install found for team ${teamId}`);
    return;
  }

  if (event.user === install.bot_user_id) return;

  console.log(`[message] team=${teamId} channel=${event.channel} user=${event.user} mode=gossip`);

  const historyKey = `${teamId}:${event.channel}`;
  const history = channelHistory.get(historyKey) ?? [];
  history.push({ userId: event.user, text: event.text ?? "" });
  while (history.length > HISTORY_MAX) {
    history.shift();
  }
  channelHistory.set(historyKey, history);

  const cooldownKey = `${teamId}:${event.channel}:${event.user}`;
  const lastGossipedAt = lastGossiped.get(cooldownKey);
  if (gossipProbability !== 1 && lastGossipedAt != null && Date.now() - lastGossipedAt < gossipCooldownMs) {
    console.log(`[gossip] skipped cooldown for user=${event.user}`);
    return;
  }
  if (Math.random() > gossipProbability) {
    console.log(`[gossip] skipped random for user=${event.user}`);
    return;
  }

  const recipients = Array.from(userWhitelist).filter((userId) => {
    if (userId === install.bot_user_id) return false;
    if (userId === event.user && gossipProbability !== 1) return false;
    return true;
  });
  if (recipients.length === 0) return;
  const historyText = history
    .slice(0, -1)
    .map((message) => `${message.userId}: ${message.text}`)
    .join("\n");

  const prompt = [
    "You are a witty, gossipy Slack bot that whispers private commentary about what people say in channels.",
    "You are talking BEHIND the sender's back to other people in the channel.",
    "Be playful, a little cheeky, and keep it lighthearted — not mean-spirited.",
    "Vary your tone and style — sometimes dry, sometimes amused, sometimes conspiratorial, sometimes deadpan.",
    "Never start with 'Oh', 'Oh,', or 'Oh look'. Never use the same opener twice in a row.",
    "Do NOT start every message the same way — mix up how you open.",
    "If the message isn't interesting enough to gossip about, respond with exactly NO_REPLY.",
    "Otherwise respond with a single punchy sentence under 200 characters. No quotes around the response.",
    `Workspace: ${install.team_name ?? install.team_id}`,
    `Channel: ${event.channel}`,
    historyText ? `Recent channel history:\n${historyText}` : "",
    `The message you're gossiping about was sent by ${event.user}: ${event.text ?? ""}`,
  ]
    .filter(Boolean)
    .join("\n");
  try {
    const { text } = await generateText({
      model: openai(openaiModel),
      prompt,
      temperature: 0.8,
      maxTokens: 80,
    });

    const reply = text.trim();
    if (!reply || reply === "NO_REPLY") {
      console.log(`[gossip] team=${teamId} decision=NO_REPLY`);
      return;
    }

    lastGossiped.set(cooldownKey, Date.now());

    for (const recipient of recipients) {
      await slackApi("chat.postEphemeral", install.bot_token, {
        channel: event.channel,
        user: recipient,
        text: `${reply}`,
      });
    }

    console.log(`[gossip] team=${teamId} channel=${event.channel} sender=${event.user} recipients=${recipients.length} reply=${JSON.stringify(reply)}`);
  } catch (error) {
    console.error(`Failed to process message for team ${teamId}`, error);
  }
}

async function handleOAuthCallback(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return html(`<h1>Slack install cancelled</h1><p>${escapeHtml(error)}</p>`, 400);
  }

  if (!code || !state || !isValidState(state)) {
    return html("<h1>Invalid OAuth callback</h1>", 400);
  }

  try {
    const payload = await exchangeCodeForToken(code);
    const teamId = payload.team?.id;
    const botToken = payload.access_token;
    const botUserId = payload.bot_user_id;

    if (!teamId || !botToken || !botUserId) {
      throw new Error("Missing team id, bot token, or bot user id from Slack OAuth response");
    }

    const now = new Date().toISOString();
    upsertInstall.run(teamId, payload.team?.name ?? null, botUserId, botToken, payload.scope ?? botScopes.join(","), now);

    return html(`
      <h1>Installed Side Voice</h1>
      <p>Workspace: <strong>${escapeHtml(payload.team?.name ?? teamId)}</strong></p>
      <p>The app can now receive events for this workspace.</p>
      <p>Invite the bot to any channel you want it to monitor.</p>
    `);
  } catch (error) {
    console.error("OAuth callback failed", error);
    return html(`<h1>Install failed</h1><p>${escapeHtml(String(error))}</p>`, 500);
  }
}

function homepage() {
  const installs = listInstalls.all() as Array<{ team_id: string; team_name: string | null; installed_at: string; updated_at: string }>;
  const items = installs.length
    ? installs
        .map(
          (install) =>
            `<li><strong>${escapeHtml(install.team_name ?? install.team_id)}</strong> <small>(${escapeHtml(install.team_id)})</small></li>`,
        )
        .join("")
    : "<li>No workspaces installed yet.</li>";

  return html(`
    <h1>Side Voice</h1>
    <p>Minimal multi-workspace Slack listener built with Bun.</p>
    <p><a href="${escapeHtml(installUrl)}">Install to Slack</a></p>
    <h2>Installed workspaces</h2>
    <ul>${items}</ul>
  `);
}

function authorizeUrl() {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", slackClientId);
  url.searchParams.set("scope", botScopes.join(","));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", createState());
  return url.toString();
}

async function exchangeCodeForToken(code: string) {
  const body = new URLSearchParams({
    code,
    client_id: slackClientId,
    client_secret: slackClientSecret,
    redirect_uri: redirectUri,
  });

  const response = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const payload = (await response.json()) as OAuthAccessResponse;
  if (!payload.ok) {
    throw new Error(`Slack OAuth failed: ${payload.error ?? "unknown_error"}`);
  }

  return payload;
}

async function slackApi(method: string, token: string, body: Record<string, string>) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });

  const payload = (await response.json()) as { ok: boolean; error?: string };
  if (!payload.ok) {
    throw new Error(`Slack API ${method} failed: ${payload.error ?? "unknown_error"}`);
  }

  return payload;
}

function getInstall(teamId: string) {
  return findInstall.get(teamId) as
    | {
        team_id: string;
        team_name: string | null;
        bot_user_id: string;
        bot_token: string;
        scope: string | null;
        installed_at: string;
        updated_at: string;
      }
    | null;
}

function createState() {
  const nonce = crypto.randomUUID();
  const signature = createHmac("sha256", slackSigningSecret).update(nonce).digest("hex");
  return `${nonce}.${signature}`;
}

function isValidState(state: string) {
  const [nonce, signature] = state.split(".");
  if (!nonce || !signature) return false;

  const expected = createHmac("sha256", slackSigningSecret).update(nonce).digest("hex");
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);

  if (expectedBuffer.length !== actualBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

function isValidSlackRequest(req: Request, rawBody: string, signingSecret: string) {
  const timestamp = req.headers.get("x-slack-request-timestamp");
  const signature = req.headers.get("x-slack-signature");

  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 * 5) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;

  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== actualBuffer.length) return false;

  return timingSafeEqual(expectedBuffer, actualBuffer);
}

function html(body: string, status = 200) {
  return new Response(`<!doctype html><html><body style="font-family: sans-serif; max-width: 720px; margin: 40px auto; line-height: 1.5">${body}</body></html>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function must(name: string) {
  const value = Bun.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

type SlackEnvelope =
  | {
      type: "url_verification";
      challenge: string;
    }
  | {
      type: "event_callback";
      team_id: string;
      event: SlackMessageEvent;
    };

type SlackMessageEvent = {
  type: "message";
  channel: string;
  user?: string;
  text?: string;
  bot_id?: string;
  subtype?: string;
};

type OAuthAccessResponse = {
  ok: boolean;
  error?: string;
  access_token?: string;
  scope?: string;
  bot_user_id?: string;
  team?: {
    id?: string;
    name?: string;
  };
};
