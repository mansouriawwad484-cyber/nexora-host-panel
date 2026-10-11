# Nexora Host — Starter

This is a starter project, not yet a production hosting service. It includes:
- Discord OAuth2 sign-in (`identify` scope only)
- SQLite user wallet and coin transaction history
- Owner-only coin grants, restricted server-side to `OWNER_DISCORD_ID`
- Coin-only purchase requests with an atomic balance deduction
- Arabic-first responsive dashboard

## Requirements
- Node.js 20+
- A Discord application created in the Discord Developer Portal
- A secure host for the web app (HTTPS in production)

## Setup
1. Download and extract the ZIP, or upload these files into your GitHub repository.
2. In the project folder, run `npm install`.
3. Copy `.env.example` to `.env`.
4. In `.env`, set `SESSION_SECRET` to a long random value and add your Discord application Client ID and Client Secret.
5. In the Discord Developer Portal, add this OAuth2 redirect URL exactly: `http://localhost:3000/auth/discord/callback` for local testing. For deployment, use your real HTTPS domain and update both `BASE_URL` and `DISCORD_REDIRECT_URI`.
6. Run `npm start` and open `http://localhost:3000`.

## Security notes
- Never commit `.env`, bot tokens, or Discord client secrets to GitHub.
- The owner ID is checked on the server, not just hidden in the webpage.
- Use HTTPS and a secure session secret in production.
- Do not run uploaded bot code inside this web process. A real hosting engine needs separate isolated containers/VMs, CPU/RAM limits, restricted network access, process controls, and abuse monitoring.
- The purchase endpoint records an order only; it does not provision a real server yet.
- Add CSRF protection and operational monitoring before production launch.
