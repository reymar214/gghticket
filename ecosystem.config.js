// pm2 process file: keeps the bot running in the background and restarts it if it crashes.
//   pm2 start ecosystem.config.js     pm2 logs ticket-bot     pm2 restart ticket-bot     pm2 stop ticket-bot
module.exports = {
  apps: [{
    name: 'ticket-bot',
    script: 'index.js',
    autorestart: true,
    min_uptime: '20s',          // a crash within 20s of starting counts as a failed start
    max_restarts: 10,           // ...and after 10 failed starts pm2 stops trying (check `pm2 logs`)
    restart_delay: 5000,
    time: true,                 // timestamps in the logs
    shutdown_with_message: true, // asks the bot to save and exit (works on Windows, where signals do not)
    kill_timeout: 10000,        // gives the bot up to 10s to save before pm2 force-stops it
  }],
};
