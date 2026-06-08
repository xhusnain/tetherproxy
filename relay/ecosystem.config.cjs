// PM2 process definition for running the relay directly on a host (no Docker).
//
//   npm ci && npm run build
//   pm2 start ecosystem.config.cjs
//   pm2 save && pm2 startup   # survive reboots
//
// Secrets (PAIRING_TOKEN, etc.) are read from relay/.env via Node's built-in
// --env-file flag (Node 20.6+). The store and TLS cert are kept next to the app
// so nothing is written to the filesystem root.
const { join } = require("node:path");

module.exports = {
  apps: [
    {
      name: "tetherproxy-relay",
      script: "dist/index.js",
      cwd: __dirname,
      node_args: "--env-file=.env",
      env: {
        NODE_ENV: "production",
        DATA_DIR: join(__dirname, "data"),
        CERT_DIR: join(__dirname, "certs"),
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
    },
  ],
};
