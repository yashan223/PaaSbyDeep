// PM2 ecosystem config for PaaSbyDeep
// Run: pm2 start ecosystem.config.cjs
// Save: pm2 save && pm2 startup

module.exports = {
  apps: [
    {
      name: 'paasbydeeep-backend',
      script: './Backend/src/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '400M',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
      env_file: './Backend/.env',
      // Log rotation
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: '/var/log/paasbydeeep/backend.out.log',
      error_file: '/var/log/paasbydeeep/backend.err.log',
      merge_logs: true,
      // Auto-restart settings
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 10,
      min_uptime: '5s',
    },
  ],
};
