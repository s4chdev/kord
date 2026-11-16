require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  SlashCommandBuilder,
  REST,
  Routes,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  AttachmentBuilder,
  Options
} = require('discord.js');
const { Shoukaku, Connectors, Constants } = require('shoukaku');
const { fetch: undiciFetch, Agent, setGlobalDispatcher } = require('undici');

// One shared keep-alive pool instead of undici's defaults: /play fans out to several
// metadata APIs at once and Spotify background resolve runs batches in parallel.
// The timeouts mean a hung third-party API can never stall a command or a track start.
setGlobalDispatcher(new Agent({
  connections: 64,
  pipelining: 1,
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 120_000,
  headersTimeout: 8_000,
  bodyTimeout: 10_000,
  connectTimeout: 5_000
}));
const { getTracks, getPreview } = require('spotify-url-info')(undiciFetch);
const { applyFilterPreset } = require('./lib/filters');
const { invalidateBackgroundResolves, clearUpcoming } = require('./lib/queue-music');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

const DISCORD_LOG_WEBHOOK_URL =
  process.env.LOG_WEBHOOK_URL || '';

// Make webhook logs readable for humans.
// - Only `warn` and `error` go to the webhook by default (less spam).
// - Repeats are deduped for a short window.
const WEBHOOK_ONLY_WARN_ERROR = process.env.LOG_WEBHOOK_ONLY_WARN_ERROR !== '0';
const WEBHOOK_DEDUPE_WINDOW_MS = Number(process.env.LOG_WEBHOOK_DEDUPE_WINDOW_MS || '10000'); // 10s
const WEBHOOK_MAX_DESC_CHARS = Number(process.env.LOG_WEBHOOK_MAX_DESC_CHARS || '3800');

function formatLogArg(arg, depth = 0) {
  if (arg === null || arg === undefined) return String(arg);
  if (typeof arg === 'string') return arg;
  if (typeof arg === 'number' || typeof arg === 'boolean' || typeof arg === 'bigint') return String(arg);
  if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack || ''}`.trim();
  if (depth > 2) return '[Object]';
  try {
    return JSON.stringify(arg, (k, v) => {
      if (typeof v === 'bigint') return String(v);
      if (v instanceof Error) {
        return { name: v.name, message: v.message, stack: v.stack };
      }
      return v;
    });
  } catch {
    return String(arg);
  }
}

const webhookDedupe = new Map(); // signature -> { ts, count }
const WEBHOOK_DEDUPE_MAX = 500;

/** Drop dedupe entries once their window has passed so the map cannot grow forever. */
function pruneWebhookDedupe(now) {
  if (webhookDedupe.size <= WEBHOOK_DEDUPE_MAX) return;
  for (const [sig, entry] of webhookDedupe) {
    if (now - entry.ts > WEBHOOK_DEDUPE_WINDOW_MS) webhookDedupe.delete(sig);
  }
  while (webhookDedupe.size > WEBHOOK_DEDUPE_MAX) {
    webhookDedupe.delete(webhookDedupe.keys().next().value);
  }
}

function toLogSummary(level, args) {
  const parts = [];
  let err = null;

  for (const a of args) {
    if (a instanceof Error) err = err || a;
    else if (typeof a === 'string') parts.push(a);
    else if (a && typeof a === 'object' && 'message' in a && typeof a.message === 'string') parts.push(a.message);
  }

  // Prefer Error message (less noisy than full JSON args)
  if (err) {
    parts.unshift(`${err.name}: ${err.message}`);
    const stack = err.stack ? String(err.stack) : '';
    const firstLines = stack.split('\n').slice(0, 6).join('\n').trim();
    if (firstLines && !firstLines.startsWith(parts[0])) parts.unshift(firstLines);
  }

  // Fallback to generic serialization
  if (parts.length === 0) {
    parts.push(args.map((a) => formatLogArg(a)).join(' ').trim() || '(empty log)');
  }

  let description = parts.join(' | ').replace(/\s+/g, ' ').trim();
  if (description.length > WEBHOOK_MAX_DESC_CHARS) {
    description = description.slice(0, WEBHOOK_MAX_DESC_CHARS - 1) + '…';
  }

  const title =
    level === 'error' ? 'Error' : level === 'warn' ? 'Warning' : 'Log';

  // Embed colors
  const color =
    level === 'error' ? 0xed4245 : level === 'warn' ? 0xffcc00 : 0x5865f2;

  return { title, description, color };
}

async function postLogToWebhook(level, args, originalConsole) {
  if (!DISCORD_LOG_WEBHOOK_URL) return;
  if (WEBHOOK_ONLY_WARN_ERROR && level === 'log') return;

  try {
    const { title, description, color } = toLogSummary(level, args);
    const signature = `${level}:${description}`.slice(0, 500);

    const now = Date.now();
    const prev = webhookDedupe.get(signature);
    if (prev && now - prev.ts <= WEBHOOK_DEDUPE_WINDOW_MS) {
      prev.count++;
      return; // drop duplicates during the window
    }
    webhookDedupe.set(signature, { ts: now, count: 1 });
    pruneWebhookDedupe(now);

    const count = prev?.count ? prev.count + 1 : 1;
    const footer = count > 1 ? ` (x${count})` : '';

    await undiciFetch(DISCORD_LOG_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [
          {
            title,
            description: `\`${new Date().toISOString()}\`\n${description}${footer}`,
            color,
            timestamp: new Date().toISOString()
          }
        ]
      })
    });
  } catch (e) {
    // Avoid recursion by only using original console object.
    try {
      originalConsole.error('Webhook log post failed:', e?.message || e);
    } catch {
      /* ignore */
    }
  }
}

function truncateText(s, max = 240) {
  const t = String(s ?? '');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function summarizeCommandOptions(interaction) {
  try {
    const data = interaction?.options?.data;
    if (!Array.isArray(data) || data.length === 0) return '';
    const pairs = [];
    for (const opt of data) {
      if (!opt || !opt.name) continue;
      if (Array.isArray(opt.options) && opt.options.length > 0) {
        for (const sub of opt.options) {
          if (!sub || !sub.name) continue;
          if (sub.value !== undefined) pairs.push(`${sub.name}=${truncateText(sub.value, 120)}`);
        }
      } else if (opt.value !== undefined) {
        pairs.push(`${opt.name}=${truncateText(opt.value, 120)}`);
      }
    }
    return pairs.slice(0, 8).join(', ');
  } catch {
    return '';
  }
}

async function postAuditEvent(interaction, action, details = '') {
  if (!DISCORD_LOG_WEBHOOK_URL) return;
  try {
    const userTag = interaction?.user?.tag || `${interaction?.user?.username || 'unknown-user'}`;
    const userId = interaction?.user?.id || 'unknown-id';
    const channelName = interaction?.channel?.name ? `#${interaction.channel.name}` : 'unknown-channel';

    const body = [
      `**User:** ${userTag} (\`${userId}\`)`,
      `**Channel:** ${truncateText(channelName, 80)}`,
      details ? `**Details:** ${truncateText(details, 900)}` : null
    ].filter(Boolean).join('\n');

    await undiciFetch(DISCORD_LOG_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [
          {
            title: `Command Audit: ${truncateText(action, 120)}`,
            description: body,
            color: 0x57f287,
            timestamp: new Date().toISOString()
          }
        ]
      })
    });
  } catch {
    // Keep audit logging best-effort only.
  }
}

async function postSystemAuditEvent(guildId, voiceChannelId, action, details = '') {
  if (!DISCORD_LOG_WEBHOOK_URL) return;
  try {
    const vcObj = voiceChannelId ? client.channels?.cache?.get?.(voiceChannelId) : null;
    const channelName = vcObj?.name ? `#${vcObj.name}` : voiceChannelId ? `voice:${voiceChannelId}` : 'unknown-channel';

    const body = [
      `**User:** System (\`system\`)`,
      `**Channel:** ${truncateText(channelName, 80)}`,
      details ? `**Details:** ${truncateText(details, 900)}` : null
    ].filter(Boolean).join('\n');

    await undiciFetch(DISCORD_LOG_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [
          {
            title: `System Audit: ${truncateText(action, 120)}`,
            description: body,
            color: 0x00c3ff,
            timestamp: new Date().toISOString()
          }
        ]
      })
    });
  } catch {
    /* best-effort only */
  }
}

const __originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
};

for (const level of ['log', 'warn', 'error']) {
  console[level] = (...args) => {
    __originalConsole[level](...args);
    void postLogToWebhook(level, args, __originalConsole);
  };
}

/** MusicBrainz asks for a descriptive User-Agent with contact. */
const MUSICBRAINZ_CONTACT = process.env.MUSICBRAINZ_CONTACT || 'https://github.com/';
const MUSICBRAINZ_UA = `Kord/1.0 (${MUSICBRAINZ_CONTACT})`;
const MUSICBRAINZ_COVERS_ENABLED =
  process.env.MUSICBRAINZ_COVER_ART !== '0' && process.env.MUSICBRAINZ_COVER_ART !== 'false';

let musicBrainzNextAllowedAt = 0;

async function throttleMusicBrainzOrg() {
  const now = Date.now();
  const wait = Math.max(0, musicBrainzNextAllowedAt - now);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  musicBrainzNextAllowedAt = Date.now() + 1100;
}

function thumbnailLooksLikeYouTubeOrMissing(thumb) {
  if (!thumb || typeof thumb !== 'string') return true;
  const u = thumb.toLowerCase();
  return (
    u.includes('ytimg.com') ||
    u.includes('googlevideo.com') ||
    u.includes('youtube.com') ||
    u.includes('youtu.be')
  );
}

/** iTunes Search returns small artwork URLs; bump to a larger size for embeds. */
function upscaleAppleITunesArtworkUrl(url) {
  if (!url || typeof url !== 'string') return url;
  return url
    .replace(/100x100bb/gi, '600x600bb')
    .replace(/200x200bb/gi, '600x600bb')
    .replace(/150x150bb/gi, '600x600bb')
    .replace(/100x100/g, '600x600');
}

/**
 * Cover art via Apple iTunes Search API (no key). Good for popular tracks; one request.
 */
async function fetchCoverArtUrlFromITunesSearch(title) {
  if (!MUSICBRAINZ_COVERS_ENABLED || !title || typeof title !== 'string') return null;
  const raw = sanitizeTrackTitle(title).trim().slice(0, 200);
  if (!raw) return null;
  try {
    const api = `https://itunes.apple.com/search?term=${encodeURIComponent(raw)}&entity=song&media=music&limit=1`;
    const res = await undiciFetch(api, { headers: { 'User-Agent': MUSICBRAINZ_UA } });
    if (!res.ok) return null;
    const data = await res.json();
    const hit = data.results && data.results[0];
    if (!hit || !hit.artworkUrl100) return null;
    return upscaleAppleITunesArtworkUrl(hit.artworkUrl100);
  } catch {
    return null;
  }
}

/**
 * Cover art via MusicBrainz (recording search) + Cover Art Archive release front image.
 * Fallback when iTunes Search does not find a match.
 */
async function fetchCoverArtUrlFromMusicBrainz(title) {
  if (!MUSICBRAINZ_COVERS_ENABLED || !title || typeof title !== 'string') return null;
  const raw = sanitizeTrackTitle(title).trim();
  if (!raw) return null;

  await throttleMusicBrainzOrg();
  let res;
  try {
    res = await undiciFetch(
      `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(raw)}&fmt=json&limit=5`,
      { headers: { 'User-Agent': MUSICBRAINZ_UA, Accept: 'application/json' } }
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let data;
  try {
    data = await res.json();
  } catch {
    return null;
  }
  const recordings = data.recordings;
  if (!Array.isArray(recordings) || recordings.length === 0) return null;

  let caaChecks = 0;
  const maxCaa = 8;

  for (const rec of recordings) {
    const releases = rec.releases;
    if (!Array.isArray(releases)) continue;
    for (const rel of releases) {
      if (caaChecks >= maxCaa) return null;
      const mbid = rel && rel.id;
      if (!mbid) continue;
      caaChecks++;

      try {
        const imgRes = await undiciFetch(`https://coverartarchive.org/release/${mbid}/front-500`, {
          method: 'GET',
          redirect: 'follow',
          headers: { 'User-Agent': MUSICBRAINZ_UA }
        });
        const ct = (imgRes.headers.get('content-type') || '').toLowerCase();
        const imageUrl = imgRes.ok && ct.startsWith('image/') ? imgRes.url : null;
        // We only need the URL; drop the image bytes instead of buffering ~500KB per release.
        await imgRes.body?.cancel().catch(() => {});
        if (imageUrl) return imageUrl;
      } catch {
        /* next release */
      }

      await new Promise((r) => setTimeout(r, 150));
    }
  }

  return null;
}

/**
 * Cover art lookups hit iTunes and (throttled) MusicBrainz/CAA, which is far too slow to sit on
 * the /play critical path. The fast iTunes lookup is raced against a short deadline so popular
 * tracks still get real art on the first embed; MusicBrainz fallback always runs in the
 * background. Every lookup is cached by title (hits and misses).
 */
const coverArtCache = new Map(); // lowercased title -> art URL | null
const COVER_ART_CACHE_MAX = 500;
const COVER_ART_FAST_LOOKUP_MS = 350;
const coverArtInFlight = new Map(); // lowercased title -> Promise
const pendingThumbEnrichment = new Map(); // track object -> Promise

function coverArtCacheKey(title) {
  return String(title || '').trim().toLowerCase();
}

function rememberCoverArt(key, art) {
  if (!key) return;
  if (coverArtCache.size >= COVER_ART_CACHE_MAX) {
    coverArtCache.delete(coverArtCache.keys().next().value);
  }
  coverArtCache.set(key, art ?? null);
}

/** iTunes-only lookup bounded by a deadline; never rejects. */
function lookupCoverArtFast(title) {
  return Promise.race([
    fetchCoverArtUrlFromITunesSearch(title).catch(() => null),
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), COVER_ART_FAST_LOOKUP_MS);
      t.unref?.();
    })
  ]);
}

function lookupCoverArtFull(title) {
  const key = coverArtCacheKey(title);
  if (!key) return Promise.resolve(null);
  if (coverArtCache.has(key)) return Promise.resolve(coverArtCache.get(key));
  let job = coverArtInFlight.get(key);
  if (!job) {
    job = (async () => {
      let art = await fetchCoverArtUrlFromITunesSearch(title);
      if (!art) art = await fetchCoverArtUrlFromMusicBrainz(title);
      rememberCoverArt(key, art);
      return art ?? null;
    })().finally(() => coverArtInFlight.delete(key));
    coverArtInFlight.set(key, job);
  }
  return job;
}

async function maybeEnrichTrackThumbWithMusicBrainz(track) {
  if (!track || !MUSICBRAINZ_COVERS_ENABLED) return track;
  if (!thumbnailLooksLikeYouTubeOrMissing(track.thumbnail)) return track;
  const art = await lookupCoverArtFull(track.title);
  if (art) track.thumbnail = art;
  return track;
}

/** Kick off full thumbnail enrichment without blocking the caller. */
function enrichTrackThumbInBackground(track) {
  if (!track || !MUSICBRAINZ_COVERS_ENABLED) return;
  if (!thumbnailLooksLikeYouTubeOrMissing(track.thumbnail)) return;
  if (pendingThumbEnrichment.has(track)) return;
  const job = maybeEnrichTrackThumbWithMusicBrainz(track)
    .catch(() => {})
    .finally(() => pendingThumbEnrichment.delete(track));
  pendingThumbEnrichment.set(track, job);
}

async function maybeEnrichLavalinkTracksThumbs(tracks) {
  if (!Array.isArray(tracks) || tracks.length !== 1) return tracks;
  const track = tracks[0];
  if (!track || !MUSICBRAINZ_COVERS_ENABLED) return tracks;
  if (!thumbnailLooksLikeYouTubeOrMissing(track.thumbnail)) return tracks;

  const key = coverArtCacheKey(track.title);
  if (coverArtCache.has(key)) {
    const cached = coverArtCache.get(key);
    if (cached) track.thumbnail = cached;
    return tracks;
  }

  const fast = await lookupCoverArtFast(track.title);
  if (fast) {
    track.thumbnail = fast;
    rememberCoverArt(key, fast);
  } else {
    enrichTrackThumbInBackground(track); // slow MusicBrainz/CAA fallback off the hot path
  }
  return tracks;
}

/** Remove the slash-command ack when playback will post “Now Playing” in-channel (avoids duplicate embeds). */
async function dismissPlayDeferIfPossible(interaction) {
  try {
    await interaction.deleteReply();
  } catch {
    /* ignore */
  }
}

/**
 * TCP probe so Lavalink is accepting connections before Shoukaku opens its WebSocket.
 * (Shoukaku connects on Discord `clientReady`; it must be constructed before login, so run this before `client.login`.)
 */
async function waitForLavalink(host = '127.0.0.1', port = 2333, retries = 20) {
  for (let i = 0; i < retries; i++) {
    const ok = await new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(2000);
      socket
        .once('connect', () => {
          socket.destroy();
          resolve(true);
        })
        .once('error', () => resolve(false))
        .once('timeout', () => resolve(false))
        .connect(port, host);
    });

    if (ok) {
      console.log('✅ Lavalink is reachable');
      return;
    }

    console.log(`⏳ Waiting for Lavalink... (${i + 1}/${retries})`);
    await new Promise((r) => setTimeout(r, 2000));
  }

  throw new Error('❌ Lavalink not reachable after retries');
}

// ─── Lavalink Nodes ──────────────────────────────────────────────
const LavalinkNodes = [{
  name: 'main',
  url: `${process.env.LAVALINK_HOST || 'localhost'}:${process.env.LAVALINK_PORT || '2333'}`,
  auth: process.env.LAVALINK_PASSWORD || 'youshallnotpass'
}];

// ─── Bot Client ───────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ],
  // This bot only needs guilds, voice states and the odd message send. Trimming the
  // default caches removes a lot of per-event work and RSS growth.
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 50,
    GuildMemberManager: { maxSize: 100, keepOverLimit: (m) => m.id === m.client.user?.id },
    PresenceManager: 0,
    ReactionManager: 0,
    ReactionUserManager: 0,
    GuildStickerManager: 0,
    GuildScheduledEventManager: 0,
    GuildInviteManager: 0,
    StageInstanceManager: 0,
    ThreadMemberManager: 0
  }),
  sweepers: {
    ...Options.DefaultSweeperSettings,
    messages: { interval: 300, lifetime: 600 }
  }
});

