# Ticket Bot

Staff see **who created the ticket, the ticket #, and the member's answers** in the ticket's opening embed, the Opened log and the Closed log.

## Setup
1. Create an app at https://discord.com/developers/applications → Bot → copy the token.
2. Bot page → enable **Server Members Intent** and **Message Content Intent**.
3. Invite with scopes `bot` + `applications.commands` and permissions: Manage Channels, Manage Roles, View Channels, Send Messages, Embed Links, Attach Files, Read Message History.
4. **Move the bot's role above your staff/support roles** (Server Settings → Roles).
5. `cp .env.example .env`, set `DISCORD_TOKEN` (and `GUILD_ID` for instant slash commands), then `npm install && npm start`.
6. In Discord:
   - `/roles action:Add support role role:@Staff`
   - `/settings set category:#Tickets opened_log:#ticket-logs closed_log:#ticket-logs`
   - `/panel send panel:main`

## Panels (`panels.json`)
Edit the file, no restart needed. Panel ids and option ids must not contain `:`.
```
panels.<id>: title, description, color, type ("buttons" | "select"), placeholder (select)
  options[]: id, label, emoji, style (Primary|Secondary|Success|Danger), description (select),
             questions[] (max 5: label, style "short"|"paragraph", required, maxLength, placeholder),
             supportRoleIds[], categoryId, nameFormat ({number} {username} {type}), embedMessage ({user} {number})
```

Multiple panels (buttons or dropdown) · per-option forms (up to 5 questions) · per-option support roles, category, name format, welcome message · blocked roles · max tickets per user/server · category fallback when one is full · continuous ticket numbers · `/claim` `/unclaim` `/transfer` with the 4 claim modes + Claim button + ping author · `/close` with required-reason, staff-only close, default reason, hide closer, DM to author · HTML transcripts · Opened/Closed logs (with answers) · staff message counts · `/add` `/remove` `/rename` `/priority` · `/createticket` + right-click "Create Ticket" · auto-close on author leaving · inactivity auto-close · close on manual channel deletion · `/help`

## Not implemented
Web dashboard, thread tickets / private staff threads, applications, ratings, multi-step forms, dropdown/user/role-select questions, Steam linking, custom commands, bot personalizer, audit log, panel templates, translations, hosted transcript viewer.

## Data
`data/settings.json` and `data/tickets.json` (flat JSON).
