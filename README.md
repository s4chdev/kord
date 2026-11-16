# kord

a self-hostable discord music bot. node.js + discord.js v14, with audio served by your own [lavalink](https://github.com/lavalink-devs/Lavalink) node.

## features

**playback**
- play from youtube, youtube music, spotify, soundcloud, deezer, apple music, tidal and bandcamp links, or just search text
- spotify playlists and albums load the first tracks instantly and resolve the rest in the background
- youtube autocomplete suggestions while you type in `/play`
- now playing card with buttons: play / pause, skip, seek back and forward 10s, volume down and up, stop
- 21 audio filters: bassboost, nightcore, vaporwave, 8d, karaoke, vibrato, tremolo, distortion, lofi, highpass, slowed, chipmunk, mono, treble, deep, fast, vocalboost, bass+treble, radio, left, right
- loop the song or the whole queue, shuffle, autoplay related songs when the queue runs out
- sets the voice channel status to the current track
- plays a short welcome sound on join and a jingle before leaving
- leaves on its own after 5 minutes idle

**extras**
- lyrics from lrclib, with lyrics.ovh as a fallback
- cover art from itunes, then musicbrainz / cover art archive
- per-user favorites (up to 25) you can queue from a menu
- per-server leaderboard of who requests the most music
- ai chat through any openai-compatible api (openai, groq, openrouter, ollama, lm studio and so on): ask it anything or have it explain a song's lyrics
- song and artist trivia pulled from wikipedia
- per-server config: default volume, autoplay, and a dj role that locks stop, clear queue, filters and volume
- optional discord webhook logging
- light on resources: trimmed caches, bot capped at 512 mb heap, lavalink heap configurable, auto reconnect to lavalink

## commands

| command | what it does |
|---|---|
| `/play <query>` | play a link or search, or add it to the queue |
| `/playnext <query>` | queue a song right after the current one |
| `/search <query>` | search and pick from a list of results |
| `/pause` `/resume` | pause or resume |
| `/skip` | skip the current song |
| `/skipto <position>` | jump to a spot in the queue |
| `/previous` | play the last song again |
| `/stop` | stop and clear the queue, stay in the channel |
| `/disconnect` | leave the voice channel |
| `/queue` | show the queue |
| `/nowplaying` | show the current song |
| `/songinfo` | detailed info on the current song |
| `/remove <position>` | remove a song from the queue |
| `/clearqueue` | clear upcoming songs, keep the current one |
| `/shuffle` | shuffle upcoming songs |
| `/volume <0-100>` | set the volume |
| `/loop <off, song, queue>` | set loop mode |
| `/filter <preset>` | apply an audio filter |
| `/lyrics` | lyrics for the current song |
| `/favorite` | save the current song |
| `/favorites` | browse and play your saved songs |
| `/leaderboard [top]` | top requesters in the server |
| `/leaderboard_reset` | reset the server leaderboard |
| `/ask <question>` | ask kord anything (needs `AI_API_KEY`) |
| `/explain` | explain the current song's lyrics (needs `AI_API_KEY`) |
| `/songtrivia` | a fact about the current song or artist, from wikipedia |
| `/config` | set default volume, autoplay and dj role for the server |

## requirements

- node.js 18 or newer
- java 17 or newer (for lavalink)
- a discord application with a bot token ([developer portal](https://discord.com/developers/applications))
- pm2 for running it in the background: `npm i -g pm2`

or skip all of that and use docker with compose.

## setup

```bash
git clone https://github.com/s4chdev/kord.git kord
cd kord
npm ci
cp .env.example .env    # then fill it in, see below
npm run lavalink:download
```

## discord app setup

1. go to the [discord developer portal](https://discord.com/developers/applications) and hit **new application**. the name is what people see.
2. open **bot**, press **reset token**, copy it into `BOT_TOKEN` in `.env`. never commit it.
3. on the same page, under privileged gateway intents, turn on PRIVILEGED_INTENTS_LINE.
4. open **oauth2 > url generator**, tick the `bot` and `applications.commands` scopes, then these bot permissions: view channels, send messages, embed links, use slash commands, connect, speak.
5. open the generated url, pick your server and authorize.
6. optional: turn on developer mode in discord (settings > advanced), right click your server > copy server id, and put it in `GUILD_ID` so slash commands show up instantly instead of after the global rollout.

## configuration

everything lives in `.env`.

| variable | required | what it does |
|---|---|---|
| `BOT_TOKEN` | yes | discord bot token |
| `GUILD_ID` | no | register slash commands to one server so they show up instantly; leave empty to register globally |
| `LAVALINK_HOST` | yes | usually `127.0.0.1` |
| `LAVALINK_PORT` | yes | usually `2333` |
| `LAVALINK_PASSWORD` | yes | must match `lavalink/application.yml`, change it from the default |
| `LAVALINK_HEAP` | no | java heap for lavalink, e.g. `512m` |
| `LAVALINK_PRETOUCH` | no | pre-allocate the lavalink heap on start |
| `AI_API_KEY` | no | key for any openai-compatible api, enables `/ask` and `/explain` |
| `AI_BASE_URL` | no | api base url up to `/v1`, default `https://api.groq.com/openai/v1` |
| `AI_MODEL` | no | model id for your provider, default `llama-3.3-70b-versatile` |
| `MUSICBRAINZ_COVER_ART` | no | turn musicbrainz cover art lookups on or off |
| `MUSICBRAINZ_CONTACT` | no | contact string musicbrainz asks api users to send |
| `MAX_TRACK_TITLE_LENGTH` | no | trims long titles in embeds |
| `KORD_EMOJI_ID` | no | custom emoji used in messages |
| `KORD_VOICE_STATUS_EMOJI` | no | emoji for the voice channel status |
| `BOT_DISCONNECT_HTTP_PORT` | no | local port that serves the welcome / disconnect sounds, default `3011` |
| `BOT_DISCONNECT_BASE_URL` | no | url lavalink uses to reach those sounds |
| `LOG_WEBHOOK_URL` | no | discord webhook for logs |
| `LOG_WEBHOOK_ONLY_WARN_ERROR` | no | only send warnings and errors, on by default |
| `LOG_WEBHOOK_DEDUPE_WINDOW_MS` | no | skip repeated log lines inside this window, default `10000` |
| `LOG_WEBHOOK_MAX_DESC_CHARS` | no | cap log message length, default `3800` |

## logging to discord (optional)

kord can post its logs to a discord channel through a webhook. off unless you set it.

1. in your server: channel settings > integrations > webhooks > new webhook, then copy the url.
2. put it in `LOG_WEBHOOK_URL`.
3. tune it if you want: `LOG_WEBHOOK_ONLY_WARN_ERROR` (on by default) keeps it to warnings and errors, `LOG_WEBHOOK_DEDUPE_WINDOW_MS` mutes repeats, `LOG_WEBHOOK_MAX_DESC_CHARS` caps message length.

it also posts an audit embed for every command and for system events like disconnects. console logs still work as normal either way (`pm2 logs kord` or `docker compose logs -f kord`).

## running with docker

```bash
cp .env.example .env    # fill in BOT_TOKEN and LAVALINK_PASSWORD at least
docker compose up -d --build
docker compose logs -f kord
```

compose runs the official lavalink image next to the bot and wires the host, port and sound server for you, so skip `npm run lavalink:download`.

## running directly

quick test, two terminals:

```bash
npm run lavalink:start
npm start
```

in the background with pm2:

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup     # follow the printed command so it survives reboots
```

useful after that: `pm2 logs kord`, `pm2 restart kord`, `pm2 status`.

## updating

```bash
git pull
npm ci
pm2 restart kord --update-env
# or with docker
docker compose up -d --build
```

`.github/workflows/deploy.yaml` does exactly this over ssh on every push to `main`. to use it on your own server, add `VPS_HOST`, `VPS_USER` and `VPS_SSH_KEY` as repo secrets and change the path in the workflow.

## license

[mit](LICENSE)