// ─── Shoukaku (Lavalink connector) ───────────────────────────────
const shoukaku = new Shoukaku(new Connectors.DiscordJS(client), LavalinkNodes, {
  moveOnDisconnect: false,
  reconnectTries: Infinity,
  reconnectInterval: 5000,
  resume: true,
  resumeTimeout: 60
});

function isLavalinkEngineReady() {
  const node = shoukaku.options.nodeResolver(shoukaku.nodes);
  return !!(node && node.state === Constants.State.CONNECTED);
}

/** One TCP wait + node reconnect / re-add per node name (Shoukaku has no `nodeDisconnect` on the manager; `close` is the real signal). */
const lavalinkRecoveryInFlight = new Map();
function scheduleLavalinkRecovery(nodeName, detail = '') {
  if (lavalinkRecoveryInFlight.get(nodeName)) return;
  lavalinkRecoveryInFlight.set(nodeName, true);
  void (async () => {
    try {
      const host = process.env.LAVALINK_HOST || '127.0.0.1';
      const port = Number(process.env.LAVALINK_PORT || '2333');
      console.log('🔁 Reconnecting to Lavalink...', detail);
      await waitForLavalink(host, port);

      let node = shoukaku.nodes.get(nodeName);
      if (!node) {
        for (const opt of LavalinkNodes) {
          if (!shoukaku.nodes.has(opt.name)) shoukaku.addNode(opt);
        }
      } else {
        await node.connect().catch(() => {});
      }

      if (isLavalinkEngineReady()) console.log('✅ Reconnected to Lavalink');
      else console.warn('⚠️ Lavalink TCP is up; node may still be connecting.');
    } catch (err) {
      console.error('❌ Failed to reconnect:', err);
    } finally {
      lavalinkRecoveryInFlight.delete(nodeName);
    }
  })();
}

shoukaku.on('ready', (name) => console.log(`✅ Lavalink node "${name}" connected`));
shoukaku.on('error', (name, error) => console.error(`❌ Lavalink error [${name}]:`, error));
shoukaku.on('close', (name, code, reason) => {
  console.warn(`⚠️ Lavalink node "${name}" closed [${code}]: ${reason}`);
  scheduleLavalinkRecovery(name, `[${code}] ${reason}`);
});
shoukaku.on('reconnecting', (name, left, interval) =>
  console.log(`🔄 Lavalink reconnecting [${name}] - ${left} tries left, every ${interval}s`)
);

// ─── Guild Config & Search Sessions ───────────────────────────────
const guildConfig = new Map(); // guildId -> { defaultVolume, autoplay, djRoleId }
const searchSessions = new Map(); // messageId -> { userId, tracks, at }
const favoritesSessions = new Map(); // messageId -> { userId, tracks, at }
const SESSION_TTL_MS = 30 * 60 * 1000; // select menus are useless after 30 min

/** Sessions are keyed by message id and were never removed on message delete - sweep instead. */
function pruneSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const map of [searchSessions, favoritesSessions]) {
    for (const [id, session] of map) {
      if (!session?.at || session.at < cutoff) map.delete(id);
    }
  }
}
setInterval(pruneSessions, 5 * 60 * 1000).unref?.();
/** guildId:userId -> [{ title, url, duration, thumbnail }] */
const userFavorites = new Map();
/** guildId -> Map(userId -> request count) */
const guildRequestCounts = new Map();
const LEADERBOARD_STORE_FILE = path.join(__dirname, 'leaderboard-counts.json');
let leaderboardSaveTimer = null;

function serializeLeaderboardCounts() {
  const out = {};
  for (const [guildId, userMap] of guildRequestCounts.entries()) {
    out[guildId] = Object.fromEntries(userMap.entries());
  }
  return out;
}

function loadLeaderboardCountsFromDisk() {
  try {
    if (!fs.existsSync(LEADERBOARD_STORE_FILE)) return;
    const raw = fs.readFileSync(LEADERBOARD_STORE_FILE, 'utf8');
    if (!raw || !raw.trim()) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;

    for (const [guildId, users] of Object.entries(parsed)) {
      if (!users || typeof users !== 'object') continue;
      const m = new Map();
      for (const [userId, count] of Object.entries(users)) {
        const n = Number(count);
        if (Number.isFinite(n) && n > 0) m.set(userId, Math.floor(n));
      }
      if (m.size > 0) guildRequestCounts.set(guildId, m);
    }
  } catch (e) {
    console.warn('Failed to load leaderboard counts:', e?.message || e);
  }
}

function persistLeaderboardCountsToDisk() {
  const payload = JSON.stringify(serializeLeaderboardCounts());
  fs.promises.writeFile(LEADERBOARD_STORE_FILE, payload, 'utf8').catch((e) => {
    console.warn('Failed to save leaderboard counts:', e?.message || e);
  });
}

function scheduleLeaderboardSave() {
  if (leaderboardSaveTimer) return;
  leaderboardSaveTimer = setTimeout(() => {
    leaderboardSaveTimer = null;
    persistLeaderboardCountsToDisk();
  }, 1000);
}

function resetLeaderboardForGuild(guildId) {
  if (!guildId) return false;
  const existed = guildRequestCounts.has(guildId);
  guildRequestCounts.delete(guildId);
  if (leaderboardSaveTimer) {
    clearTimeout(leaderboardSaveTimer);
    leaderboardSaveTimer = null;
  }
  persistLeaderboardCountsToDisk();
  return existed;
}

loadLeaderboardCountsFromDisk();

const MAX_FAVORITES_PER_USER = 25;

// ─── AI chat (OpenAI-compatible Chat Completions) ───────────────────
// works with any OpenAI-compatible provider (openai, groq, openrouter, together, ollama, lm studio, ...)
// GROQ_* names still work as a fallback for older .env files
const AI_API_KEY = process.env.AI_API_KEY || process.env.GROQ_API_KEY || '';
const AI_BASE_URL = (process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
const AI_MODEL = process.env.AI_MODEL || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

/**
 * Reasoning models may emit chain-of-thought inside XML-style think blocks
 * (opening and closing "think" tags). Users should only see the final answer.
 * Truncated replies often omit the closing tag - strip the whole tail in that case.
 */
function stripModelReasoning(text) {
  if (!text || typeof text !== 'string') return '';

  // Plain XML tags (DeepSeek-style reasoning); case variants seen in the wild
  const xmlPairs = [
    ['\u003cthink\u003e', '\u003c/think\u003e'],
    ['\u003cTHINK\u003e', '\u003c/THINK\u003e'],
    ['\u003cThink\u003e', '\u003c/Think\u003e'],
    ['\u003credacted_reasoning\u003e', '\u003c/redacted_reasoning\u003e']
  ];
  // Same tags wrapped in backticks (some providers echo markdown)
  const btPairs = [
    ['`\u003cthink\u003e`', '`\u003c/think\u003e`'],
    ['`\u003cTHINK\u003e`', '`\u003c/THINK\u003e`']
  ];

  let s = text.trim();

  const stripTaggedBlocks = (str, open, close) => {
    let out = str;
    let i = out.indexOf(open);
    while (i !== -1) {
      const j = out.indexOf(close, i + open.length);
      if (j !== -1) {
        out = out.slice(0, i) + out.slice(j + close.length);
        i = out.indexOf(open);
      } else {
        // Unclosed block (common when max_tokens cuts mid-reasoning): drop from open to EOF
        out = out.slice(0, i).trim();
        break;
      }
    }
    return out;
  };

  for (const [open, close] of xmlPairs) {
    s = stripTaggedBlocks(s, open, close);
  }
  for (const [open, close] of btPairs) {
    s = stripTaggedBlocks(s, open, close);
  }

  // Orphan closing tags only - keep text after the rightmost closing tag
  const orphanCloses = [
    '`\u003c/think\u003e`',
    '`\u003c/THINK\u003e`',
    '\u003c/think\u003e',
    '\u003c/THINK\u003e',
    '\u003c/redacted_reasoning\u003e'
  ];
  let bestEnd = -1;
  for (const close of orphanCloses) {
    const k = s.lastIndexOf(close);
    if (k !== -1 && k + close.length > bestEnd) bestEnd = k + close.length;
  }
  if (bestEnd !== -1) s = s.slice(bestEnd).trim();

  return s.trim();
}

/** OpenAI-style chat content can be a string or a parts array. */
function normalizeAssistantContent(raw) {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') return part.text;
          if (part.type === 'text' && typeof part.text === 'string') return part.text;
        }
        return '';
      })
      .join('');
  }
  return String(raw);
}

async function aiChat(messages, maxTokens = 512) {
  if (!AI_API_KEY) return null;
  try {
    const res = await undiciFetch(`${AI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages,
        max_tokens: maxTokens,
        temperature: 0.75
      })
    });
    if (!res.ok) {
      const t = await res.text();
      console.warn('AI chat API error:', res.status, t.slice(0, 300));
      return null;
    }
    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    // Prefer assistant `content`; ignore any separate reasoning field if present
    let raw = normalizeAssistantContent(msg?.content).trim();
    if (!raw) return null;
    const cleaned = stripModelReasoning(raw);
    return cleaned || null;
  } catch (e) {
    console.warn('AI chat request failed:', e.message || e);
    return null;
  }
}

function truncateForDiscord(s, max = 3900) {
  if (!s) return '';
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** Short playlist vibe blurb for /queue. */
// /queue is spammed; the same track list yields the same blurb. Cache by signature.
const queueBlurbCache = new Map(); // signature -> blurb
const QUEUE_BLURB_CACHE_MAX = 100;

async function aiQueuePlaylistBlurb(trackTitles) {
  const list = trackTitles.slice(0, 15).join('\n');
  const signature = list.toLowerCase();
  const cached = queueBlurbCache.get(signature);
  if (cached !== undefined) return cached;
  const out = await aiChat(
    [
      {
        role: 'system',
        content:
          'You are a friendly music host. Describe the vibe of a queue in exactly 2 short sentences. No bullet points, no song list. Do not include reasoning steps - only the 2 sentences.'
      },
      {
        role: 'user',
        content: `These tracks are queued (in order):\n${list}\n\nDescribe the overall mood and energy in 2 sentences.`
      }
    ],
    220
  );
  const blurb = out ? truncateForDiscord(out, 800) : null;
  if (blurb) {
    if (queueBlurbCache.size >= QUEUE_BLURB_CACHE_MAX) {
      queueBlurbCache.delete(queueBlurbCache.keys().next().value);
    }
    queueBlurbCache.set(signature, blurb);
  }
  return blurb;
}

/** Explain lyrics meaning / context for /explain. */
async function aiExplainLyrics({ title, artistHint, lyricsSnippet }) {
  const out = await aiChat(
    [
      {
        role: 'system',
        content:
          'You explain song lyrics: themes, emotion, cultural context if relevant. Be clear and respectful. Do not invent facts about the artist\'s private life. If lyrics are in another language, note that and explain generally. Do not output chain-of-thought - only the explanation.'
      },
      {
        role: 'user',
        content: `Song: ${title}${artistHint ? `\nArtist context: ${artistHint}` : ''}\n\nLyrics (may be partial):\n${lyricsSnippet}\n\nExplain what this song seems to be about and any notable imagery or meaning. Use markdown sparingly (bold ok). Keep under 3500 characters.`
      }
    ],
    1200
  );
  return out ? truncateForDiscord(out, 3900) : null;
}

// /lyrics and /explain both hit lrclib + lyrics.ovh for the same track, and /skip → /explain
// repeats the lookup. Cache by title (hits and misses) for the session.
const lyricsCache = new Map(); // lowercased title -> result | null
const LYRICS_CACHE_MAX = 100;

/** Fetch plain lyrics for a track title (shared by /lyrics and /explain). */
async function fetchLyricsForTrackTitle(trackTitle, { fresh = false } = {}) {
  const key = String(trackTitle || '').trim().toLowerCase();
  if (!fresh && lyricsCache.has(key)) return lyricsCache.get(key);

  const result = await fetchLyricsForTrackTitleUncached(trackTitle);
  if (key) {
    if (lyricsCache.size >= LYRICS_CACHE_MAX) {
      lyricsCache.delete(lyricsCache.keys().next().value);
    }
    lyricsCache.set(key, result);
  }
  return result;
}

async function fetchLyricsForTrackTitleUncached(trackTitle) {
  const query = trackTitle.replace(/\(.*?\)/g, '').trim();
  let fullLyrics = null;
  let title = trackTitle;
  let author = null;

  try {
    const url = `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`;
    const res = await undiciFetch(url);
    if (res.ok) {
      const data = await res.json();
      const list = Array.isArray(data) ? data : (Array.isArray(data?.value) ? data.value : []);
      if (list.length > 0 && list[0].plainLyrics) {
        fullLyrics = list[0].plainLyrics;
        title = list[0].trackName || title;
        author = list[0].artistName || author;
      }
    }
  } catch {}

  if (!fullLyrics) {
    try {
      const parts = query.split(/\s*[-–—]\s*/);
      const [artist, song] = parts.length >= 2
        ? [parts[0].trim(), parts.slice(1).join(' ').trim()]
        : ['', query];
      const url2 = artist
        ? `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(song)}`
        : `https://api.lyrics.ovh/v1/_/${encodeURIComponent(query)}`;
      const res2 = await undiciFetch(url2);
      if (res2.ok) {
        const data2 = await res2.json();
        if (data2 && data2.lyrics) {
          fullLyrics = data2.lyrics.trim();
          if (artist) author = author || artist;
        }
      }
    } catch {}
  }

  if (!fullLyrics) return null;
  return { fullLyrics, title, author };
}

function getConfig(guildId) {
  if (!guildConfig.has(guildId)) {
    guildConfig.set(guildId, {
      defaultVolume: 50,
      autoplay: false,
      djRoleId: null
    });
  }
  return guildConfig.get(guildId);
}

function memberHasRole(member, roleId) {
  if (!member || !roleId) return false;
  const roles = member.roles;
  if (!roles) return false;
  if (roles.cache && typeof roles.cache.has === 'function') {
    return roles.cache.has(roleId);
  }
  if (Array.isArray(roles)) {
    return roles.includes(roleId);
  }
  if (Array.isArray(roles?.ids)) {
    return roles.ids.includes(roleId);
  }
  return false;
}

function isDjAllowed(guildId, member) {
  const cfg = getConfig(guildId);
  if (!cfg.djRoleId) return true; // no DJ role configured -> unrestricted
  return memberHasRole(member, cfg.djRoleId);
}

async function denyDjOnly(interaction) {
  const payload = {
    embeds: [songEmbed('⛔ DJ Only', 'You need the configured DJ role to use this control.', 0xed4245)],
    flags: 64,
    ephemeral: true
  };
  if (interaction.isButton?.()) return interaction.reply(payload);
  if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
  return interaction.reply(payload);
}

function favoritesKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function getUserFavoritesList(guildId, userId) {
  const key = favoritesKey(guildId, userId);
  if (!userFavorites.has(key)) userFavorites.set(key, []);
  return userFavorites.get(key);
}

function addUserFavorite(guildId, userId, track) {
  if (!track?.url || typeof track.url !== 'string') return { ok: false, reason: 'nourl' };
  const list = getUserFavoritesList(guildId, userId);
  if (list.some((f) => f.url === track.url)) return { ok: false, reason: 'dup' };
  if (list.length >= MAX_FAVORITES_PER_USER) return { ok: false, reason: 'full' };
  list.push({
    title: track.title,
    url: track.url,
    duration: track.duration || '0:00',
    thumbnail: track.thumbnail || null
  });
  return { ok: true };
}

function recordRequestCount(guildId, userId, count = 1) {
  if (!guildId || !userId || count < 1) return;
  if (!guildRequestCounts.has(guildId)) guildRequestCounts.set(guildId, new Map());
  const m = guildRequestCounts.get(guildId);
  m.set(userId, (m.get(userId) || 0) + count);
  scheduleLeaderboardSave();
}

/** Splice/push with spread breaks down past ~100k args; rebuild the array instead. */
function insertTracksAfterCurrent(queue, tracks) {
  if (!tracks.length) return;
  if (queue.songs.length === 0) {
    queue.songs = tracks.slice();
  } else {
    queue.songs = [queue.songs[0], ...tracks, ...queue.songs.slice(1)];
  }
}

function placeTracksInQueue(queue, tracks, insertNext) {
  if (insertNext) {
    insertTracksAfterCurrent(queue, tracks);
  } else if (tracks.length > 500) {
    queue.songs = queue.songs.concat(tracks); // big playlists: avoid huge spread args
  } else {
    queue.songs.push(...tracks);
  }
}

function tagTracksForUser(tracks, mention, guildId, userId) {
  for (const t of tracks) {
    t.requestedBy = mention;
  }
  recordRequestCount(guildId, userId, tracks.length);
}

