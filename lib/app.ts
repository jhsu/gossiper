import { createClient, type Client } from "@libsql/client";
import { createHmac, timingSafeEqual } from "node:crypto";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

const slackSigningSecret = must("SLACK_SIGNING_SECRET");
const slackClientId = must("SLACK_CLIENT_ID");
const slackClientSecret = must("SLACK_CLIENT_SECRET");
const openaiApiKey = must("OPENAI_API_KEY");
const tursoDatabaseUrl = must("TURSO_DATABASE_URL");
const tursoAuthToken = must("TURSO_AUTH_TOKEN");
const publicBaseUrl = Bun.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
const redirectUri = Bun.env.SLACK_REDIRECT_URI ?? (publicBaseUrl ? `${publicBaseUrl}/slack/oauth/callback` : undefined);
const ensuredRedirectUri = redirectUri ?? fail("Set SLACK_REDIRECT_URI or PUBLIC_BASE_URL");
const configuredChannelWhitelist = new Set(
  (Bun.env.SLACK_CHANNEL_WHITELIST ?? Bun.env.SLACK_CHANNEL_ID ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const configuredUserWhitelist = new Set(
  (Bun.env.SLACK_USER_WHITELIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const gossipCooldownMs = Number(Bun.env.GOSSIP_COOLDOWN_MS ?? 300_000);
const gossipProbability = Number(Bun.env.GOSSIP_PROBABILITY ?? 0.6);
const openaiModel = Bun.env.OPENAI_MODEL ?? "gpt-4.1-mini";
const installUrl = publicBaseUrl ? `${publicBaseUrl}/slack/install` : "/slack/install";
const botScopes = ["channels:history", "groups:history", "chat:write", "commands"];
const channelCommandName = "/gossip-channel";
const userCommandName = "/gossip-me";
const commandDisableWords = new Set(["off", "remove", "disable", "stop"]);

const openai = createOpenAI({ apiKey: openaiApiKey });
const db = createClient({
  url: tursoDatabaseUrl,
  authToken: tursoAuthToken,
});

let initPromise: Promise<void> | null = null;

const HISTORY_MAX = 20;

export async function handleRequest(req: Request) {
  const url = new URL(req.url);

  if (url.pathname === "/") return handleHomepage();
  if (url.pathname === "/health") return handleHealth();
  if (url.pathname === "/slack/install") return handleSlackInstall();
  if (url.pathname === "/slack/oauth/callback") return handleSlackOAuthCallback(req);
  if (url.pathname === "/slack/events" && req.method === "POST") return handleSlackEvents(req);
  if (url.pathname === "/slack/commands" && req.method === "POST") return handleSlackCommands(req);

  return json({ error: "not found" }, 404);
}

export async function handleHomepage() {
  await init();

  return html(`
    <h1>Side Voice</h1>
    <p>Minimal multi-workspace Slack listener built with Bun and deployed on Vercel.</p>
    <p><a href="${escapeHtml(installUrl)}">Install to Slack</a></p>
    <h2>Slash commands</h2>
    <ul>
      <li><code>${escapeHtml(channelCommandName)}</code> — whitelist this channel. Add <code>off</code> to remove it.</li>
      <li><code>${escapeHtml(userCommandName)}</code> — opt yourself in. Add <code>off</code> to opt out.</li>
    </ul>
  `);
}

export function handleHealth() {
  return json({ ok: true, timestamp: new Date().toISOString() });
}

export function handleSlackInstall() {
  return Response.redirect(authorizeUrl(), 302);
}

export async function handleSlackOAuthCallback(req: Request) {
  await init();

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
    await upsertInstall({
      teamId,
      teamName: payload.team?.name ?? null,
      botUserId,
      botToken,
      scope: payload.scope ?? botScopes.join(","),
      now,
    });

    return html(`
      <h1>Installed Side Voice</h1>
      <p>Workspace: <strong>${escapeHtml(payload.team?.name ?? teamId)}</strong></p>
      <p>The app can now receive events for this workspace.</p>
      <p>Invite the bot to any channel you want it to monitor.</p>
      <p>Use <code>${escapeHtml(channelCommandName)}</code> in a channel to whitelist it and <code>${escapeHtml(userCommandName)}</code> to opt yourself in.</p>
    `);
  } catch (caught) {
    console.error("OAuth callback failed", caught);
    return html(`<h1>Install failed</h1><p>${escapeHtml(String(caught))}</p>`, 500);
  }
}

export async function handleSlackEvents(req: Request) {
  await init();

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
    await handleMessageEvent(payload);
  }

  return json({ ok: true });
}

export async function handleSlackCommands(req: Request) {
  await init();

  const rawBody = await req.text();

  if (!isValidSlackRequest(req, rawBody, slackSigningSecret)) {
    return json({ error: "invalid signature" }, 401);
  }

  const form = new URLSearchParams(rawBody);
  const command = form.get("command");
  const teamId = form.get("team_id");
  const channelId = form.get("channel_id");
  const userId = form.get("user_id");
  const text = form.get("text")?.trim().toLowerCase() ?? "";
  const enabled = !commandDisableWords.has(text);

  if (!command || !teamId || !channelId || !userId) {
    return slackCommandResponse("Missing Slack command context.");
  }

  try {
    if (command === channelCommandName) {
      if (enabled) {
        await addWhitelistedChannel(teamId, channelId);
        return slackCommandResponse("This channel is now whitelisted for gossip.");
      }

      await removeWhitelistedChannel(teamId, channelId);
      return slackCommandResponse("This channel has been removed from the gossip whitelist.");
    }

    if (command === userCommandName) {
      if (enabled) {
        await addWhitelistedUser(teamId, userId);
        return slackCommandResponse("You're now opted in to receive gossip.");
      }

      await removeWhitelistedUser(teamId, userId);
      return slackCommandResponse("You're now opted out of receiving gossip.");
    }

    return slackCommandResponse(`Unknown command: ${command}`);
  } catch (caught) {
    console.error("Slack command failed", caught);
    return slackCommandResponse("That command failed. Check the app logs and try again.");
  }
}

async function handleMessageEvent(payload: Extract<SlackEnvelope, { type: "event_callback" }>) {
  const event = payload.event;
  const teamId = payload.team_id;

  if (!teamId || event.user == null || event.bot_id != null || event.subtype != null) return;
  if (!(await isChannelWhitelisted(teamId, event.channel))) return;

  const install = await getInstall(teamId);
  if (!install) {
    console.warn(`No install found for team ${teamId}`);
    return;
  }

  if (event.user === install.bot_user_id) return;

  console.log(`[message] team=${teamId} channel=${event.channel} user=${event.user} mode=gossip`);

  await recordChannelMessage({
    teamId,
    channelId: event.channel,
    userId: event.user,
    text: event.text ?? "",
  });

  const history = await getChannelHistory(teamId, event.channel);

  const lastGossipedAt = await getLastGossipedAt({
    teamId,
    channelId: event.channel,
    userId: event.user,
  });
  if (gossipProbability !== 1 && lastGossipedAt != null && Date.now() - lastGossipedAt < gossipCooldownMs) {
    console.log(`[gossip] skipped cooldown for user=${event.user}`);
    return;
  }
  if (Math.random() > gossipProbability) {
    console.log(`[gossip] skipped random for user=${event.user}`);
    return;
  }

  const recipients = (await listWhitelistedUsers(teamId)).filter((userId) => {
    if (userId === install.bot_user_id) return false;
    if (userId === event.user && gossipProbability !== 1) return false;
    return true;
  });
  if (recipients.length === 0) return;

  const historyText = history
    .slice(0, -1)
    .map((message) => `${message.user_id}: ${message.text}`)
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
      maxOutputTokens: 80,
    });

    const reply = text.trim();
    if (!reply || reply === "NO_REPLY") {
      console.log(`[gossip] team=${teamId} decision=NO_REPLY`);
      return;
    }

    await setLastGossipedAt({
      teamId,
      channelId: event.channel,
      userId: event.user,
      timestamp: Date.now(),
    });

    for (const recipient of recipients) {
      await slackApi("chat.postEphemeral", install.bot_token, {
        channel: event.channel,
        user: recipient,
        text: reply,
      });
    }

    console.log(
      `[gossip] team=${teamId} channel=${event.channel} sender=${event.user} recipients=${recipients.length} reply=${JSON.stringify(reply)}`,
    );
  } catch (caught) {
    console.error(`Failed to process message for team ${teamId}`, caught);
  }
}

