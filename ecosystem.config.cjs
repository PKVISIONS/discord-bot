/** PM2 — keep discord-linear-bot online (auto-restart on crash). */
module.exports = {
  apps: [
    {
      name: 'discord-linear-bot',
      script: 'discord-bridge.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '600M',
      restart_delay: 5000,
      max_restarts: 50,
      min_uptime: '10s',
      kill_timeout: 10000,
      listen_timeout: 10000,
      env: {
        NODE_ENV: 'production',
      },
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