// ─── Slash Command Definitions ────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song or add it to the queue')
    .addStringOption(opt =>
      opt
        .setName('query')
        .setDescription('URL (YouTube, Spotify, SoundCloud, Deezer, Apple Music, Tidal, Bandcamp, …) or search text')
        .setRequired(true)
        .setAutocomplete(true)
    ),
  new SlashCommandBuilder()
    .setName('playnext')
    .setDescription('Add a song to play after the current track')
    .addStringOption(opt =>
      opt
        .setName('query')
        .setDescription('URL (YouTube, Spotify, SoundCloud, Deezer, Apple Music, Tidal, …) or search text')
        .setRequired(true)
        .setAutocomplete(true)
    ),
  new SlashCommandBuilder()
    .setName('skipto')
    .setDescription('Jump to a queue position (removes all tracks before it)')
    .addIntegerOption(opt =>
      opt
        .setName('position')
        .setDescription('1 = now playing, 2 = next, … (same numbering as /queue)')
        .setRequired(true)
        .setMinValue(1)
    ),
  new SlashCommandBuilder()
    .setName('favorite')
    .setDescription('Save the currently playing track to your favorites'),
  new SlashCommandBuilder()
    .setName('favorites')
    .setDescription('View your saved tracks and pick one to play'),
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Top music requesters in this server')
    .addIntegerOption(opt =>
      opt
        .setName('top')
        .setDescription('How many users to show (default: 10)')
        .setMinValue(3)
        .setMaxValue(25)
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('leaderboard_reset')
    .setDescription('Reset leaderboard stats for this server'),
  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the current song'),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop music, clear queue (stays in voice channel)'),
  new SlashCommandBuilder()
    .setName('disconnect')
    .setDescription('Disconnect from the voice channel (leave VC)'),
  new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause the current song'),
  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume the paused song'),
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the current song queue'),
  new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Show the currently playing song'),
  new SlashCommandBuilder()
    .setName('previous')
    .setDescription('Play the last song (from history)'),
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a song from the queue by position')
    .addIntegerOption(opt =>
      opt.setName('position').setDescription('Position in queue to remove (use /queue to see positions)').setRequired(true).setMinValue(1)
    ),
  new SlashCommandBuilder()
    .setName('shuffle')
    .setDescription('Shuffle the upcoming songs in the queue'),
  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set the playback volume')
    .addIntegerOption(opt =>
      opt.setName('level').setDescription('Volume level (0-100)').setRequired(true).setMinValue(0).setMaxValue(100)
    ),
  new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Set loop mode')
    .addStringOption(opt =>
      opt
        .setName('mode')
        .setDescription('Loop mode')
        .setRequired(true)
        .addChoices(
          { name: 'Off', value: 'off' },
          { name: 'Song', value: 'song' },
          { name: 'Queue', value: 'queue' }
        )
    ),
  new SlashCommandBuilder()
    .setName('filter')
    .setDescription('Apply an audio filter')
    .addStringOption(opt =>
      opt
        .setName('preset')
        .setDescription('Filter preset')
        .setRequired(true)
        .addChoices(
          { name: 'Off', value: 'off' },
          { name: 'Bassboost', value: 'bassboost' },
          { name: 'Nightcore', value: 'nightcore' },
          { name: 'Vaporwave', value: 'vaporwave' },
          { name: '8D', value: '8d' },
          { name: 'Karaoke', value: 'karaoke' },
          { name: 'Vibrato', value: 'vibrato' },
          { name: 'Tremolo', value: 'tremolo' },
          { name: 'Distortion', value: 'distortion' },
          { name: 'LoFi', value: 'lofi' },
          { name: 'Highpass', value: 'highpass' },
          { name: 'Slowed', value: 'slowed' },
          { name: 'Chipmunk', value: 'chipmunk' },
          { name: 'Mono', value: 'mono' },
          { name: 'Treble', value: 'treble' },
          { name: 'Deep', value: 'deep' },
          { name: 'Fast', value: 'fast' },
          { name: 'VocalBoost', value: 'vocalboost' },
          { name: 'Bass+Treble', value: 'basstreble' },
          { name: 'Radio', value: 'radio' },
          { name: 'Left', value: 'left' },
          { name: 'Right', value: 'right' }
        )
    ),
  new SlashCommandBuilder()
    .setName('clearqueue')
    .setDescription('Clear all upcoming songs, keeping the current one'),
  new SlashCommandBuilder()
    .setName('songinfo')
    .setDescription('Show detailed info about the current song'),
  new SlashCommandBuilder()
    .setName('songtrivia')
    .setDescription('Show a short trivia or fact about the current song or artist'),
  new SlashCommandBuilder()
    .setName('lyrics')
    .setDescription('Show lyrics for the current song'),
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask Kord anything')
    .addStringOption(opt =>
      opt.setName('question').setDescription('Your question').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('explain')
    .setDescription('Explain the meaning of the current song lyrics'),
  new SlashCommandBuilder()
    .setName('search')
    .setDescription('Search for a song and choose from results')
    .addStringOption(opt =>
      opt
        .setName('query')
        .setDescription('Search query')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('config')
    .setDescription('Configure bot settings for this server')
    .addIntegerOption(opt =>
      opt
        .setName('default_volume')
        .setDescription('Default volume for new sessions (0-100)')
        .setMinValue(0)
        .setMaxValue(100)
        .setRequired(false)
    )
    .addStringOption(opt =>
      opt
        .setName('autoplay')
        .setDescription('Automatically queue related songs when the queue ends')
        .addChoices(
          { name: 'On', value: 'on' },
          { name: 'Off', value: 'off' }
        )
        .setRequired(false)
    )
    .addRoleOption(opt =>
      opt
        .setName('dj_role')
        .setDescription('Role allowed to use DJ-only commands (stop, clearqueue, filters, volume)')
        .setRequired(false)
    )
].map(cmd => cmd.toJSON());

/** Authoritative slash-command list for /ask (keeps help in sync with registration). */
function getKordSlashCommandsReference() {
  return commands.map((c) => `• \`/${c.name}\` - ${c.description || ''}`).join('\n');
}

/** Ground-truth playback state for this guild (passed into /ask so the model isn't guessing). */
function formatPlaybackContextForAsk(queue) {
  if (!queue?.playing || !queue.songs?.length) {
    return 'No music is currently playing in this server (queue empty or not playing).';
  }
  const cur = queue.songs[0];
  const ahead = Math.max(0, queue.songs.length - 1);
  const paused = queue.player?.paused ? 'yes' : 'no';
  const parts = [
    `Now playing: "${cur.title}"`,
    cur.duration ? `Track duration: ${cur.duration}` : null,
    `Playback paused: ${paused}`,
    `Volume: ${queue.volume ?? 50}%`,
    `Loop mode: ${queue.loopMode || 'off'}`,
    ahead > 0 ? `Other tracks queued after this: ${ahead}` : 'No other tracks queued after this one.',
    `Requested by: ${cur.requestedBy || 'Unknown'}`,
    queue.filterPreset && queue.filterPreset !== 'off' ? `Audio filter: ${queue.filterPreset}` : null
  ];
  return parts.filter(Boolean).join('\n');
}

/** General Q&A for /ask. */
async function aiAskKord(question, playbackContext) {
  const cmdList = getKordSlashCommandsReference();
  const ctx =
    typeof playbackContext === 'string' && playbackContext.trim()
      ? playbackContext.trim()
      : 'Playback state for this server was not provided.';
  const out = await aiChat(
    [
      {
        role: 'system',
        content: `You are Kord, a Discord music bot assistant. Be concise, helpful, and warm. If asked for harmful or illegal things, refuse briefly. Max ~600 words unless the user asks for something shorter. Never include reasoning steps or meta-commentary - only your final reply to the user.

Do not name external AI vendors or model hosts in user-facing answers (refer to yourself as Kord or "this bot" if needed).

AI context: Sachdev Parihar (also known as \`s4chdev\`) is the full-stack developer who builds end-to-end systems and who built Kord (the bot). Kord is an AI music engine. When users ask "who is Sachdev / s4chdev" or "who built you", Kord should say that s4chdev built Kord (and optionally mention he’s a full-stack end-to-end systems builder).

When the user message includes a [Playback context] section, treat it as **accurate for this Discord server right now**. Use it to answer questions about the current song, queue, volume, loop, filters, or who requested the track. If nothing is playing, say so clearly.

IMPORTANT - What Kord actually supports:
- Kord uses **Discord slash commands only** (they start with \`/\`). Users type \`/\` in a channel and pick commands from the menu, or type \`/play\`, \`/queue\`, etc.
- There are **no** \`!\` prefix commands, no \`!play\` / \`!skip\` style text commands, and no DM-only command set for music control.
- If the user asks what you can do, how to use the bot, for a command list, or for "help", you MUST describe **only** the commands below. Do not copy command lists from other bots or from memory. Do not invent options or command names.

Official command list (names and purposes must match):
${cmdList}

Optional: mention that \`/config\` can set default volume, autoplay, and a DJ role that may restrict some moderation-style commands on busy servers.`
      },
      {
        role: 'user',
        content: `[Playback context - this server]\n${ctx}\n\n---\n\n${question}`
      }
    ],
    1024
  );
  return out ? truncateForDiscord(out, 3900) : null;
}

// ─── Per-Guild Queue Map ──────────────────────────────────────────
const queues = new Map();

function getQueue(guildId) {
  if (!queues.has(guildId)) {
    const cfg = getConfig(guildId);
    queues.set(guildId, {
      songs: [],          // { encoded, title, url, duration, durationMs, requestedBy }
      player: null,       // Shoukaku Player
      textChannel: null,
      playing: false,
      volume: cfg.defaultVolume ?? 50,
      disconnectTimer: null,
      loopMode: 'off',    // 'off' | 'song' | 'queue'
      filterPreset: 'off', // 'off' | 'bassboost' | 'nightcore' | 'vaporwave' | '8d' | 'karaoke' | 'vibrato' | 'tremolo' | 'distortion' | 'lofi' | 'highpass' | 'slowed' | 'chipmunk' | 'mono' | 'treble' | 'deep' | 'fast' | 'vocalboost' | 'basstreble' | 'radio' | 'left' | 'right'
      _appliedFilterPreset: null, // preset currently set on queue.player (null = unknown/needs apply)
      history: [], // previously played tracks (for /previous)
      _skipRequested: false,
      _noMoreSongsAnnounced: false, // prevents repeating the empty-queue announcement when queue stays empty
      _manualStop: false, // used by queue-empty logic to control auto-disconnect
      _skipAutoplay: false, // when true, don't smart-autoplay when queue is empty
      _pendingDisconnect: false, // when true, /disconnect will leave after the system audio ends
      _disconnectTrackEncoded: null, // Lavalink encoded track for the leave jingle (see player 'end' replaced/cleanup)
      _welcomePlayed: false // when true, don't play bot-welcome.mp3 again this session
    });
  }
  return queues.get(guildId);
}

// ─── Now Playing Button Controls ─────────────────────────────────────
function buildNowPlayingComponents(queue) {
  const isPaused = queue.player?.paused ?? false;

  const loopLabel =
    queue.loopMode === 'song' ? 'Song' :
    queue.loopMode === 'queue' ? 'Queue' :
    'Off';

  const loopStyle = queue.loopMode === 'off' ? ButtonStyle.Secondary : ButtonStyle.Success;

  const currentSong = queue.songs?.[0];
  const seekDisabled = !currentSong || !Number.isFinite(currentSong.durationMs) || currentSong.durationMs <= 0;

  const transportRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('music_playpause')
      .setLabel(isPaused ? 'Play' : 'Pause')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('music_skip')
      .setLabel('Skip')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('music_seek_back')
      .setLabel('-10s')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(seekDisabled),
    new ButtonBuilder()
      .setCustomId('music_seek_fwd')
      .setLabel('+10s')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(seekDisabled)
  );

  const settingsRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('music_vol_down')
      .setLabel('Vol -')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('music_volume')
      .setLabel(`${queue.volume}%`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId('music_vol_up')
      .setLabel('Vol +')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('music_stop')
      .setLabel('Stop')
      .setStyle(ButtonStyle.Danger)
  );

  return [transportRow, settingsRow];
}

// ─── Helper: get a Lavalink node ──────────────────────────────────
function getNode() {
  const node = shoukaku.options.nodeResolver(shoukaku.nodes);
  if (!node) throw new Error('No Lavalink nodes available. Is Lavalink running?');
  return node;
}

// ─── Helper: Embed Builder ────────────────────────────────────────
function songEmbed(title, description, color = 0x5865f2) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setTimestamp();
}

// ─── Safe send to text channel ────────────────────────────────────
async function safeSend(channel, payload) {
  try {
    if (channel && typeof channel.send === 'function') {
      await channel.send(payload);
    }
  } catch (err) {
    console.warn('Could not send message:', err.message);
  }
}