async function init() {
  if (!initPromise) {
    initPromise = ensureSchema(db);
  }

  await initPromise;
}

async function ensureSchema(client: Client) {
  await client.batch(
    [
      `
        CREATE TABLE IF NOT EXISTS slack_installs (
          team_id TEXT PRIMARY KEY,
          team_name TEXT,
          bot_user_id TEXT NOT NULL,
          bot_token TEXT NOT NULL,
          scope TEXT,
          installed_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `,
      `
        CREATE TABLE IF NOT EXISTS gossip_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          team_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          text TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `,
      `
        CREATE INDEX IF NOT EXISTS gossip_history_team_channel_created_idx
        ON gossip_history (team_id, channel_id, created_at DESC, id DESC)
      `,
      `
        CREATE TABLE IF NOT EXISTS gossip_cooldowns (
          team_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          last_gossiped_at INTEGER NOT NULL,
          PRIMARY KEY (team_id, channel_id, user_id)
        )
      `,
      `
        CREATE TABLE IF NOT EXISTS whitelisted_channels (
          team_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (team_id, channel_id)
        )
      `,
      `
        CREATE TABLE IF NOT EXISTS whitelisted_users (
          team_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (team_id, user_id)
        )
      `,
    ],
    "write",
  );
}

async function upsertInstall(input: {
  teamId: string;
  teamName: string | null;
  botUserId: string;
  botToken: string;
  scope: string;
  now: string;
}) {
  await db.execute({
    sql: `
      INSERT INTO slack_installs (team_id, team_name, bot_user_id, bot_token, scope, installed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(team_id) DO UPDATE SET
        team_name = excluded.team_name,
        bot_user_id = excluded.bot_user_id,
        bot_token = excluded.bot_token,
        scope = excluded.scope,
        updated_at = excluded.updated_at
    `,
    args: [input.teamId, input.teamName, input.botUserId, input.botToken, input.scope, input.now, input.now],
  });
}

