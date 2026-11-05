// pm2 process file: `pm2 start ecosystem.config.js`
module.exports = {
  apps: [
    {
      name: 'ai-whatsapp-group-summarizer',
      script: 'src/index.js',
      cwd: __dirname,
      autorestart: true,
      // Wait a bit between restarts so a broken session doesn't loop too fast.
      restart_delay: 10000,
      max_memory_restart: '700M',
      // Give the browser time to close cleanly on stop/restart.
      kill_timeout: 15000,
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