// ─── Format duration from milliseconds ────────────────────────────
function formatDuration(ms) {
  if (!ms || isNaN(ms)) return '0:00';
  const seconds = Math.round(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ─── Volume bar visual ───────────────────────────────────────────
function volumeBar(vol) {
  const filled = Math.round(vol / 10);
  return '▓'.repeat(filled) + '░'.repeat(10 - filled);
}

function seekBar(positionMs, durationMs, width = 20) {
  const d = Number(durationMs);
  const p = Number(positionMs);
  if (!Number.isFinite(d) || d <= 0) return null;
  const safePos = Math.min(Math.max(0, p), d);
  const filled = Math.round((safePos / d) * width);
  return '▓'.repeat(filled) + '░'.repeat(width - filled);
}

const SEEK_STEP_MS = 10_000;

function normalizeTrackSourceName(source) {
  const s = String(source || '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'yt' || s === 'youtube') return 'YouTube';
  if (s === 'soundcloud') return 'SoundCloud';
  if (s === 'http' || s === 'https') return 'HTTP Stream';
  if (s === 'local') return 'Local File';
  if (s === 'bandcamp') return 'Bandcamp';
  if (s === 'twitch') return 'Twitch';
  if (s === 'vimeo') return 'Vimeo';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function isLikelyDirectAudioOrStreamUrl(url) {
  if (!isURL(url)) return false;
  const t = String(url || '').trim().toLowerCase();
  return (
    /\.(mp3|m4a|aac|flac|ogg|opus|wav)(?:\?.*)?$/.test(t) ||
    /\.(m3u8|m3u|pls)(?:\?.*)?$/.test(t) ||
    /[?&](stream|radio|live)=/i.test(t)
  );
}

function sourceHintFromUrl(url) {
  if (!isURL(url)) return null;
  const t = String(url || '').trim().toLowerCase();
  if (t.includes('youtube.com') || t.includes('youtu.be')) return 'YouTube URL';
  if (t.includes('soundcloud.com')) return 'SoundCloud URL';
  if (t.includes('open.spotify.com') || t.includes('spotify.link')) return 'Spotify URL';
  if (/\.(m3u8|m3u|pls)(?:\?.*)?$/.test(t)) return 'Playlist Stream URL';
  if (/\.(mp3|m4a|aac|flac|ogg|opus|wav)(?:\?.*)?$/.test(t)) return 'Direct Audio URL';
  if (isLikelyDirectAudioOrStreamUrl(t)) return 'HTTP Stream URL';
  return 'Direct URL';
}

function trackSourceLine(track) {
  const src = track?.source;
  return src ? `Source: \`${src}\`` : null;
}

function buildNowPlayingEmbed(queue, { positionMsOverride } = {}) {
  const song = queue.songs?.[0];
  if (!song) return songEmbed('🎶 Now Playing', 'Nothing is playing right now.');

  const npDescription =
    `**[${song.title}](${song.url})**\n` +
    `Duration: \`${song.duration || '0:00'}\`\n` +
    `Volume: \`${volumeBar(queue.volume)} ${queue.volume}%\`\n` +
    `Requested by: ${song.requestedBy}`;

  const np = songEmbed('🎶 Now Playing', npDescription);
  return np;
}

// ─── Volume Debouncing ────────────────────────────────────────────
// Every `setGlobalVolume` makes Lavalink re-encode the stream; hammering Vol +/- stutters
// playback and burns CPU. Acknowledge each press instantly, then coalesce the RPC and the
// embed refresh into a single trailing update.
const VOLUME_APPLY_DEBOUNCE_MS = 250;
const volumeApplyTimers = new Map(); // guildId -> timeout handle
const volumeApplyInteraction = new Map(); // guildId -> most recent interaction

function queueVolumeChange(guildId, queue, volume, interaction) {
  queue.volume = volume; // optimistic: embeds/logic read this immediately
  volumeApplyInteraction.set(guildId, interaction);

  const existing = volumeApplyTimers.get(guildId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    volumeApplyTimers.delete(guildId);
    const latest = volumeApplyInteraction.get(guildId);
    volumeApplyInteraction.delete(guildId);
    void applyDebouncedVolume(guildId, queue, latest);
  }, VOLUME_APPLY_DEBOUNCE_MS);
  timer.unref?.();
  volumeApplyTimers.set(guildId, timer);
}

async function applyDebouncedVolume(guildId, queue, interaction) {
  if (queues.get(guildId) !== queue) return; // session was replaced

  if (queue.player) {
    try {
      await queue.player.setGlobalVolume(queue.volume);
    } catch (err) {
      console.warn('Volume apply failed:', err?.message || err);
    }
  }

  if (!interaction) return;
  try {
    await interaction.editReply({
      embeds: [buildNowPlayingEmbed(queue)],
      components: buildNowPlayingComponents(queue)
    });
  } catch {
    /* message may be gone or the token expired */
  }
}

// ─── URL helpers ──────────────────────────────────────────────────
/** True for http(s) URLs only (quiet on invalid input - same idea as `new URL` probes for /play). */
function isURL(str) {
  if (!str || typeof str !== 'string') return false;
  try {
    const url = new URL(str.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isSpotifyURL(str) {
  return str.includes('open.spotify.com/') || str.includes('spotify.link/');
}

function shouldExpandMusicRedirect(str) {
  try {
    const u = new URL(str.trim());
    const h = u.hostname.replace(/^www\./i, '').toLowerCase();
    // Common music short-link hosts that redirect to canonical service URLs.
    return (
      h === 'spotify.link' ||
      h === 'song.link' ||
      h === 'album.link' ||
      h === 'onelink.to' ||
      h === 'lnk.to' ||
      h === 'ffm.to' ||
      h === 'deezer.page.link' ||
      h === 'tidal.link' ||
      h === 'geo.music.apple.com'
    );
  } catch {
    return false;
  }
}

async function expandMusicRedirectUrl(url) {
  if (!shouldExpandMusicRedirect(url)) return url;
  try {
    const res = await undiciFetch(url, { method: 'GET', redirect: 'follow' });
    const finalUrl = res.url || url;
    await res.body?.cancel().catch(() => {}); // only the redirected URL matters
    return finalUrl;
  } catch {
    return url;
  }
}

/** YouTube Music and other hosts that Lavalink resolves better as standard YouTube/watch URLs. */
function normalizeStreamingUrl(str) {
  if (!str || typeof str !== 'string') return str;
  const t = str.trim();
  try {
    const u = new URL(t);
    if (u.hostname.includes('music.youtube.com')) {
      const v = u.searchParams.get('v');
      if (v) return `https://www.youtube.com/watch?v=${encodeURIComponent(v)}`;
    }
  } catch {
    return t;
  }
  return t;
}

function extractDeezerTrackIdFromPathOrString(str) {
  const m = str.match(/deezer\.com\/(?:[a-z]{2}\/)?track\/(\d+)/i);
  return m ? m[1] : null;
}

async function fetchDeezerTrackMetaForPlay(url) {
  if (!/\/\/(?:www\.)?deezer\.com|deezer\.page\.link/i.test(url)) return null;

  let resolved = url.trim();
  if (resolved.includes('deezer.page.link')) {
    try {
      const r = await undiciFetch(resolved, { method: 'GET', redirect: 'follow' });
      resolved = r.url || resolved;
      await r.body?.cancel().catch(() => {});
    } catch {
      return null;
    }
  }

  const id = extractDeezerTrackIdFromPathOrString(resolved);
  if (!id) return null;

  try {
    const r = await undiciFetch(`https://api.deezer.com/track/${id}`);
    if (!r.ok) return null;
    const d = await r.json();
    if (d.error || !d.title) return null;
    const artist = (d.artist && d.artist.name) || '';
    const searchQuery = `${artist} ${d.title}`.trim();
    const thumbnail =
      d.album?.cover_big ||
      d.album?.cover_xl ||
      d.album?.cover_medium ||
      d.album?.cover_small ||
      d.album?.cover ||
      null;
    return {
      searchQuery,
      displayTitle: formatTrackTitle(`${artist ? `${artist} - ` : ''}${d.title}`),
      thumbnail
    };
  } catch {
    return null;
  }
}

function extractAppleMusicTrackId(urlStr) {
  try {
    const u = new URL(urlStr.trim());
    const h = u.hostname.replace(/^www\./, '');
    if (h !== 'music.apple.com' && h !== 'itunes.apple.com') return null;
    const i = u.searchParams.get('i');
    if (i && /^\d+$/.test(i)) return i;
    const songPath = u.pathname.match(/\/song\/[^/]+\/(\d+)/i);
    if (songPath) return songPath[1];
  } catch {
    return null;
  }
  return null;
}

async function fetchAppleMusicTrackMetaForPlay(url) {
  if (!/\/\/(?:music|itunes)\.apple\.com/i.test(url)) return null;
  const id = extractAppleMusicTrackId(url);
  if (!id) return null;
  try {
    const r = await undiciFetch(`https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}&entity=song`);
    if (!r.ok) return null;
    const d = await r.json();
    const item =
      (d.results && d.results.find((x) => x.wrapperType === 'track' || x.kind === 'song')) ||
      (d.results && d.results[0]);
    if (!item || !item.trackName) return null;
    const artist = item.artistName || '';
    const searchQuery = `${artist} ${item.trackName}`.trim();
    const thumbnail =
      item.artworkUrl600 ||
      item.artworkUrl100 ||
      item.artworkUrl60 ||
      null;
    return {
      searchQuery,
      displayTitle: formatTrackTitle(`${artist ? `${artist} - ` : ''}${item.trackName}`),
      thumbnail
    };
  } catch {
    return null;
  }
}

function decodeHtmlEntities(str) {
  if (!str || typeof str !== 'string') return str;
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

async function fetchJioSaavnTrackMetaForPlay(url) {
  if (!/\/\/(?:www\.)?(?:jiosaavn\.com|saavn\.com)\//i.test(url)) return null;
  try {
    const res = await undiciFetch(url.trim(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      }
    });
    if (!res.ok) return null;
    const html = await res.text();
    if (!html || typeof html !== 'string') return null;

    // Prefer JSON-LD for cleaner metadata.
    let title = null;
    let artist = '';
    let thumbnail = null;
    const ld = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
    if (ld && ld[1]) {
      try {
        const obj = JSON.parse(ld[1].trim());
        const item = Array.isArray(obj) ? obj[0] : obj;
        title = item?.name || item?.headline || title;
        if (typeof item?.image === 'string') thumbnail = item.image;
        else if (Array.isArray(item?.image) && typeof item.image[0] === 'string') thumbnail = item.image[0];
        if (typeof item?.byArtist?.name === 'string') artist = item.byArtist.name;
        else if (Array.isArray(item?.byArtist) && item.byArtist[0]?.name) artist = item.byArtist[0].name;
      } catch {
        // fall through to meta tags
      }
    }

    if (!title) {
      const ogTitle = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
      if (ogTitle && ogTitle[1]) title = decodeHtmlEntities(ogTitle[1]);
    }

    const artistMeta = html.match(/<meta[^>]*(?:name|property)=["']music:song:musician["'][^>]*content=["']([^"']+)["']/i);
    if (!artist && artistMeta && artistMeta[1]) artist = decodeHtmlEntities(artistMeta[1]);

    if (!thumbnail) {
      const ogImage = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
      if (ogImage && ogImage[1]) thumbnail = ogImage[1];
    }

    if (!title) return null;

    // JioSaavn pages sometimes include "song name - JioSaavn"; keep only the title part.
    const cleanedTitle = decodeHtmlEntities(title).replace(/\s*[-|]\s*JioSaavn.*$/i, '').trim();
    const cleanedArtist = decodeHtmlEntities(artist).trim();
    const searchQuery = `${cleanedArtist} ${cleanedTitle}`.trim();
    if (!searchQuery) return null;

    return {
      searchQuery,
      displayTitle: formatTrackTitle(`${cleanedArtist ? `${cleanedArtist} - ` : ''}${cleanedTitle}`),
      thumbnail
    };
  } catch {
    return null;
  }
}

/** Song.link resolves many share URLs (Tidal, Bandcamp, Amazon Music, etc.) to title/artist - then we YouTube-search. */
async function fetchSongLinkTrackMetaForPlay(url) {
  try {
    const u = new URL(url.trim());
    const h = u.hostname.replace(/^www\./, '');
    if (
      h.includes('youtube.com') ||
      h === 'youtu.be' ||
      h.includes('googlevideo.com') ||
      h.includes('open.spotify.com') ||
      h.includes('spotify.link') ||
      h.includes('deezer.com') ||
      h.includes('deezer.page.link') ||
      h === 'music.apple.com' ||
      h === 'itunes.apple.com'
    ) {
      return null;
    }
  } catch {
    return null;
  }

  try {
    const api = `https://api.song.link/v1-alpha.1/links?userCountry=US&url=${encodeURIComponent(url.trim())}`;
    const r = await undiciFetch(api);
    if (!r.ok) return null;
    const d = await r.json();
    const entities = d.entitiesByUniqueId;
    if (!entities || typeof entities !== 'object') return null;
    for (const e of Object.values(entities)) {
      if (!e || typeof e !== 'object') continue;
      if (e.type !== 'song' && e.type !== 'song_chord') continue;
      const title = e.title;
      if (!title || typeof title !== 'string') continue;
      const artist = (typeof e.artistName === 'string' && e.artistName) || '';
      const searchQuery = `${artist} ${title}`.trim();
      const thumbnail =
        (typeof e.image === 'string' && e.image) ||
        (e.image && typeof e.image.url === 'string' && e.image.url) ||
        (typeof e.coverArt === 'string' && e.coverArt) ||
        (e.coverArt && typeof e.coverArt.url === 'string' && e.coverArt.url) ||
        (Array.isArray(e.links)
          ? e.links.find((l) => l && l.type === 'image' && typeof l.url === 'string')?.url
          : null) ||
        null;
      return {
        searchQuery,
        displayTitle: formatTrackTitle(`${artist ? `${artist} - ` : ''}${title}`),
        thumbnail
      };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Discord can't set thumbnail aspect ratio. Proxying through wsrv.nl crops to a square
 * so album/video art looks balanced in the embed (especially 16:9 YouTube thumbs).
 */
function squareEmbedThumbnailUrl(url) {
  if (!url || typeof url !== 'string') return url;
  const t = url.trim();
  if (!/^https?:\/\//i.test(t)) return url;
  try {
    return `https://images.weserv.nl/?url=${encodeURIComponent(t)}&w=400&h=400&fit=cover&output=webp`;
  } catch {
    return url;
  }
}

/**
 * Remove YouTube-style clutter from titles (e.g. "(Full Video)", "(Official Video)").
 * One combined regex replaces 23 sequential passes; this runs for every track in a playlist.
 */
const TITLE_FLUFF_RE = new RegExp(
  '\\(\\s*(?:full\\s*video|official\\s*video|official\\s*music\\s*video|official\\s*audio|' +
  'lyric\\s*video|lyrics|audio\\s*only|audio|m\\/v|mv|hd|4k|8k|1080p|remastered|visualizer|' +
  'clip\\s*officiel)\\s*\\)' +
  '|\\[\\s*(?:full\\s*video|official\\s*video|official\\s*music\\s*video|official\\s*audio|' +
  'lyric\\s*video|lyrics|audio\\s*only|audio)\\s*\\]',
  'gi'
);

function sanitizeTrackTitle(title) {
  if (!title || typeof title !== 'string') return title;
  return title.replace(TITLE_FLUFF_RE, ' ').replace(/\s{2,}/g, ' ').trim();
}

const TITLE_TRUNCATE_SUFFIX = '.....';

const MAX_TRACK_TITLE_LEN = Math.min(
  200,
  Math.max(20, Number.parseInt(process.env.MAX_TRACK_TITLE_LENGTH || '50', 10) || 50)
);

function shortenTrackTitle(title, maxChars = MAX_TRACK_TITLE_LEN) {
  if (!title || typeof title !== 'string') return title;
  const t = title.trim();
  const suf = TITLE_TRUNCATE_SUFFIX;
  if (t.length <= maxChars) return t;
  const keep = Math.max(1, maxChars - suf.length);
  return `${t.slice(0, keep)}${suf}`;
}

/** Sanitize + cap length for queue / embed display. */
function formatTrackTitle(title) {
  if (!title || typeof title !== 'string') return title;
  return shortenTrackTitle(sanitizeTrackTitle(title));
}

// ─── Lavalink Track Resolution ────────────────────────────────────
function pickLavalinkThumb(info) {
  return info?.artworkUrl || info?.artworkURL || info?.thumbnail || null;
}

/** Raw Lavalink /loadtracks mapping + load type for user-facing errors (LOAD_FAILED / NO_MATCHES). */
// Text searches are the most expensive Lavalink calls (YouTube round-trip). Repeating the
// same query within a few minutes is common (autocomplete picks, /play retries).
const searchCache = new Map(); // identifier -> { at, detail }
const SEARCH_CACHE_MAX = 200;
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Callers mutate the returned track objects (`requestedBy`, `thumbnail`, titles), so every
 * cache hit hands out fresh copies - otherwise two users playing the same query would
 * stamp over each other's queue entries.
 */
function cloneTracks(list) {
  return Array.isArray(list) ? list.map((t) => ({ ...t })) : list;
}

async function resolveIdentifierDetailed(identifier) {
  const cacheable = typeof identifier === 'string' && /^(ytsearch|scsearch):/i.test(identifier);
  if (cacheable) {
    const hit = searchCache.get(identifier);
    if (hit && Date.now() - hit.at < SEARCH_CACHE_TTL_MS) {
      return { ...hit.detail, tracks: cloneTracks(hit.detail.tracks) };
    }
    if (hit) searchCache.delete(identifier);
  }

  const detail = await resolveIdentifierDetailedUncached(identifier);

  if (cacheable && detail.tracks?.length) {
    if (searchCache.size >= SEARCH_CACHE_MAX) {
      searchCache.delete(searchCache.keys().next().value);
    }
    // Store a private copy so later mutation of the caller's tracks cannot corrupt the cache.
    searchCache.set(identifier, { at: Date.now(), detail: { ...detail, tracks: cloneTracks(detail.tracks) } });
  }
  return detail;
}

async function resolveIdentifierDetailedUncached(identifier) {
  const node = getNode();
  const result = await node.rest.resolve(identifier);
  if (!result) {
    return { tracks: null, loadType: null, loadIssue: 'NO_MATCHES' };
  }
  if (result.loadType === 'error') {
    return { tracks: null, loadType: 'error', loadIssue: 'LOAD_FAILED', exception: result.data };
  }
  if (result.loadType === 'empty') {
    return { tracks: null, loadType: 'empty', loadIssue: 'NO_MATCHES' };
  }

  if (result.loadType === 'track') {
    const d = result.data;
    return {
      tracks: [{
        encoded: d.encoded,
        title: formatTrackTitle(d.info.title),
        url: d.info.uri,
        duration: formatDuration(d.info.length),
        durationMs: d.info.length,
        source: normalizeTrackSourceName(d.info.sourceName),
        thumbnail: pickLavalinkThumb(d.info)
      }],
      loadType: 'track',
      loadIssue: null
    };
  }

  if (result.loadType === 'playlist') {
    const tracks = result.data.tracks.map((t) => ({
      encoded: t.encoded,
      title: formatTrackTitle(t.info.title),
      url: t.info.uri,
      duration: formatDuration(t.info.length),
      durationMs: t.info.length,
      source: normalizeTrackSourceName(t.info.sourceName),
      thumbnail: pickLavalinkThumb(t.info)
    }));
    return { tracks, loadType: 'playlist', loadIssue: null };
  }

  if (result.loadType === 'search') {
    if (!Array.isArray(result.data) || result.data.length === 0) {
      return { tracks: null, loadType: 'search', loadIssue: 'NO_MATCHES' };
    }
    const t = result.data[0];
    return {
      tracks: [{
        encoded: t.encoded,
        title: formatTrackTitle(t.info.title),
        url: t.info.uri,
        duration: formatDuration(t.info.length),
        durationMs: t.info.length,
        source: normalizeTrackSourceName(t.info.sourceName),
        thumbnail: pickLavalinkThumb(t.info)
      }],
      loadType: 'search',
      loadIssue: null
    };
  }

  return { tracks: null, loadType: result.loadType, loadIssue: 'NO_MATCHES' };
}

async function resolveIdentifier(identifier) {
  const d = await resolveIdentifierDetailed(identifier);
  return d.tracks && d.tracks.length > 0 ? d.tracks : null;
}

// Dedicated YouTube search for interactive /search
async function searchYouTubeTracks(query, limit = 5) {
  const node = getNode();
  const result = await node.rest.resolve(`ytsearch:${query}`);
  if (!result || result.loadType !== 'search' || !Array.isArray(result.data) || result.data.length === 0) {
    return [];
  }

  return result.data.slice(0, limit).map((t) => ({
    encoded: t.encoded,
    title: formatTrackTitle(t.info.title),
    url: t.info.uri,
    duration: formatDuration(t.info.length),
    durationMs: t.info.length,
    source: normalizeTrackSourceName(t.info.sourceName),
    thumbnail: pickLavalinkThumb(t.info)
  }));
}

// ─── Spotify helpers ──────────────────────────────────────────────

async function getSpotifyTracks(url) {
  try {
    const tracks = await getTracks(url);
    return tracks.map(track => ({
      title: formatTrackTitle(`${track.artist} - ${track.name}`),
      searchQuery: `${track.artist} ${track.name}`,
      duration: formatDuration(track.duration || 0),
      durationMs: track.duration || 0,
      spotifyUrl: track.external_urls?.spotify || url,
      thumbnail:
        track.album?.images?.[0]?.url ||
        track.album?.images?.[0]?.imageUrl ||
        track.album?.imageUrl ||
        track.album?.image ||
        track.album?.coverUrl ||
        track.album?.cover ||
        null
    }));
  } catch (err) {
    // Fallback: try getPreview for single tracks
    try {
      const preview = await getPreview(url);
      return [{
        title: formatTrackTitle(`${preview.artist} - ${preview.title}`),
        searchQuery: `${preview.artist} ${preview.title}`,
        duration: '0:00',
        durationMs: 0,
        spotifyUrl: preview.link || url
      }];
    } catch {
      throw new Error('Could not get Spotify track info. Make sure the URL is valid.');
    }
  }
}

async function resolveSpotifyTrack(track) {
  const results = await resolveIdentifier(`ytsearch:${track.searchQuery}`);
  if (!results || results.length === 0) {
    throw new Error(`Could not find: ${track.title}`);
  }
  const out = {
    ...results[0],
    title: formatTrackTitle(track.title), // Spotify title for display (cleaned + shortened)
    // Prefer Spotify cover art when we have it; otherwise keep Lavalink's thumbnail.
    thumbnail: track.thumbnail || results[0].thumbnail || null,
    source: 'Spotify (via YouTube)'
  };
  enrichTrackThumbInBackground(out);
  return out;
}

async function resolvePlayQuery(query, interactionForSpotifyLoading = null) {
  // Expand common short links first (e.g. song.link/lnk.to/onelink/tidal.link).
  let q = query;
  if (isURL(q)) {
    q = await expandMusicRedirectUrl(q);
  }

  // Expanded links may now become a canonical Spotify URL.
  if (isSpotifyURL(q)) {
    if (interactionForSpotifyLoading) {
      await interactionForSpotifyLoading.editReply({ embeds: [songEmbed('🎵 Spotify', '⏳ Fetching Spotify tracks...', 0x1db954)] });
    }
    const spotifyTracks = await getSpotifyTracks(q);
    return { kind: 'spotify', spotifyTracks };
  }
  if (isURL(q)) {
    const normalized = normalizeStreamingUrl(q);
    const sourceHint = sourceHintFromUrl(normalized);
    const directStreamLike = isLikelyDirectAudioOrStreamUrl(normalized);
    let detailed = await resolveIdentifierDetailed(normalized);
    if (detailed.tracks?.length) {
      await maybeEnrichLavalinkTracksThumbs(detailed.tracks);
      detailed.tracks.forEach((t) => {
        if (!t.source && sourceHint) t.source = sourceHint;
      });
      return {
        kind: 'lavalink',
        tracks: detailed.tracks,
        loadIssue: null,
        sourceHint,
        directStreamLike
      };
    }

    const meta =
      (await fetchDeezerTrackMetaForPlay(normalized)) ||
      (await fetchAppleMusicTrackMetaForPlay(normalized)) ||
      (await fetchJioSaavnTrackMetaForPlay(normalized)) ||
      (await fetchSongLinkTrackMetaForPlay(normalized));

    if (meta && meta.searchQuery) {
      detailed = await resolveIdentifierDetailed(`ytsearch:${meta.searchQuery}`);
      const tracks = detailed.tracks;
      if (tracks && tracks.length > 0 && meta.displayTitle) {
        tracks[0].title = meta.displayTitle;
        if (meta.thumbnail) tracks[0].thumbnail = meta.thumbnail;
      }
      await maybeEnrichLavalinkTracksThumbs(tracks || []);
      if (tracks?.[0]) {
        tracks[0].source = tracks[0].source || sourceHint || 'URL (via YouTube search)';
      }
      return {
        kind: 'lavalink',
        tracks: tracks || [],
        loadIssue: tracks?.length ? null : (detailed.loadIssue || 'NO_MATCHES'),
        sourceHint,
        directStreamLike
      };
    }

    detailed = await resolveIdentifierDetailed(q);
    await maybeEnrichLavalinkTracksThumbs(detailed.tracks || []);
    (detailed.tracks || []).forEach((t) => {
      if (!t.source && sourceHint) t.source = sourceHint;
    });
    return {
      kind: 'lavalink',
      tracks: detailed.tracks || [],
      loadIssue: detailed.tracks?.length ? null : (detailed.loadIssue || 'NO_MATCHES'),
      sourceHint,
      directStreamLike
    };
  }

  let detailed = await resolveIdentifierDetailed(`ytsearch:${query}`);
  if (!detailed.tracks?.length) {
    detailed = await resolveIdentifierDetailed(`scsearch:${query}`);
  }
  const tracks = detailed.tracks || [];
  await maybeEnrichLavalinkTracksThumbs(tracks);
  return {
    kind: 'lavalink',
    tracks,
    loadIssue: tracks.length ? null : (detailed.loadIssue || 'NO_MATCHES')
  };
}

/**
 * /play & /playnext - same shape as typical Lavalink-manager bots (query → ytsearch for text, node check), using Shoukaku + this queue.
 * Defer first, then editReply for all outcomes (avoids reply/defer mismatch and noisy follow-up errors).
 */
async function handlePlay(interaction, { guild, insertNext }) {
  await interaction.deferReply();

  const safeEdit = async (payload) => {
    try {
      await interaction.editReply(payload);
    } catch {
      /* Webhook token expired or interaction already finalized */
    }
  };

  if (!interaction.member?.voice?.channel) {
    return safeEdit({ content: '❌ You must be in a voice channel.' });
  }

  const voiceChannel = interaction.member.voice.channel;

  const query = interaction.options.getString('query')?.trim() ?? '';
  if (!query) {
    return safeEdit({ content: '❌ Provide a song name or URL.' });
  }

  if (!isLavalinkEngineReady()) {
    return safeEdit({ content: '⚠️ Music server not ready. Try again in a few seconds.' });
  }

  const queue = getQueue(guild.id);
  queue.textChannel = interaction.channel;

  try {
    const resolved = await resolvePlayQuery(query, interaction);
    await handlePlayQueryResolution(resolved, query, interaction, guild, voiceChannel, queue, insertNext);
  } catch (err) {
    console.error('Search error:', err?.message || err);
    await safeEdit({ content: '❌ Failed to search. Try again.' });
  }
}

async function handlePlayQueryResolution(resolved, query, interaction, guild, voiceChannel, queue, insertNext) {
  const mention = interaction.user.toString();
  const uid = interaction.user.id;

  if (resolved.kind === 'spotify') {
    const spotifyTracks = resolved.spotifyTracks;
    if (!spotifyTracks || spotifyTracks.length === 0) {
      await interaction.editReply({ embeds: [songEmbed('❌ Error', 'No Spotify tracks found for that link.', 0xed4245)] });
      return;
    }
    if (spotifyTracks.length === 1) {
      const r = await resolveSpotifyTrack(spotifyTracks[0]);
      tagTracksForUser([r], mention, guild.id, uid);
      placeTracksInQueue(queue, [r], insertNext);
      if (!queue.playing) {
        await connectToVoice(queue, voiceChannel, guild.id);
        await playSong(guild.id);
        await dismissPlayDeferIfPossible(interaction);
      } else {
        const sourceLine = trackSourceLine(r);
        const sub = insertNext
          ? `**Queued to play next.**${sourceLine ? `\n${sourceLine}` : ''}`
          : `Duration: \`${r.duration}\`\nPosition: \`#${queue.songs.length}\`${sourceLine ? `\n${sourceLine}` : ''}`;
        const emb = songEmbed('✅ Added to Queue', `**[${r.title}](${r.url})**\n${sub}`);
        if (r.thumbnail) emb.setThumbnail(squareEmbedThumbnailUrl(r.thumbnail));
        await interaction.editReply({ embeds: [emb] });
      }
      return;
    }
    const firstTrack = spotifyTracks[0];
    const remaining = spotifyTracks.slice(1);
    const firstResolved = await resolveSpotifyTrack(firstTrack);
    tagTracksForUser([firstResolved], mention, guild.id, uid);
    placeTracksInQueue(queue, [firstResolved], insertNext);

    await interaction.editReply({
      embeds: [songEmbed('🎵 Spotify', `Playing now - resolving **${remaining.length}** more tracks in the background...`, 0x1db954)]
    });

    if (!queue.playing) {
      await connectToVoice(queue, voiceChannel, guild.id);
      playSong(guild.id);
    }

    resolveSpotifyInBackground(remaining, queue, guild.id, mention, uid, { insertNext }).catch((err) => {
      console.error('Background Spotify resolve error:', err.message);
    });
    return;
  }

  if (resolved.kind === 'lavalink') {
    if (resolved.loadIssue === 'LOAD_FAILED') {
      const msg = resolved.directStreamLike
        ? '❌ Could not open that stream URL. Make sure it is a direct audio/stream link and publicly reachable.'
        : '❌ Failed to load track.';
      await interaction.editReply({ content: msg });
      return;
    }
    if (resolved.loadIssue === 'NO_MATCHES' && (!resolved.tracks || resolved.tracks.length === 0)) {
      const msg = resolved.directStreamLike
        ? '❌ No playable stream found at that URL.'
        : '❌ No matches found.';
      await interaction.editReply({ content: msg });
      return;
    }
  }

  const tracks = resolved.tracks;
  if (!tracks || tracks.length === 0) {
    await interaction.editReply({
      content:
        isURL(query) && resolved?.directStreamLike
          ? '❌ Could not load that stream URL.'
          : (isURL(query) ? '❌ Failed to load track.' : '❌ No results found.')
    });
    return;
  }

  if (tracks.length === 1) {
    tagTracksForUser(tracks, mention, guild.id, uid);
    placeTracksInQueue(queue, tracks, insertNext);
    if (!queue.playing) {
      await connectToVoice(queue, voiceChannel, guild.id);
      await playSong(guild.id);
      await dismissPlayDeferIfPossible(interaction);
    } else {
      const sourceLine = trackSourceLine(tracks[0]);
      const sub = insertNext
        ? '**Queued to play next.**'
        : `Duration: \`${tracks[0].duration}\`\nPosition: \`#${queue.songs.length}\`${sourceLine ? `\n${sourceLine}` : ''}`;
      await interaction.editReply({
        embeds: [songEmbed('✅ Added to Queue', `**[${tracks[0].title}](${tracks[0].url})**\n${sub}`)]
      });
    }
    return;
  }

  tagTracksForUser(tracks, mention, guild.id, uid);
  placeTracksInQueue(queue, tracks, insertNext);
  await interaction.editReply({
    embeds: [songEmbed('📋 Playlist Added', `Added **${tracks.length}** songs ${insertNext ? '**right after** the current track.' : 'to the queue.'}`)]
  });

  if (!queue.playing) {
    await connectToVoice(queue, voiceChannel, guild.id);
    playSong(guild.id);
  }
}

// Resolve remaining Spotify tracks in the background while music plays
async function resolveSpotifyInBackground(tracks, queue, guildId, requesterMention, requesterUserId, options = {}) {
  const insertNext = options.insertNext === true;
  let insertPos = insertNext ? 2 : null;
  const token = queue._bgResolveToken || 0;

  let resolved = 0;
  let failed = 0;
  const BATCH_SIZE = 6;

  for (let i = 0; i < tracks.length; i += BATCH_SIZE) {
    if ((queue._bgResolveToken || 0) !== token) return;

    const batch = tracks.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(track => resolveSpotifyTrack(track))
    );

    for (let j = 0; j < results.length; j++) {
      if ((queue._bgResolveToken || 0) !== token) return;

      if (results[j].status === 'fulfilled') {
        const result = results[j].value;
        result.requestedBy = requesterMention;
        if (insertNext) {
          queue.songs.splice(insertPos, 0, result);
          insertPos++;
        } else {
          queue.songs.push(result);
        }
        recordRequestCount(guildId, requesterUserId, 1);
        resolved++;
      } else {
        failed++;
        console.warn(`Could not resolve: ${batch[j].title}`);
      }
    }
  }

  if ((queue._bgResolveToken || 0) !== token) return;

  const msg = failed > 0
    ? `Added **${resolved}/${resolved + failed}** Spotify tracks. (${failed} could not be found)`
    : `All **${resolved}** Spotify tracks added to the queue.`;

  await safeSend(queue.textChannel, { embeds: [songEmbed('🎵 Spotify - Done', msg, 0x1db954)] });
}

// ─── YouTube Autocomplete Suggestions ─────────────────────────────
const suggestionCache = new Map(); // lowercased query -> { at, items }
const SUGGESTION_CACHE_MAX = 300;
const SUGGESTION_CACHE_TTL_MS = 5 * 60 * 1000;
const suggestionInFlight = new Map(); // lowercased query -> Promise

async function getYouTubeSuggestions(query) {
  const key = String(query || '').trim().toLowerCase();
  if (!key) return [];

  const cached = suggestionCache.get(key);
  if (cached && Date.now() - cached.at < SUGGESTION_CACHE_TTL_MS) return cached.items;
  if (cached) suggestionCache.delete(key);

  // Coalesce identical in-flight lookups (autocomplete fires per keystroke).
  const existing = suggestionInFlight.get(key);
  if (existing) return existing;

  const job = (async () => {
    try {
      const url = `https://suggestqueries-clients6.youtube.com/complete/search?client=youtube&ds=yt&q=${encodeURIComponent(query)}`;
      const res = await undiciFetch(url);
      const text = await res.text();

      const match = text.match(/\[.*\]/s);
      if (!match) return [];

      const data = JSON.parse(match[0]);
      if (!Array.isArray(data[1])) return [];

      return data[1]
        .slice(0, 10)
        .map(item => {
          const name = typeof item === 'string' ? item : item[0];
          return { name: name.slice(0, 100), value: name.slice(0, 100) };
        });
    } catch (err) {
      console.warn('Autocomplete error:', err.message);
      return [];
    }
  })().then((items) => {
    if (items.length) {
      if (suggestionCache.size >= SUGGESTION_CACHE_MAX) {
        suggestionCache.delete(suggestionCache.keys().next().value);
      }
      suggestionCache.set(key, { at: Date.now(), items });
    }
    return items;
  }).finally(() => suggestionInFlight.delete(key));

  suggestionInFlight.set(key, job);
  return job;
}

// ─── After disconnect jingle: clear VC banner, leave, drop queue ───
async function finishDisconnectAfterAnnouncement(guildId, q) {
  if (!q) return;
  const reason = q._disconnectReason || 'disconnect';
  q._disconnectReason = null;
  q._pendingDisconnect = false;
  q._disconnectTrackEncoded = null;
  q.playing = false;
  q.songs = [];
  const chId = q.voiceChannelId;
  q.player = null;
  queues.delete(guildId);
  if (chId) {
    try {
      await setVoiceChannelStatus(chId, '');
    } catch (e) {
      console.warn('Voice status clear failed:', e?.message || e);
    }
  }
  try {
    await shoukaku.leaveVoiceChannel(guildId);
  } catch (e) {
    console.warn('leaveVoiceChannel failed:', e?.message || e);
  }

  // System audit (user-initiated /disconnect or idle auto-disconnect).
  void postSystemAuditEvent(guildId, chId, 'Disconnected', reason);
}

// ─── Connect to voice channel via Lavalink ────────────────────────
const voiceConnectInFlight = new Map(); // guildId -> Promise

async function connectToVoice(queue, voiceChannel, guildId) {
  if (queue.player) return;

  // joinVoiceChannel is an async handshake; two parallel /play calls used to open two
  // players for the same guild. Share the in-flight join instead.
  const existing = voiceConnectInFlight.get(guildId);
  if (existing) return existing;

  const job = (async () => {
    const player = await shoukaku.joinVoiceChannel({
      guildId: guildId,
      channelId: voiceChannel.id,
      shardId: voiceChannel.guild.shardId ?? 0
    });
    attachPlayerHandlers(player, guildId);
    await player.setGlobalVolume(queue.volume);
    queue.player = player;
    queue._appliedFilterPreset = 'off'; // a fresh Lavalink player starts with no filters
    queue.voiceChannelId = voiceChannel.id;
    console.log(`✅ Voice connected in guild ${guildId} via Lavalink`);
  })().finally(() => voiceConnectInFlight.delete(guildId));

  voiceConnectInFlight.set(guildId, job);
  return job;
}

function attachPlayerHandlers(player, guildId) {
  // Track ended (naturally finished, failed to load, or stopped via skip)
  player.on('end', (data) => {
    if (data.reason === 'replaced' || data.reason === 'cleanup') {
      const q = queues.get(guildId);
      // Starting a new track during the leave jingle ends the jingle with "replaced".
      // Otherwise we return early and "👋 Disconnecting…" never clears.
      if (
        q &&
        q._pendingDisconnect &&
        q._disconnectTrackEncoded &&
        data.track &&
        data.track.encoded === q._disconnectTrackEncoded
      ) {
        q._pendingDisconnect = false;
        q._disconnectTrackEncoded = null;
        void setVoiceChannelStatus(q.voiceChannelId, '');
      }
      return;
    }
    const q = queues.get(guildId);
    if (!q) return; // Queue was deleted (e.g. /stop), do nothing

    const finished = q.songs[0];

    // If the user skipped, and we're in loop-song mode, we should still advance.
    // We'll treat loop-song normally only for natural track end.
    const isSkip = q._skipRequested;
    q._skipRequested = false;

    // System track: handle special cases, otherwise just remove it.
    if (q.songs[0]?.__systemAnnouncement) {
      const sys = q.songs[0];
      const isDisconnectAudio = !!sys.__systemDisconnectAnnouncement;
      q.songs.shift();

      // If /disconnect was requested, leave the voice channel after the system audio.
      if (isDisconnectAudio && q._pendingDisconnect) {
        void finishDisconnectAfterAnnouncement(guildId, q);
        return;
      }
    } else {
      // Loop handling + history
      if (q.loopMode === 'song' && !isSkip) {
        // Loop same song; do not advance and do not push to history
      } else if (q.loopMode === 'queue' && q.songs.length > 0) {
        const shifted = q.songs.shift();
        if (shifted) {
          q.history.push(shifted);
          if (q.history.length > 25) q.history.shift();
          q.songs.push(shifted);
        }
      } else {
        const shifted = q.songs.shift();
        if (shifted) {
          q.history.push(shifted);
          if (q.history.length > 25) q.history.shift();
        }
      }
    }
    playSong(guildId).catch(err => console.error('Error in playSong:', err));
  });

  player.on('exception', (error) => {
    console.error(`Track exception [${guildId}]:`, error.message || error);
    const q = queues.get(guildId);
    if (!q) return;
    if (q._pendingDisconnect && q.songs[0]?.__systemDisconnectAnnouncement) {
      void finishDisconnectAfterAnnouncement(guildId, q);
    }
  });

  player.on('stuck', () => {
    console.warn(`Track stuck [${guildId}]`);
    const q = queues.get(guildId);
    if (!q) return;
    if (q._pendingDisconnect && q.songs[0]?.__systemDisconnectAnnouncement) {
      void finishDisconnectAfterAnnouncement(guildId, q);
      return;
    }
    safeSend(q.textChannel, { embeds: [songEmbed('⚠️ Stuck', 'Track got stuck, skipping...', 0xfee75c)] });
    q.songs.shift();
    playSong(guildId).catch(err => console.error('Error in playSong:', err));
  });

  player.on('closed', () => {
    const q = queues.get(guildId);
    if (!q) return;
    void (async () => {
      if (q.voiceChannelId) {
        try {
          await setVoiceChannelStatus(q.voiceChannelId, '');
        } catch (e) {
          console.warn('Voice status clear on player close failed:', e?.message || e);
        }
      }
      q.playing = false;
      q.player = null;
      q.songs = [];
      queues.delete(guildId);
    })();
  });
}

// ─── Voice Channel Status (the line under the VC name) ──────────────
/** Custom :kord: emoji for VC status, or 🎵 if unset / not found. */
let kordVoiceStatusEmojiCache = null;

function getKordVoiceStatusEmoji() {
  const explicit = process.env.KORD_VOICE_STATUS_EMOJI?.trim();
  if (explicit) return explicit;
  const id = process.env.KORD_EMOJI_ID?.trim();
  if (id) return `<:kord:${id}>`;
  if (kordVoiceStatusEmojiCache) return kordVoiceStatusEmojiCache;
  const e = client.emojis.cache.find((em) => em.name?.toLowerCase() === 'kord');
  kordVoiceStatusEmojiCache = e ? e.toString() : '🎵';
  return kordVoiceStatusEmojiCache;
}

// Voice-channel status is a REST PUT per track change; skip repeats of the same value.
const voiceStatusCache = new Map(); // channelId -> last status applied

async function setVoiceChannelStatus(channelId, status) {
  const value = status || '';
  if (voiceStatusCache.get(channelId) === value) return;
  voiceStatusCache.set(channelId, value);
  try {
    await client.rest.put(`/channels/${channelId}/voice-status`, {
      body: { status: value }
    });
  } catch {
    voiceStatusCache.delete(channelId); // let the next call retry
  }
}

// ─── Song / Artist Trivia via Wikipedia ─────────────────────────────
const wikipediaCache = new Map(); // title -> summary | null
const WIKIPEDIA_CACHE_MAX = 100;

async function fetchWikipediaSummary(title) {
  const key = String(title || '').trim().toLowerCase();
  if (key && wikipediaCache.has(key)) return wikipediaCache.get(key);
  const result = await fetchWikipediaSummaryUncached(title);
  if (key) {
    if (wikipediaCache.size >= WIKIPEDIA_CACHE_MAX) {
      wikipediaCache.delete(wikipediaCache.keys().next().value);
    }
    wikipediaCache.set(key, result);
  }
  return result;
}

async function fetchWikipediaSummaryUncached(title) {
  try {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const res = await undiciFetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.extract) return null;
    return {
      extract: data.extract,
      url: data.content_urls?.desktop?.page || data.content_urls?.mobile?.page || null,
      displayTitle: data.title || title
    };
  } catch {
    return null;
  }
}

// ─── Queue-empty announcement (play local mp3) ──────────────────────
const BOT_DISCONNECT_FILE = path.join(__dirname, 'bot-disconnect.mp3');
const BOT_DISCONNECTED_FILE = path.join(__dirname, 'bot-disconnected.mp3');
const BOT_WELCOME_FILE = path.join(__dirname, 'bot-welcome.mp3');
const BOT_DISCONNECT_HTTP_PORT = Number(process.env.BOT_DISCONNECT_HTTP_PORT || 3011);
const BOT_DISCONNECT_BASE_URL =
  process.env.BOT_DISCONNECT_BASE_URL || `http://127.0.0.1:${BOT_DISCONNECT_HTTP_PORT}`;

let botDisconnectHttpServer = null;
let botDisconnectHttpReady = null;

async function ensureBotDisconnectServer() {
  if (botDisconnectHttpReady) return botDisconnectHttpReady;

  botDisconnectHttpReady = new Promise((resolve) => {
    try {
      const disconnectExists = fs.existsSync(BOT_DISCONNECT_FILE);
      const disconnectedExists = fs.existsSync(BOT_DISCONNECTED_FILE);
      const welcomeExists = fs.existsSync(BOT_WELCOME_FILE);

      if (!disconnectExists && !disconnectedExists && !welcomeExists) {
        console.warn('No disconnect/welcome mp3 files found. Looked for:');
        console.warn(' -', BOT_DISCONNECT_FILE);
        console.warn(' -', BOT_DISCONNECTED_FILE);
        console.warn(' -', BOT_WELCOME_FILE);
        return resolve(false);
      }

      if (botDisconnectHttpServer) return resolve(true);

      botDisconnectHttpServer = http.createServer((req, res) => {
        if (!req.url) return res.writeHead(404).end();
        if (req.method !== 'GET') return res.writeHead(405).end();

        const u = req.url.split('?')[0];
        if (u === '/bot-disconnect.mp3') {
          if (!fs.existsSync(BOT_DISCONNECT_FILE)) return res.writeHead(404).end();
          res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
          const stream = fs.createReadStream(BOT_DISCONNECT_FILE);
          stream.on('error', () => res.writeHead(500).end());
          return stream.pipe(res);
        }

        if (u === '/bot-disconnected.mp3') {
          if (!fs.existsSync(BOT_DISCONNECTED_FILE)) return res.writeHead(404).end();
          res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
          const stream = fs.createReadStream(BOT_DISCONNECTED_FILE);
          stream.on('error', () => res.writeHead(500).end());
          return stream.pipe(res);
        }

        if (u === '/bot-welcome.mp3') {
          if (!fs.existsSync(BOT_WELCOME_FILE)) return res.writeHead(404).end();
          res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
          const stream = fs.createReadStream(BOT_WELCOME_FILE);
          stream.on('error', () => res.writeHead(500).end());
          return stream.pipe(res);
        }

        return res.writeHead(404).end();
      });

      botDisconnectHttpServer.on('error', (e) => {
        console.warn('bot-disconnect audio server error:', e.message || e);
        resolve(false);
      });

      botDisconnectHttpServer.listen(BOT_DISCONNECT_HTTP_PORT, '0.0.0.0', () => {
        console.log(`✅ disconnect audio server on ${BOT_DISCONNECT_BASE_URL}`);
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });

  return botDisconnectHttpReady;
}

function getBotDisconnectAudioUrl() {
  return `${BOT_DISCONNECT_BASE_URL}/bot-disconnect.mp3`;
}

function getBotDisconnectedAudioUrl() {
  return `${BOT_DISCONNECT_BASE_URL}/bot-disconnected.mp3`;
}

function getBotWelcomeAudioUrl() {
  return `${BOT_DISCONNECT_BASE_URL}/bot-welcome.mp3`;
}

/**
 * System jingle tracks never change, so resolve each one once and reuse the encoded track.
 * Previously every queue-empty / disconnect / welcome re-hit Lavalink's REST loader.
 */
const systemAudioTracks = new Map(); // url -> encoded track object

async function resolveSystemAudioTrack(url) {
  const cached = systemAudioTracks.get(url);
  if (cached) return cached;
  const tracks = await resolveIdentifier(url);
  if (!tracks || tracks.length === 0) return null;
  const track = { encoded: tracks[0].encoded, durationMs: tracks[0].durationMs };
  systemAudioTracks.set(url, track);
  return track;
}

async function playQueueEmptyAnnouncement(guildId, queue) {
  const text = "No more songs. I'll leave in 5 minutes if nothing is added.";

  // If Lavalink isn't ready yet, just skip announcement and fall back to timer behavior.
  if (!queue.player) return false;

  try {
    const ok = await ensureBotDisconnectServer();
    if (!ok) return false;

    // Mark as a system track so the end handler doesn't mess with loop/history.
    const sys = await resolveSystemAudioTrack(getBotDisconnectAudioUrl());
    if (!sys) return false;

    queue.playing = true;
    const systemTrack = {
      encoded: sys.encoded,
      title: 'Queue Empty Announcement',
      __systemAnnouncement: true
    };

    // Keep the system track inside queue.songs so the existing "track end" logic
    // shifts it correctly (and doesn't skip the next real song).
    queue.songs.push(systemTrack);

    if (queue.voiceChannelId) setVoiceChannelStatus(queue.voiceChannelId, `${getKordVoiceStatusEmoji()} No more songs`);

    await queue.player.playTrack({ track: { encoded: sys.encoded } });
    await safeSend(queue.textChannel, { embeds: [songEmbed('Queue Empty', text, 0xfee75c)] });
    return true;
  } catch {
    return false;
  }
}

async function maybePlayWelcomeAudio(guildId, queue) {
  if (queue._welcomePlayed) return false;
  if (!queue.player) return false;

  // Only inject welcome when the next track is a "real" song (not another system audio).
  if (queue.songs[0]?.__systemAnnouncement) return false;

  try {
    const ok = await ensureBotDisconnectServer();
    if (!ok) return false;

    const welcome = await resolveSystemAudioTrack(getBotWelcomeAudioUrl());
    if (!welcome) return false;

    queue._welcomePlayed = true;
    queue.songs.unshift({
      encoded: welcome.encoded,
      title: 'Welcome',
      __systemAnnouncement: true
    });
    return true;
  } catch (err) {
    console.warn('Welcome audio injection failed:', err?.message || err);
    return false;
  }
}

// ─── Play the next song in the queue ──────────────────────────────
// Serializes track starts per guild. Without this, a rapid skip double-advance can start
// two tracks at once (double playTrack + double RPC), which is the biggest source of stutter.
const playSongChains = new Map(); // guildId -> tail promise

function playSong(guildId) {
  const prev = playSongChains.get(guildId) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => playSongNow(guildId))
    .catch((err) => {
      console.error('Error in playSong:', err?.message || err);
    });
  playSongChains.set(guildId, next);
  void next.finally(() => {
    if (playSongChains.get(guildId) === next) playSongChains.delete(guildId);
  });
  return next;
}

async function playSongNow(guildId) {
  const queue = getQueue(guildId);

  if (queue.disconnectTimer) {
    clearTimeout(queue.disconnectTimer);
    queue.disconnectTimer = null;
  }

  if (queue.songs.length === 0) {
    const cfg = getConfig(guildId);

    // Smart autoplay: try to queue a related song based on the last track
    // (but only if we haven't already announced queue-empty)
    if (
      !queue._noMoreSongsAnnounced &&
      !queue._skipAutoplay &&
      cfg.autoplay &&
      queue.history.length > 0
    ) {
      const last = queue.history[queue.history.length - 1];
      try {
        const results = await resolveIdentifier(`ytsearch:${last.title}`);
        if (results && results.length > 0) {
          const next = {
            ...results[0],
            requestedBy: 'Autoplay'
          };
          queue.songs.push(next);
          return playSongNow(guildId); // recursive: already inside the guild's serialized slot
        }
      } catch {}
    }

    // Queue-empty audio announcement (once per empty state)
    if (!queue._noMoreSongsAnnounced) {
      queue._noMoreSongsAnnounced = true;
      const ok = await playQueueEmptyAnnouncement(guildId, queue);
      if (ok) return;
      // If the audio fails, fall back to the normal timer message.
      queue._noMoreSongsAnnounced = false;
    }

    queue.playing = false;
    if (queue.voiceChannelId) setVoiceChannelStatus(queue.voiceChannelId, '');

    // Only auto-disconnect after 5 minutes when this wasn't a manual /stop.
    if (!queue._manualStop) {
      queue.disconnectTimer = setTimeout(async () => {
        const q = queues.get(guildId);
        if (!q || q.playing || q.songs.length !== 0) return;
        q._disconnectReason = q._disconnectReason || 'idle timeout (5 minutes)';

        // Play "disconnect" audio first, then leave when it ends.
        try {
          if (q.voiceChannelId && q.player) {
            const sys = await resolveSystemAudioTrack(getBotDisconnectedAudioUrl());
            if (sys) {
              q._pendingDisconnect = true;
              q._disconnectTrackEncoded = sys.encoded;
              q._noMoreSongsAnnounced = true;
              q._skipAutoplay = true;
              q._manualStop = true;

              if (q.voiceChannelId) {
                setVoiceChannelStatus(q.voiceChannelId, '👋 Disconnecting…');
              }

              q.songs = [];
              q.playing = true;
              q.songs.push({
                encoded: sys.encoded,
                title: 'Disconnect Announcement',
                __systemAnnouncement: true,
                __systemDisconnectAnnouncement: true
              });

              await q.player.playTrack({ track: { encoded: sys.encoded } });
              return; // leave will happen in the track end handler
            }
          }
        } catch (e) {
          console.warn('Disconnect audio play failed, leaving anyway:', e?.message || e);
        }

        q._pendingDisconnect = false;
        q._disconnectTrackEncoded = null;
        if (q.voiceChannelId) {
          try {
            await setVoiceChannelStatus(q.voiceChannelId, '');
          } catch {}
        }
        void postSystemAuditEvent(
          guildId,
          q.voiceChannelId,
          'Disconnected',
          q._disconnectReason || 'idle timeout (5 minutes)'
        );
        q._disconnectReason = null;
        try { await shoukaku.leaveVoiceChannel(guildId); } catch {}
        q.player = null;
        queues.delete(guildId);
      }, 300_000); // 5 minutes
    }

    // Only send the embed if the audio didn't already do it (and only for non-manual stops).
    if (!queue._manualStop && !queue._noMoreSongsAnnounced) {
      await safeSend(queue.textChannel, { embeds: [songEmbed('Queue Empty', 'No more songs. I\'ll leave in 5 minutes if nothing is added.', 0xfee75c)] });
    }
    return;
  }

  // If we're starting a fresh session, play the welcome audio once before the first real song.
  await maybePlayWelcomeAudio(guildId, queue);

  const song = queue.songs[0];
  const isSystemAnnouncement = !!song?.__systemAnnouncement;
  queue.playing = true;
  queue._noMoreSongsAnnounced = false; // reset when a real song starts
  queue._manualStop = false; // next empty state should behave normally
  queue._skipAutoplay = false; // allow smart autoplay for normal ends

  try {
    // Filters persist on the Lavalink player across tracks; only (re)apply when the
    // active preset differs from what this player already has.
    if (queue.player && queue._appliedFilterPreset !== queue.filterPreset) {
      try {
        await applyFilterPreset(queue.player, queue.filterPreset || 'off');
        queue._appliedFilterPreset = queue.filterPreset || 'off';
      } catch (filterErr) {
        console.warn('Filter apply error:', filterErr.message || filterErr);
      }
    }

    await queue.player.playTrack({ track: { encoded: song.encoded } });

    // Update voice channel status (works for welcome too)
    if (queue.voiceChannelId && song?.title) {
      setVoiceChannelStatus(queue.voiceChannelId, `${getKordVoiceStatusEmoji()} ${song.title}`);
    }

    // Don't spam "Now Playing" for internal system audio (welcome/disconnect announcements).
    if (isSystemAnnouncement) {
      return;
    }

    const np = buildNowPlayingEmbed(queue);
    if (song.thumbnail) np.setThumbnail(squareEmbedThumbnailUrl(song.thumbnail));

    // Audio is already playing; don't hold the per-guild chain for this REST call.
    void safeSend(queue.textChannel, {
      embeds: [np],
      components: buildNowPlayingComponents(queue)
    });
  } catch (err) {
    console.error('Error playing song:', err.message);
    await safeSend(queue.textChannel, { embeds: [songEmbed('❌ Error', `Failed to play **${song.title}**. Skipping...`, 0xed4245)] });
    queue.songs.shift();
    await playSongNow(guildId); // recursive: already inside the guild's serialized slot
  }
}

// ─── Your Server Only ─────────────────────────────────────────────
const MY_GUILD_ID = process.env.GUILD_ID || '';

// ─── Register Slash Commands & Set Activity ───────────────────────
client.on('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  client.user.setActivity('music | /play', { type: 2 });

  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

  try {
    if (MY_GUILD_ID) {
      // guild only: clear global commands, register in one server (instant)
      await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
      await rest.put(Routes.applicationGuildCommands(client.user.id, MY_GUILD_ID), { body: commands });
      console.log('✅ Slash commands registered to your server.');
    } else {
      // no GUILD_ID: register globally
      await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
      console.log('✅ Slash commands registered globally.');
    }
  } catch (err) {
    console.error('Failed to register slash commands:', err.message);
  }
});

// ─── Autocomplete Handler ─────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isAutocomplete()) return;
  if (interaction.guild?.id !== MY_GUILD_ID) return;

  if (interaction.commandName === 'play' || interaction.commandName === 'playnext') {
    try {
      const query = interaction.options.getFocused();
      if (query.length < 2) {
        await interaction.respond([]);
        return;
      }

      const suggestions = await getYouTubeSuggestions(query);
      await interaction.respond(suggestions);
    } catch (err) {
      // Discord can return "Unknown interaction" if the client responds too late.
      // Never crash the process over autocomplete.
      if (err?.code === 10062) return;
      console.warn('Autocomplete respond error:', err?.message || err);
    }
  }
});

// ─── Slash Command & Button Handler ───────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (interaction.guild?.id !== MY_GUILD_ID) return;

  // Button interactions (now playing controls)
  if (interaction.isButton()) {
    const guild = interaction.guild;
    if (!guild) return;
    const queue = getQueue(guild.id);
    if (!queue.player) {
      return interaction.reply({ embeds: [songEmbed('❌ Error', 'Nothing is playing right now.', 0xed4245)], flags: 64, ephemeral: true });
    }

    const id = interaction.customId;
    try {
      if (id === 'music_playpause') {
        const isPaused = queue.player.paused;
        await queue.player.setPaused(!isPaused);
        void postAuditEvent(interaction, isPaused ? 'resume' : 'pause', `button=${id}`);
        await interaction.update({
          embeds: [buildNowPlayingEmbed(queue)],
          components: buildNowPlayingComponents(queue)
        });
      } else if (id === 'music_vol_down') {
        if (!isDjAllowed(guild.id, interaction.member)) {
          return denyDjOnly(interaction);
        }
        queueVolumeChange(guild.id, queue, Math.max(0, queue.volume - 5), interaction);
        void postAuditEvent(interaction, 'volume down', `button=${id}, volume=${queue.volume}`);
        await interaction.deferUpdate().catch(() => {});
      } else if (id === 'music_vol_up') {
        if (!isDjAllowed(guild.id, interaction.member)) {
          return denyDjOnly(interaction);
        }
        queueVolumeChange(guild.id, queue, Math.min(100, queue.volume + 5), interaction);
        void postAuditEvent(interaction, 'volume up', `button=${id}, volume=${queue.volume}`);
        await interaction.deferUpdate().catch(() => {});
      } else if (id === 'music_seek_back') {
        if (!isDjAllowed(guild.id, interaction.member)) {
          return denyDjOnly(interaction);
        }

        const song = queue.songs?.[0];
        const durationMs = song ? Number(song.durationMs ?? 0) : 0;
        if (!(durationMs > 0)) {
          return interaction.reply({ embeds: [songEmbed('❌ Error', 'This track does not support seeking.', 0xed4245)], flags: 64, ephemeral: true });
        }

        const fromMs = queue.player.position ?? 0;
        const toMs = Math.max(0, fromMs - SEEK_STEP_MS);
        await queue.player.seekTo(toMs);
        void postAuditEvent(interaction, 'seek back', `button=${id}, from=${fromMs}, to=${toMs}`);

        await interaction.update({
          embeds: [buildNowPlayingEmbed(queue, { positionMsOverride: toMs })],
          components: buildNowPlayingComponents(queue)
        });
      } else if (id === 'music_seek_fwd') {
        if (!isDjAllowed(guild.id, interaction.member)) {
          return denyDjOnly(interaction);
        }

        const song = queue.songs?.[0];
        const durationMs = song ? Number(song.durationMs ?? 0) : 0;
        if (!(durationMs > 0)) {
          return interaction.reply({ embeds: [songEmbed('❌ Error', 'This track does not support seeking.', 0xed4245)], flags: 64, ephemeral: true });
        }

        const fromMs = queue.player.position ?? 0;
        const toMs = Math.min(durationMs, fromMs + SEEK_STEP_MS);
        await queue.player.seekTo(toMs);
        void postAuditEvent(interaction, 'seek forward', `button=${id}, from=${fromMs}, to=${toMs}`);

        await interaction.update({
          embeds: [buildNowPlayingEmbed(queue, { positionMsOverride: toMs })],
          components: buildNowPlayingComponents(queue)
        });
      } else if (id === 'music_prev') {
        if (!queue.history || queue.history.length === 0) {
          return interaction.reply({ embeds: [songEmbed('❌ Error', 'No previous song in history.', 0xed4245)], flags: 64, ephemeral: true });
        }

        const previous = queue.history.pop();
        const current = queue.songs.shift();
        if (current) queue.history.push(current);
        queue.songs.unshift(previous);

        await interaction.deferUpdate();
        void postAuditEvent(interaction, 'previous', `button=${id}`);
        await playSong(guild.id);
      } else if (id === 'music_skip') {
        if (!isDjAllowed(guild.id, interaction.member)) {
          return denyDjOnly(interaction);
        }
        if (!queue.playing) {
          return interaction.reply({ embeds: [songEmbed('❌ Error', 'Nothing is playing right now.', 0xed4245)], flags: 64, ephemeral: true });
        }
        queue._skipRequested = true;
        await interaction.deferUpdate();
        void postAuditEvent(interaction, 'skip', `button=${id}`);
        await queue.player.stopTrack();
      } else if (id === 'music_stop') {
        if (!isDjAllowed(guild.id, interaction.member)) {
          return denyDjOnly(interaction);
        }
        if (queue.voiceChannelId) setVoiceChannelStatus(queue.voiceChannelId, '');
        queue._pendingDisconnect = false;
        queue._disconnectTrackEncoded = null;
        // Stop button should behave like /stop: clear queue and start the 5-minute leave timer.
        queue._manualStop = false;
        queue._noMoreSongsAnnounced = false;
        queue._skipAutoplay = true;
        queue.songs = [];
        queue.playing = false;
        if (queue.player) {
          await queue.player.stopTrack();
        }
        void postAuditEvent(interaction, 'stop', `button=${id}`);
        await interaction.update({ components: [] });
      } else if (id === 'music_loop') {
        // Cycle through off -> song -> queue -> off
        if (queue.loopMode === 'off') queue.loopMode = 'song';
        else if (queue.loopMode === 'song') queue.loopMode = 'queue';
        else queue.loopMode = 'off';

        void postAuditEvent(interaction, 'loop mode', `button=${id}, mode=${queue.loopMode}`);
        await interaction.update({
          embeds: [buildNowPlayingEmbed(queue)],
          components: buildNowPlayingComponents(queue)
        });
      }
    } catch (err) {
      console.error('Button interaction error:', err.message || err);
      if (!interaction.replied && !interaction.deferred) {
        try {
          await interaction.reply({ embeds: [songEmbed('❌ Error', 'Button interaction failed.', 0xed4245)], flags: 64, ephemeral: true });
        } catch {}
      }
    }
    return;
  }

  // Select menu interactions (favorites / search results)
  if (interaction.isStringSelectMenu()) {
    const guild = interaction.guild;
    if (!guild) return;

    if (interaction.customId === 'favorites_select_menu') {
      const session = favoritesSessions.get(interaction.message.id);
      if (!session) {
        return interaction.reply({ embeds: [songEmbed('❌ Error', 'This favorites menu has expired.', 0xed4245)], flags: 64, ephemeral: true });
      }
      if (session.userId !== interaction.user.id) {
        return interaction.reply({ embeds: [songEmbed('❌ Error', 'Only the user who ran /favorites can use this menu.', 0xed4245)], flags: 64, ephemeral: true });
      }

      const index = parseInt(interaction.values[0], 10);
      const fav = session.tracks[index];
      if (!fav) {
        return interaction.reply({ embeds: [songEmbed('❌ Error', 'Invalid selection.', 0xed4245)], flags: 64, ephemeral: true });
      }

      const voiceChannel = interaction.member?.voice?.channel;
      if (!voiceChannel) {
        return interaction.reply({ embeds: [songEmbed('❌ Error', 'You need to be in a voice channel!', 0xed4245)], flags: 64, ephemeral: true });
      }

      await interaction.deferUpdate();

      const queue = getQueue(guild.id);
      queue.textChannel = interaction.channel;

      let tracks = null;
      try {
        tracks = await resolveIdentifier(fav.url);
      } catch {}
      if (!tracks || tracks.length === 0) {
        try {
          tracks = await resolveIdentifier(`ytsearch:${fav.title}`);
        } catch {}
      }
      if (!tracks || tracks.length === 0) {
        favoritesSessions.delete(interaction.message.id);
        try {
          await interaction.editReply({ components: [] });
        } catch {}
        return interaction.followUp({
          embeds: [songEmbed('❌ Error', 'Could not load that favorite anymore. Try searching again or re-saving the track.', 0xed4245)],
          flags: 64,
          ephemeral: true
        });
      }

      const track = tracks[0];
      tagTracksForUser([track], interaction.user.toString(), guild.id, interaction.user.id);
      queue.songs.push(track);

      if (!queue.playing) {
        await connectToVoice(queue, voiceChannel, guild.id);
        await interaction.editReply({
          embeds: [songEmbed('✅ Starting Playback', `**[${track.title}](${track.url})**${trackSourceLine(track) ? `\n${trackSourceLine(track)}` : ''}`)],
          components: []
        });
        playSong(guild.id);
      } else {
        const sourceLine = trackSourceLine(track);
        await interaction.editReply({
          embeds: [songEmbed('✅ Added to Queue', `**[${track.title}](${track.url})**\nDuration: \`${track.duration}\`\nPosition: \`#${queue.songs.length}\`${sourceLine ? `\n${sourceLine}` : ''}`)],
          components: []
        });
      }

      favoritesSessions.delete(interaction.message.id);
      return;
    }

    if (!interaction.customId.startsWith('search_select_')) return;

    const session = searchSessions.get(interaction.message.id);
    if (!session) {
      return interaction.reply({ embeds: [songEmbed('❌ Error', 'This search menu has expired.', 0xed4245)], flags: 64, ephemeral: true });
    }

    if (session.userId !== interaction.user.id) {
      return interaction.reply({ embeds: [songEmbed('❌ Error', 'Only the user who ran /search can use this menu.', 0xed4245)], flags: 64, ephemeral: true });
    }

    const index = parseInt(interaction.values[0], 10);
    const track = session.tracks[index];
    if (!track) {
      return interaction.reply({ embeds: [songEmbed('❌ Error', 'Invalid selection.', 0xed4245)], flags: 64, ephemeral: true });
    }

    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      return interaction.reply({ embeds: [songEmbed('❌ Error', 'You need to be in a voice channel!', 0xed4245)], flags: 64, ephemeral: true });
    }

    const queue = getQueue(guild.id);
    queue.textChannel = interaction.channel;

    tagTracksForUser([track], interaction.user.toString(), guild.id, interaction.user.id);
    queue.songs.push(track);

    await interaction.update({ components: [] });

    if (!queue.playing) {
      await connectToVoice(queue, voiceChannel, guild.id);
      await safeSend(queue.textChannel, {
        embeds: [songEmbed('✅ Starting Playback', `**[${track.title}](${track.url})**${trackSourceLine(track) ? `\n${trackSourceLine(track)}` : ''}`)]
      });
      playSong(guild.id);
    } else {
      const sourceLine = trackSourceLine(track);
      await safeSend(queue.textChannel, {
        embeds: [songEmbed('✅ Added to Queue', `**[${track.title}](${track.url})**\nDuration: \`${track.duration}\`\nPosition: \`#${queue.songs.length}\`${sourceLine ? `\n${sourceLine}` : ''}`)]
      });
    }

    searchSessions.delete(interaction.message.id);
    return;
  }

  // Slash commands
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guild, member } = interaction;
  void postAuditEvent(
    interaction,
    `/${commandName}`,
    summarizeCommandOptions(interaction)
  );

  try {
    // ── /play /playnext ───────────────────────────────────────
    if (commandName === 'play' || commandName === 'playnext') {
      await handlePlay(interaction, {
        guild,
        insertNext: commandName === 'playnext'
      });
    }

    // ── /skip ─────────────────────────────────────────────────
    else if (commandName === 'skip') {
      if (!isDjAllowed(guild.id, member)) {
        return denyDjOnly(interaction);
      }
      const queue = getQueue(guild.id);
      if (!queue.playing) {
        return interaction.reply({ embeds: [songEmbed('❌ Error', 'Nothing is playing right now.', 0xed4245)], flags: 64 });
      }
      queue._skipRequested = true;
      await queue.player.stopTrack();
      await interaction.reply({ embeds: [songEmbed('⏭️ Skipped', 'Skipped the current song.')] });
    }

    // ── /skipto ───────────────────────────────────────────────
    else if (commandName === 'skipto') {
      const queue = getQueue(guild.id);
      const pos = interaction.options.getInteger('position');

      if (!queue.player || queue.songs.length === 0) {
        return interaction.reply({ embeds: [songEmbed('❌ Error', 'Nothing is in the queue right now.', 0xed4245)], flags: 64 });
      }

      const idx = pos - 1;
      if (idx < 0 || idx >= queue.songs.length) {
        return interaction.reply({
          embeds: [songEmbed('❌ Error', `Invalid position. The queue has **${queue.songs.length}** song(s) (see \`/queue\` - **1** is now playing).`, 0xed4245)],
          flags: 64
        });
      }
      if (idx === 0) {
        return interaction.reply({ embeds: [songEmbed('⏭️ Skipto', 'That\'s already the current track.')] });
      }

      await interaction.deferReply();
      queue.songs = queue.songs.slice(idx);
      queue.textChannel = interaction.channel;
      try {
        await playSong(guild.id);
        const now = queue.songs[0];
        await interaction.editReply({
          embeds: [songEmbed('⏭️ Skipto', `Skipped ahead - now playing **[${now.title}](${now.url})**`)]
        });
      } catch (e) {
        console.error('Skipto error:', e?.message || e);
        await interaction.editReply({ embeds: [songEmbed('❌ Error', 'Could not jump to that position.', 0xed4245)] });
      }
    }

    // ── /favorite ─────────────────────────────────────────────
    else if (commandName === 'favorite') {
      const queue = getQueue(guild.id);
      if (!queue.playing || queue.songs.length === 0) {
        return interaction.reply({ embeds: [songEmbed('❌ Error', 'Nothing is playing right now.', 0xed4245)], flags: 64 });
      }
      const cur = queue.songs[0];
      if (cur.__systemAnnouncement) {
        return interaction.reply({ embeds: [songEmbed('❌ Error', 'You can\'t favorite system announcements.', 0xed4245)], flags: 64 });
      }
      const res = addUserFavorite(guild.id, interaction.user.id, cur);
      if (!res.ok) {
        if (res.reason === 'dup') {
          return interaction.reply({ embeds: [songEmbed('⭐ Favorites', 'That track is already in your favorites.')] });
        }
        if (res.reason === 'full') {
          return interaction.reply({
            embeds: [songEmbed('❌ Error', `You can save at most **${MAX_FAVORITES_PER_USER}** favorites.`)]
          });
        }
        return interaction.reply({ embeds: [songEmbed('❌ Error', 'This track has no URL to save.', 0xed4245)], flags: 64 });
      }
      await interaction.reply({
        embeds: [songEmbed('⭐ Saved', `Added **${cur.title}** to your favorites. Use \`/favorites\` to queue it later.`)]
      });
    }

    // ── /favorites ────────────────────────────────────────────
    else if (commandName === 'favorites') {
      const list = getUserFavoritesList(guild.id, interaction.user.id);
      if (list.length === 0) {
        return interaction.reply({
          embeds: [songEmbed('⭐ Favorites', 'You don\'t have any saved tracks yet. Use `/favorite` while a song is playing.')]
        });
      }
      await interaction.deferReply({ ephemeral: true });
      const show = list.slice(0, 25);
      const options = show.map((t, i) => ({
        label: t.title.slice(0, 100),
        description: (t.duration || '0:00').slice(0, 100),
        value: String(i)
      }));
      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('favorites_select_menu')
          .setPlaceholder('Pick a track to queue')
          .addOptions(options)
      );
      const lines = show.map((t, i) => `\`${i + 1}.\` [${t.title}](${t.url}) - \`${t.duration}\``).join('\n');
      const embed = songEmbed(
        '⭐ Your Favorites',
        `${lines}\n\n*Pick below to add to the queue. Join a voice channel first.*`
      );
      const msg = await interaction.editReply({ embeds: [embed], components: [row] });
      favoritesSessions.set(msg.id, { userId: interaction.user.id, tracks: show, at: Date.now() });
    }

    // ── /leaderboard ─────────────────────────────────────────
    else if (commandName === 'leaderboard') {
      const topN = interaction.options.getInteger('top') ?? 10;
      const m = guildRequestCounts.get(guild.id);
      if (!m || m.size === 0) {
        return interaction.reply({
          embeds: [songEmbed('🏆 Leaderboard', 'No request stats yet. Queue songs with `/play` to climb the board!')]
        });
      }
      const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
      const lines = sorted.map(([uid, c], i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;
        return `${medal} <@${uid}> - **${c}** song${c === 1 ? '' : 's'} queued`;
      });
      await interaction.reply({ embeds: [songEmbed(`🏆 Top requesters - ${guild.name}`, lines.join('\n'))] });
    }

    // ── /leaderboard_reset ────────────────────────────────────
    else if (commandName === 'leaderboard_reset') {
      if (!isDjAllowed(guild.id, member)) {
        return denyDjOnly(interaction);
      }
      const hadData = resetLeaderboardForGuild(guild.id);
      await interaction.reply({
        embeds: [
          hadData
            ? songEmbed('🧹 Leaderboard Reset', 'Cleared leaderboard stats for this server.')
            : songEmbed('🧹 Leaderboard Reset', 'Leaderboard was already empty.')
        ]
      });
    }

    // ── /previous ────────────────────────────────────────────
    else if (commandName === 'previous') {
      const queue = getQueue(guild.id);
      if (!queue.playing || queue.songs.length === 0) {
        return interaction.reply({ embeds: [songEmbed('❌ Error', 'Nothing is playing right now.', 0xed4245)], flags: 64 });
      }
      if (!queue.history || queue.history.length === 0) {
        return interaction.reply({ embeds: [songEmbed('❌ Error', 'No previous song in history.', 0xed4245)], flags: 64 });
      }

      await interaction.deferReply({ ephemeral: true });

      const previous = queue.history.pop();
      const current = queue.songs.shift();
      if (current) queue.history.push(current);
      queue.songs.unshift(previous);

      await playSong(guild.id);
      await interaction.editReply({ embeds: [songEmbed('⏮️ Previous', `Now playing **${previous.title}**.`)] });
    }

    // ── /stop ─────────────────────────────────────────────────
    else if (commandName === 'stop') {
      if (!isDjAllowed(guild.id, member)) {
        return denyDjOnly(interaction);
      }
      const queue = getQueue(guild.id);
      if (queue.disconnectTimer) clearTimeout(queue.disconnectTimer);
      if (queue.voiceChannelId) setVoiceChannelStatus(queue.voiceChannelId, '');
      queue._pendingDisconnect = false;
      queue._disconnectTrackEncoded = null;
      // Manual stop should start the 5-minute leave timer.
      queue._manualStop = false;
      queue._noMoreSongsAnnounced = false;
      queue._skipAutoplay = true;
      queue.songs = [];
      queue.playing = false;
      if (queue.player) {
        await queue.player.stopTrack();
      }
      await interaction.reply({ embeds: [songEmbed('⏹️ Stopped', 'Music stopped and queue cleared. Staying in the voice channel.')] });
    }

    // ── /disconnect ─────────────────────────────────────────────────
    else if (commandName === 'disconnect') {
      if (!isDjAllowed(guild.id, member)) {
        return denyDjOnly(interaction);
      }
      const queue = getQueue(guild.id);
      if (queue.disconnectTimer) clearTimeout(queue.disconnectTimer);
      if (queue.voiceChannelId) setVoiceChannelStatus(queue.voiceChannelId, '👋 Disconnecting…');

      // Prevent empty-queue "disconnect audio" + timer from firing.
      queue._manualStop = true;
      queue._noMoreSongsAnnounced = true;
      queue._skipAutoplay = true;

      // Leave after we play the "bot-disconnected" audio.
      queue._pendingDisconnect = true;
      queue._disconnectReason = '/disconnect';

      // If we are playing, replace current track with the disconnect audio.
      if (queue.player) {
        try {
          const sys = await resolveSystemAudioTrack(getBotDisconnectedAudioUrl());
          if (sys) {
            queue._disconnectTrackEncoded = sys.encoded;
            queue.songs = [];
            queue.playing = true;

            queue.songs.push({
              encoded: sys.encoded,
              title: 'Disconnect Announcement',
              __systemAnnouncement: true,
              __systemDisconnectAnnouncement: true
            });

            await queue.player.playTrack({ track: { encoded: sys.encoded } });
            await interaction.reply({ embeds: [songEmbed('👋 See you!', 'Kord is leaving the voice channel.')] });
            return;
          }
        } catch {}
      }

      // Fallback: leave immediately if audio can't be played.
      queue._disconnectReason = '/disconnect (fallback)';
      queue._pendingDisconnect = false;
      queue._disconnectTrackEncoded = null;
      queue.songs = [];
      queue.playing = false;

      if (queue.voiceChannelId) {
        try {
          await setVoiceChannelStatus(queue.voiceChannelId, '');
        } catch {}
      }
      void postSystemAuditEvent(
        guild.id,
        queue.voiceChannelId,
        'Disconnected',
        queue._disconnectReason || '/disconnect'
      );
      queue._disconnectReason = null;
      try { await shoukaku.leaveVoiceChannel(guild.id); } catch {}
      queue.player = null;
      queues.delete(guild.id);

      await interaction.reply({ embeds: [songEmbed('👋 Disconnected', 'Left the voice channel and cleared playback.')] });
    }

    // ── /pause ────────────────────────────────────────────────
    else if (commandName === 'pause') {
      const queue = getQueue(guild.id);
      if (!queue.playing) {
        return interaction.reply({ embeds: [songEmbed('❌ Error', 'Nothing is playing right now.', 0xed4245)], flags: 64 });
      }
      await queue.player.setPaused(true);
      await interaction.reply({ embeds: [songEmbed('⏸️ Paused', 'Music paused. Use `/resume` to continue.')] });
    }

    // ── /resume ───────────────────────────────────────────────
    else if (commandName === 'resume') {
      const queue = getQueue(guild.id);
      if (!queue.player) {
        return interaction.reply({ embeds: [songEmbed('❌ Error', 'Nothing to resume.', 0xed4245)], flags: 64 });
      }
      await queue.player.setPaused(false);
      await interaction.reply({ embeds: [songEmbed('▶️ Resumed', 'Music resumed!')] });
    }

    // ── /volume ───────────────────────────────────────────────
    else if (commandName === 'volume') {
      if (!isDjAllowed(guild.id, member)) {
        return denyDjOnly(interaction);
      }
      const queue = getQueue(guild.id);
      const level = interaction.options.getInteger('level');

      queue.volume = level;

      // Apply to Lavalink player if active
      if (queue.player) {
        await queue.player.setGlobalVolume(level);
      }

      await interaction.reply({ embeds: [songEmbed('🔊 Volume', `${volumeBar(level)} **${level}%**`)] });
    }

    // ── /loop ──────────────────────────────────────────────────
    else if (commandName === 'loop') {
      const queue = getQueue(guild.id);
      const mode = interaction.options.getString('mode');
      queue.loopMode = mode;

      let description;
      if (mode === 'off') description = 'Looping disabled.';
      else if (mode === 'song') description = 'Looping the current song.';
      else description = 'Looping the entire queue.';

      await interaction.reply({ embeds: [songEmbed('🔁 Loop', description)] });
    }

    // ── /filter ────────────────────────────────────────────────
    else if (commandName === 'filter') {
      if (!isDjAllowed(guild.id, member)) {
        return denyDjOnly(interaction);
      }
      const queue = getQueue(guild.id);
      const preset = interaction.options.getString('preset');
      queue.filterPreset = preset;

      if (queue.player) {
        try {
          await applyFilterPreset(queue.player, preset);
          queue._appliedFilterPreset = preset;
        } catch (err) {
          console.warn('Filter command apply error:', err.message || err);
        }
      }

      const label =
        preset === 'off' ? 'All filters disabled.' :
        preset === 'bassboost' ? 'Bassboost filter enabled.' :
        preset === 'nightcore' ? 'Nightcore filter enabled.' :
        preset === 'vaporwave' ? 'Vaporwave filter enabled.' :
        preset === '8d' ? '8D filter enabled.' :
        preset === 'karaoke' ? 'Karaoke filter enabled.' :
        preset === 'vibrato' ? 'Vibrato filter enabled.' :
        preset === 'tremolo' ? 'Tremolo filter enabled.' :
        preset === 'distortion' ? 'Distortion filter enabled.' :
        preset === 'lofi' ? 'LoFi filter enabled.' :
        preset === 'highpass' ? 'Highpass filter enabled.' :
        preset === 'slowed' ? 'Slowed filter enabled.' :
        preset === 'chipmunk' ? 'Chipmunk filter enabled.' :
        preset === 'mono' ? 'Mono filter enabled.' :
        preset === 'treble' ? 'Treble filter enabled.' :
        preset === 'deep' ? 'Deep filter enabled.' :
        preset === 'fast' ? 'Fast filter enabled.' :
        preset === 'vocalboost' ? 'VocalBoost filter enabled.' :
        preset === 'basstreble' ? 'Bass+Treble filter enabled.' :
        preset === 'radio' ? 'Radio filter enabled.' :
        preset === 'left' ? 'Left channel filter enabled.' :
        'Right channel filter enabled.';

      await interaction.reply({ embeds: [songEmbed('🎚️ Filter', label)] });
    }

    // ── /lyrics ────────────────────────────────────────────────
    else if (commandName === 'lyrics') {
      const queue = getQueue(guild.id);
      if (!queue.playing || queue.songs.length === 0) {
        return interaction.reply({ embeds: [songEmbed('❌ Error', 'Nothing is playing right now.', 0xed4245)], flags: 64 });
      }

      const current = queue.songs[0];
      await interaction.deferReply();

      try {
        // Shared cached lookup (same sources as /explain) instead of a second copy of it.
        const lyricsData = await fetchLyricsForTrackTitle(current.title);
        if (!lyricsData?.fullLyrics) {
          throw new Error('No lyrics found');
        }
        const { fullLyrics, title, author } = lyricsData;

        const maxLen = 4000;
        const chunks = [];
        let text = fullLyrics;
        while (text.length > 0) {
          chunks.push(text.slice(0, maxLen));
          text = text.slice(maxLen);
        }

        const firstEmbed = new EmbedBuilder()
          .setTitle(`📜 Lyrics - ${title}`)
          .setDescription(chunks[0])
          .setColor(0x5865f2);
        if (author) firstEmbed.setFooter({ text: `By ${author}` });

        const files = [];
        try {
          const buffer = Buffer.from(fullLyrics, 'utf8');
          files.push(new AttachmentBuilder(buffer, { name: 'lyrics.txt' }));
        } catch {}

        await interaction.editReply({ embeds: [firstEmbed], files: files.length ? files : undefined });

        // Send remaining chunks as follow-ups
        for (let i = 1; i < chunks.length; i++) {
          const embed = new EmbedBuilder()
            .setDescription(chunks[i])
            .setColor(0x5865f2);
          await interaction.followUp({ embeds: [embed], flags: 64 });
        }
      } catch (err) {
        console.error('Lyrics error:', err.message || err);
        await interaction.editReply({ embeds: [songEmbed('❌ Error', 'Could not fetch lyrics for this song.', 0xed4245)] });
      }
    }

    // ── /ask ────────────────────────────────────────────────────
    else if (commandName === 'ask') {
      if (!AI_API_KEY) {
        return interaction.reply({
          embeds: [songEmbed('❌ AI disabled', 'Add your AI chat API key to the bot `.env` and restart.', 0xed4245)],
          flags: 64
        });
      }
      const question = interaction.options.getString('question');
      await interaction.deferReply({ ephemeral: false });
      const queue = getQueue(guild.id);
      const playbackContext = formatPlaybackContextForAsk(queue);
      const answer = await aiAskKord(question, playbackContext);
      if (!answer) {
        return interaction.editReply({ embeds: [songEmbed('❌ AI Error', 'Could not get a response. Check your AI settings in `.env` and restart the bot.', 0xed4245)] });
      }
      await interaction.editReply({ embeds: [songEmbed('🤖 Kord', answer)] });
    }

    // ── /explain ───────────────────────────────────────────────
    else if (commandName === 'explain') {
      if (!AI_API_KEY) {
        return interaction.reply({
          embeds: [songEmbed('❌ AI disabled', 'Add your AI chat API key to the bot `.env` and restart.', 0xed4245)],
          flags: 64
        });
      }
      const queue = getQueue(guild.id);
      if (!queue.playing || queue.songs.length === 0) {
        return interaction.reply({ embeds: [songEmbed('❌ Error', 'Nothing is playing right now.', 0xed4245)], flags: 64 });
      }
      await interaction.deferReply();
      const current = queue.songs[0];
      const lyricsData = await fetchLyricsForTrackTitle(current.title);
      if (!lyricsData?.fullLyrics) {
        return interaction.editReply({ embeds: [songEmbed('❌ No lyrics', 'Could not find lyrics to explain. Try `/lyrics` first or a different track.', 0xed4245)] });
      }
      const snippet = lyricsData.fullLyrics.slice(0, 12000);
      const explained = await aiExplainLyrics({
        title: lyricsData.title || current.title,
        artistHint: lyricsData.author || null,
        lyricsSnippet: snippet
      });
      if (!explained) {
        return interaction.editReply({ embeds: [songEmbed('❌ AI Error', 'Could not explain lyrics right now.', 0xed4245)] });
      }
      const ex = songEmbed('📖 Lyrics - explained', explained);
      if (current.thumbnail) ex.setThumbnail(squareEmbedThumbnailUrl(current.thumbnail));
      await interaction.editReply({ embeds: [ex] });
    }

    // ── /search ────────────────────────────────────────────────
    else if (commandName === 'search') {
      const query = interaction.options.getString('query');
      await interaction.deferReply();

      try {
        const tracks = await searchYouTubeTracks(query, 5);
        if (!tracks.length) {
          return interaction.editReply({ embeds: [songEmbed('❌ Error', 'No results found for your search.', 0xed4245)] });
        }

        const options = tracks.map((t, i) => ({
          label: t.title.slice(0, 100),
          description: `#${i + 1} • ${t.duration}`,
          value: String(i)
        }));

        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('search_select_menu')
            .setPlaceholder('Choose a track to play')
            .addOptions(options)
        );

        const list = tracks
          .map((t, i) => `\`${i + 1}.\` [${t.title}](${t.url}) - \`${t.duration}\``)
          .join('\n');

        const embed = songEmbed('🔍 Search Results', list);
        const msg = await interaction.editReply({ embeds: [embed], components: [row] });
        searchSessions.set(msg.id, { userId: interaction.user.id, tracks, at: Date.now() });
      } catch (err) {
        console.error('Search command error:', err.message || err);
        await interaction.editReply({ embeds: [songEmbed('❌ Error', 'Something went wrong while searching.', 0xed4245)] });
      }
    }

    // ── /config ────────────────────────────────────────────────
    else if (commandName === 'config') {
      const cfg = getConfig(guild.id);
      const defaultVolume = interaction.options.getInteger('default_volume');
      const autoplayOpt = interaction.options.getString('autoplay');
      const djRole = interaction.options.getRole('dj_role');

      if (defaultVolume === null && !autoplayOpt && !djRole) {
        const autoplayLabel = cfg.autoplay ? 'On' : 'Off';
        const djRoleLabel = cfg.djRoleId ? `<@&${cfg.djRoleId}>` : 'Not set';
        const desc =
          `**Default Volume:** \`${cfg.defaultVolume}%\`\n` +
          `**Autoplay:** \`${autoplayLabel}\`\n` +
          `**DJ Role:** ${djRoleLabel}`;
        return interaction.reply({ embeds: [songEmbed('⚙️ Current Config', desc)] });
      }

      if (defaultVolume !== null) {
        cfg.defaultVolume = defaultVolume;
      }
      if (autoplayOpt) {
        cfg.autoplay = autoplayOpt === 'on';
      }
      if (djRole) {
        cfg.djRoleId = djRole.id;
      }

      const autoplayLabelNew = cfg.autoplay ? 'On' : 'Off';
      const djRoleLabelNew = cfg.djRoleId ? `<@&${cfg.djRoleId}>` : 'Not set';
      const descNew =
        `**Default Volume:** \`${cfg.defaultVolume}%\`\n` +
        `**Autoplay:** \`${autoplayLabelNew}\`\n` +
        `**DJ Role:** ${djRoleLabelNew}`;

      await interaction.reply({ embeds: [songEmbed('✅ Config Updated', descNew)] });
    }

    // ── /queue ────────────────────────────────────────────────
    else if (commandName === 'queue') {
      const queue = getQueue(guild.id);
      if (queue.songs.length === 0) {
        return interaction.reply({ embeds: [songEmbed('📋 Queue', 'The queue is empty. Use `/play` to add songs.')] });
      }

      await interaction.deferReply();

      const currentSong = queue.songs[0];
      let description = `**Now Playing:**\n🎶 [${currentSong.title}](${currentSong.url}) - \`${currentSong.duration}\`\n🔊 Volume: \`${volumeBar(queue.volume)} ${queue.volume}%\`\n\n`;

      if (queue.songs.length > 1) {
        description += '**Up Next:**\n';
        const upcoming = queue.songs.slice(1, 11);
        upcoming.forEach((song, i) => {
          description += `\`${i + 1}.\` [${song.title}](${song.url}) - \`${song.duration}\`\n`;
        });
        if (queue.songs.length > 11) {
          description += `\n... and **${queue.songs.length - 11}** more`;
        }
      }

      // Post the queue immediately; the AI "vibe" line arrives via a follow-up edit so a slow
      // AI request never holds up the command.
      const qEmbed = songEmbed(`📋 Queue - ${queue.songs.length} song(s)`, description);
      if (currentSong.thumbnail) qEmbed.setThumbnail(squareEmbedThumbnailUrl(currentSong.thumbnail));
      await interaction.editReply({ embeds: [qEmbed] });

      if (AI_API_KEY) {
        const titles = queue.songs.map(s => s.title).filter(Boolean);
        void (async () => {
          const blurb = await aiQueuePlaylistBlurb(titles);
          if (!blurb) return;
          const updated = songEmbed(`📋 Queue - ${queue.songs.length} song(s)`, `${description}\n**🎧 Vibe:** ${blurb}`);
          if (currentSong.thumbnail) updated.setThumbnail(squareEmbedThumbnailUrl(currentSong.thumbnail));
          await interaction.editReply({ embeds: [updated] }).catch(() => {});
        })();
      }
    }

    // ── /songinfo ───────────────────────────────────────────────
    else if (commandName === 'songinfo') {
      const queue = getQueue(guild.id);
      if (!queue.playing || queue.songs.length === 0) {
        return interaction.reply({ embeds: [songEmbed('❌ Error', 'Nothing is playing right now.', 0xed4245)], flags: 64 });
      }

      const song = queue.songs[0];
      const cfg = getConfig(guild.id);

      const lines = [];
      lines.push(`**Title:** [${song.title}](${song.url})`);
      if (song.duration) lines.push(`**Duration:** \`${song.duration}\``);
      lines.push(`**Requested by:** ${song.requestedBy}`);
      lines.push(`**Autoplay:** \`${cfg.autoplay ? 'On' : 'Off'}\``);

      const embed = songEmbed('ℹ️ Song Info', lines.join('\n'));
      if (song.thumbnail) embed.setThumbnail(squareEmbedThumbnailUrl(song.thumbnail));
      await interaction.reply({ embeds: [embed] });
    }

    // ── /songtrivia ─────────────────────────────────────────────
    else if (commandName === 'songtrivia') {
      const queue = getQueue(guild.id);
      if (!queue.playing || queue.songs.length === 0) {
        return interaction.reply({ embeds: [songEmbed('❌ Error', 'Nothing is playing right now.', 0xed4245)], flags: 64 });
      }

      await interaction.deferReply({ ephemeral: false });

      const current = queue.songs[0];
      const rawTitle = current.title || '';
      const parts = rawTitle.split(/\s*[-–—]\s*/);
      const artist = parts.length >= 2 ? parts[0].trim() : null;
      const songName = parts.length >= 2 ? parts.slice(1).join(' ').trim() : rawTitle;

      let trivia = null;

      // Try song page first
      if (songName) {
        trivia = await fetchWikipediaSummary(`${songName} (song)`);
      }

      // Fallback: artist page
      if (!trivia && artist) {
        trivia = await fetchWikipediaSummary(artist);
      }

      // Last resort: raw song title
      if (!trivia && songName) {
        trivia = await fetchWikipediaSummary(songName);
      }

      if (!trivia) {
        return interaction.editReply({ embeds: [songEmbed('❌ No Trivia', 'Could not find trivia for this song or artist.')] });
      }

      const maxLen = 600;
      let text = trivia.extract.trim();
      if (text.length > maxLen) {
        const cut = text.lastIndexOf('.', maxLen);
        text = text.slice(0, cut > 100 ? cut + 1 : maxLen) + ' …';
      }

      const lines = [];
      lines.push(`**Subject:** ${trivia.displayTitle}`);
      lines.push('');
      lines.push(text);
      if (trivia.url) {
        lines.push('');
        lines.push(`[Read more on Wikipedia](${trivia.url})`);
      }

      const embed = songEmbed('💡 Song Trivia', lines.join('\n'));
      if (current.thumbnail) embed.setThumbnail(squareEmbedThumbnailUrl(current.thumbnail));
      await interaction.editReply({ embeds: [embed] });
    }

    // ── /nowplaying ───────────────────────────────────────────
    else if (commandName === 'nowplaying') {
      const queue = getQueue(guild.id);
      if (!queue.playing || queue.songs.length === 0) {
        return interaction.reply({ embeds: [songEmbed('❌ Error', 'Nothing is playing right now.', 0xed4245)], flags: 64 });
      }
      const song = queue.songs[0];
      await interaction.deferReply();
      const np = buildNowPlayingEmbed(queue);
      if (song.thumbnail) np.setThumbnail(squareEmbedThumbnailUrl(song.thumbnail));
      await interaction.editReply({ embeds: [np] });
    }

    // ── /clearqueue ────────────────────────────────────────────
    else if (commandName === 'clearqueue') {
      if (!isDjAllowed(guild.id, member)) {
        return denyDjOnly(interaction);
      }
      const queue = getQueue(guild.id);
      invalidateBackgroundResolves(queue);
      const cleared = clearUpcoming(queue);
      if (cleared === null) {
        return interaction.reply({ embeds: [songEmbed('📋 Queue', 'There are no upcoming songs to clear.')], flags: 64 });
      }
      await interaction.reply({ embeds: [songEmbed('🧹 Queue Cleared', `Removed **${cleared}** upcoming song(s).`)] });
    }

    // ── /remove ───────────────────────────────────────────────
    else if (commandName === 'remove') {
      const queue = getQueue(guild.id);
      const pos = interaction.options.getInteger('position');

      if (pos < 1 || pos >= queue.songs.length) {
        return interaction.reply({ embeds: [songEmbed('❌ Error', 'Invalid position. Use `/queue` to see positions.', 0xed4245)], flags: 64 });
      }

      const removed = queue.songs.splice(pos, 1)[0];
      await interaction.reply({ embeds: [songEmbed('🗑️ Removed', `Removed **${removed.title}** from position \`#${pos}\`.`)] });
    }

    // ── /shuffle ──────────────────────────────────────────────
    else if (commandName === 'shuffle') {
      const queue = getQueue(guild.id);
      if (queue.songs.length <= 2) {
        return interaction.reply({ embeds: [songEmbed('❌ Error', 'Not enough songs to shuffle.', 0xed4245)], flags: 64 });
      }

      const current = queue.songs.shift();
      for (let i = queue.songs.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [queue.songs[i], queue.songs[j]] = [queue.songs[j], queue.songs[i]];
      }
      queue.songs.unshift(current);

      await interaction.reply({ embeds: [songEmbed('🔀 Shuffled', `Shuffled **${queue.songs.length - 1}** songs in the queue.`)] });
    }

  } catch (err) {
    console.error('Command error:', err.message);
    try {
      const reply = { embeds: [songEmbed('❌ Error', 'An unexpected error occurred.', 0xed4245)] };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ ...reply, flags: 64 });
      } else {
        await interaction.reply({ ...reply, flags: 64 });
      }
    } catch { /* ignore follow-up errors */ }
  }
});

// ─── Global Error Handlers (prevent crashes) ─────────────────────
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection:', err.message || err);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message || err);
});

// ─── Login ────────────────────────────────────────────────────────
(async () => {
  // start-kord.sh already waits for Lavalink; a short probe here is just a warm-up.
  // Never block login on it - Shoukaku retries the node and scheduleLavalinkRecovery
  // re-establishes it if the probe fails.
  const lavalinkHost = process.env.LAVALINK_HOST || '127.0.0.1';
  const lavalinkPort = Number(process.env.LAVALINK_PORT || '2333');
  try {
    await waitForLavalink(lavalinkHost, lavalinkPort, 3);
  } catch (err) {
    console.warn(`${err.message} - logging in anyway; the node will reconnect in the background.`);
  }
  client.login(process.env.BOT_TOKEN);
})();