async function getInstall(teamId: string) {
  const result = await db.execute({
    sql: `
      SELECT team_id, team_name, bot_user_id, bot_token, scope, installed_at, updated_at
      FROM slack_installs
      WHERE team_id = ?
      LIMIT 1
    `,
    args: [teamId],
  });

  const row = result.rows[0] as InstallRecord | undefined;
  return row ?? null;
}

async function listInstalls() {
  const result = await db.execute(`
    SELECT team_id, team_name, installed_at, updated_at
    FROM slack_installs
    ORDER BY updated_at DESC
  `);

  return result.rows as unknown as Array<Pick<InstallRecord, "team_id" | "team_name" | "installed_at" | "updated_at">>;
}

async function recordChannelMessage(input: {
  teamId: string;
  channelId: string;
  userId: string;
  text: string;
}) {
  const createdAt = Date.now();

  await db.batch(
    [
      {
        sql: `
          INSERT INTO gossip_history (team_id, channel_id, user_id, text, created_at)
          VALUES (?, ?, ?, ?, ?)
        `,
        args: [input.teamId, input.channelId, input.userId, input.text, createdAt],
      },
      {
        sql: `
          DELETE FROM gossip_history
          WHERE team_id = ?
            AND channel_id = ?
            AND id NOT IN (
              SELECT id
              FROM gossip_history
              WHERE team_id = ?
                AND channel_id = ?
              ORDER BY created_at DESC, id DESC
              LIMIT ?
            )
        `,
        args: [input.teamId, input.channelId, input.teamId, input.channelId, HISTORY_MAX],
      },
    ],
    "write",
  );
}

async function getChannelHistory(teamId: string, channelId: string) {
  const result = await db.execute({
    sql: `
      SELECT user_id, text
      FROM gossip_history
      WHERE team_id = ?
        AND channel_id = ?
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `,
    args: [teamId, channelId, HISTORY_MAX],
  });

  return result.rows as unknown as ChannelHistoryRecord[];
}

async function getLastGossipedAt(input: { teamId: string; channelId: string; userId: string }) {
  const result = await db.execute({
    sql: `
      SELECT last_gossiped_at
      FROM gossip_cooldowns
      WHERE team_id = ?
        AND channel_id = ?
        AND user_id = ?
      LIMIT 1
    `,
    args: [input.teamId, input.channelId, input.userId],
  });

  const row = result.rows[0] as GossipCooldownRecord | undefined;
  return row?.last_gossiped_at ?? null;
}

