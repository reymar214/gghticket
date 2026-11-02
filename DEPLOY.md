# Updating, running and backing up the ticket bot

## 1. Apply this update (about 3 minutes)
1. **Stop the bot**: press `Ctrl + C` in its terminal. (It now saves on exit.)
2. **Copy the whole `GGH Tickets` folder somewhere safe** (right-click → copy → paste elsewhere). This is your rollback.
3. **Unzip the update into `GGH Tickets`** and choose *Replace* when asked. It replaces these files only:
   `index.js` and, inside `lib`: `store.js`, `tickets.js`, `panelbuilder.js`, `dashboard.js`, `dashboard.html`, `setup.js`.
   It adds `DEPLOY.md`, `ecosystem.config.js` and `.gitignore`. It does **not** touch `.env`, `data`, `panels.json` or `package.json`.
   If you edited any of those 7 files yourself, compare with your copy from step 2 and re-apply your change.
   (The close-form placeholder `e.g. Resolved` is already carried over.)
4. **Start it**: `npm start`. On the first start you should see, in order:
   - `Logged in as ...`
   - `Panels are now kept per server. Moved: ...` (your existing panels are assigned to the right server automatically)
   - `Dashboard: http://127.0.0.1:3737`
5. Check `/panel list` in each server shows only that server's panels.

## 2. What changed (hardening)
- **Saving is crash-safe.** Files are written to a temp file and swapped in, and the previous version is kept as `.bak`.
  A damaged file is never treated as empty: the bot restores the `.bak`, or refuses to start and tells you.
- **Daily backups** are made automatically in `data/backups/<date>/` (last 14 days) with a mirror of every transcript in `data/backups/transcripts/`.
  They are on the same disk, so **also copy the `data` folder somewhere else now and then** (another drive or cloud folder).
- **Panels are per server.** Servers can no longer see or edit each other's panels.
- **Simultaneous clicks are safe**: no duplicate tickets, no duplicate ticket numbers, no double close.
- **Admin commands re-check Manage Server** inside the bot.
- **Startup checks**: a missing/wrong token stops with a clear message instead of hanging.
- **Clean shutdown**: Ctrl+C, `pm2 stop` or a system shutdown saves everything first.

## 3. Restoring from a backup
1. Stop the bot.
2. Copy `tickets.json` and `settings.json` from `data/backups/<date>/` into `data/` (replace). Copy `panels.json` from the same folder into the main folder.
3. Transcripts are in `data/transcripts/`; any missing ones are in `data/backups/transcripts/`.
4. Start the bot.
If a file ever says "damaged" at startup, a copy named like `tickets.json.damaged-<number>` is kept next to it.

## 4. Keep it running with pm2
pm2 keeps the bot running in the background, restarts it after a crash, and keeps a log.
```
npm install -g pm2
pm2 start ecosystem.config.js
pm2 logs ticket-bot        (watch the output; Ctrl+C leaves the logs, the bot keeps running)
pm2 restart ticket-bot     (after changing any file)
pm2 stop ticket-bot
pm2 save                   (remember the process list)
```
- **Start automatically after a reboot:** on Linux run `pm2 startup` and follow what it prints, then `pm2 save`.
  On Windows pm2 has no built-in boot start; use Task Scheduler ("At startup" → `pm2 resurrect`) or a tool such as `pm2-windows-startup`.
- Note: this pm2 setup was prepared and the shutdown path tested in simulation, but not run under pm2 itself. Try `pm2 stop` once and confirm `pm2 logs` shows "saving and shutting down".
- A PC that sleeps or loses internet takes the bot offline. For a bot people rely on, a small always-on server (VPS) is the reliable choice.

## 5. Version control (recommended)
Install Git, then in the project folder: `git init`, `git add .`, `git commit -m "working version"`.
The included `.gitignore` keeps your token (`.env`), `data`, and `node_modules` out. After each change, commit again: you can then always see what changed and go back.

## 6. Safety notes
- The dashboard has **no login** and only listens on this PC (`127.0.0.1`). Never expose it to the internet as is.
- `.env` holds your bot token. Never share it. If it leaks, reset it in the Discord Developer Portal.
- Before letting other communities add the bot: it is a **public bot** setting in the Developer Portal, and at 100 servers Discord requires verification and approval for the Message Content and Server Members intents.
