// ecosystem.config.cjs — PM2 process configuration
// Start with: pm2 start ecosystem.config.cjs
// Save state:  pm2 save
// Auto-start:  pm2 startup  (then run the command it prints)

module.exports = {
  apps: [
    {
      name:         'second-brain',
      script:       'src/server/server.js',
      interpreter:  'node',
      watch:        false,
      autorestart:  true,
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: '300M',

      // Load .env file
      env_file: '.env',

      // Log settings
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file:  './logs/error.log',
      out_file:    './logs/out.log',
      merge_logs:  true,

      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
}