async function setLastGossipedAt(input: { teamId: string; channelId: string; userId: string; timestamp: number }) {
  await db.execute({
    sql: `
      INSERT INTO gossip_cooldowns (team_id, channel_id, user_id, last_gossiped_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(team_id, channel_id, user_id) DO UPDATE SET
        last_gossiped_at = excluded.last_gossiped_at
    `,
    args: [input.teamId, input.channelId, input.userId, input.timestamp],
  });
}

async function isChannelWhitelisted(teamId: string, channelId: string) {
  if (configuredChannelWhitelist.has(channelId)) return true;

  const dbCount = await countWhitelistedChannels(teamId);
  if (configuredChannelWhitelist.size === 0 && dbCount === 0) return true;

  return hasWhitelistedChannel(teamId, channelId);
}

async function countWhitelistedChannels(teamId: string) {
  const result = await db.execute({
    sql: `
      SELECT COUNT(*) AS count
      FROM whitelisted_channels
      WHERE team_id = ?
    `,
    args: [teamId],
  });

  const row = result.rows[0] as CountRecord | undefined;
  return Number(row?.count ?? 0);
}

async function hasWhitelistedChannel(teamId: string, channelId: string) {
  const result = await db.execute({
    sql: `
      SELECT 1 AS found
      FROM whitelisted_channels
      WHERE team_id = ?
        AND channel_id = ?
      LIMIT 1
    `,
    args: [teamId, channelId],
  });

  return result.rows.length > 0;
}

async function addWhitelistedChannel(teamId: string, channelId: string) {
  await db.execute({
    sql: `
      INSERT INTO whitelisted_channels (team_id, channel_id, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(team_id, channel_id) DO NOTHING
    `,
    args: [teamId, channelId, Date.now()],
  });
}

async function removeWhitelistedChannel(teamId: string, channelId: string) {
  await db.execute({
    sql: `
      DELETE FROM whitelisted_channels
      WHERE team_id = ?
        AND channel_id = ?
    `,
    args: [teamId, channelId],
  });
}

async function listWhitelistedUsers(teamId: string) {
  const result = await db.execute({
    sql: `
      SELECT user_id
      FROM whitelisted_users
      WHERE team_id = ?
      ORDER BY created_at ASC
    `,
    args: [teamId],
  });

  const dbUsers = (result.rows as unknown as WhitelistedUserRecord[]).map((row) => row.user_id);
  return Array.from(new Set([...configuredUserWhitelist, ...dbUsers]));
}

async function addWhitelistedUser(teamId: string, userId: string) {
  await db.execute({
    sql: `
      INSERT INTO whitelisted_users (team_id, user_id, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(team_id, user_id) DO NOTHING
    `,
    args: [teamId, userId, Date.now()],
  });
}

async function removeWhitelistedUser(teamId: string, userId: string) {
  await db.execute({
    sql: `
      DELETE FROM whitelisted_users
      WHERE team_id = ?
        AND user_id = ?
    `,
    args: [teamId, userId],
  });
}

function authorizeUrl() {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", slackClientId);
  url.searchParams.set("scope", botScopes.join(","));
  url.searchParams.set("redirect_uri", ensuredRedirectUri);
  url.searchParams.set("state", createState());
  return url.toString();
}

async function exchangeCodeForToken(code: string) {
  const body = new URLSearchParams({
    code,
    client_id: slackClientId,
    client_secret: slackClientSecret,
    redirect_uri: ensuredRedirectUri,
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

function slackCommandResponse(text: string) {
  return json({ response_type: "ephemeral", text });
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
  return new Response(
    `<!doctype html><html><body style="font-family: sans-serif; max-width: 720px; margin: 40px auto; line-height: 1.5">${body}</body></html>`,
    {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    },
  );
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

function fail(message: string): never {
  throw new Error(message);
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

type InstallRecord = {
  team_id: string;
  team_name: string | null;
  bot_user_id: string;
  bot_token: string;
  scope: string | null;
  installed_at: string;
  updated_at: string;
};

type ChannelHistoryRecord = {
  user_id: string;
  text: string;
};

type GossipCooldownRecord = {
  last_gossiped_at: number;
};

type WhitelistedUserRecord = {
  user_id: string;
};

type CountRecord = {
  count: number | string;
};
