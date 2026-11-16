// pm2 process file for self-hosting kord
// usage: pm2 start ecosystem.config.js && pm2 save
module.exports = {
  apps: [
    {
      name: 'lavalink',
      script: 'scripts/run-lavalink.js',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
    },
    {
      name: 'kord',
      script: 'bot.js',
      node_args: '--max-old-space-size=512',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
    },
  ],
};
