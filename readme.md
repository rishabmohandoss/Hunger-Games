# 🎮 Newsvendor Multiplayer Game

Real-time multiplayer implementation of the **Newsvendor Problem** using
Node.js · Express · Socket.io — 100% free hosting, no credit card required.

---

## Quick Start (Local)

```bash
npm install
npm start
# Open http://localhost:3000
```

For hot-reload during development:
```bash
npm run dev   # uses nodemon
```

---

## How to Play

| Role   | Action |
|--------|--------|
| Host   | Create a room → set rounds, distribution, and market parameters → share the **5-letter room code** |
| Player | Join with the room code → each round, order units before the 30-second timer expires |
| Server | Resolves demand, scores everyone, broadcasts results |

### Profit Formula

```
Profit = (Qty Sold × Price) − (Qty Ordered × Cost) − (Unmet Demand × Opportunity Cost)

Where:
  Qty Sold    = min(Ordered, Demand)
  Unmet Dem.  = max(0, Demand − Ordered)
```

### Demand Distributions

- **Uniform** — random integer in [Min, Max]
- **Normal** — Gaussian with configurable mean and std dev
- **Random (Wild)** — 50/50 mix of Poisson and high-variance spikes

---

## Free Deployment Options (No Credit Card)

### Option 1 — Render.com (Recommended)

1. Push code to a GitHub repo
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your repo
4. Set:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment:** Node
5. Deploy → share the `https://your-app.onrender.com` URL

> ⚠️ Free Render services spin down after 15 min of inactivity (cold start ~30s on first visit). Upgrade to Starter ($7/mo) to keep it warm.

### Option 2 — Glitch.com

1. Go to [glitch.com](https://glitch.com) → New Project → Import from GitHub
2. Paste your repo URL
3. Glitch auto-installs and runs — your URL is `https://your-project.glitch.me`

> ⚠️ Free Glitch projects sleep after 5 min of inactivity.

### Option 3 — Railway.app

1. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
2. Select your repo — Railway auto-detects Node.js
3. Set `PORT` env variable (Railway injects it automatically)

> Free tier gives $5/mo credit — usually enough for a demo/classroom game.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `3000`  | Server port (auto-set by most platforms) |

---

## Architecture

```
newsvendor-game/
├── server.js          # Express + Socket.io backend (all game logic)
├── package.json
└── public/
    └── index.html     # Single-file frontend (HTML + CSS + JS)
```

All game state is **in-memory** — no database needed. Rooms auto-clean after
all players disconnect for 2 minutes.

---

## Socket.io Event Reference

| Event (client→server) | Payload | Description |
|-----------------------|---------|-------------|
| `create_room`  | `{playerName, maxRounds, distribution, params}` | Host creates room |
| `join_room`    | `{playerName, roomCode}` | Player joins lobby |
| `start_game`   | `{roomCode}` | Host starts the game |
| `submit_order` | `{roomCode, quantity}` | Player submits order |
| `next_round`   | `{roomCode}` | Host advances to next round |

| Event (server→client) | Description |
|-----------------------|-------------|
| `room_created`        | Room code + summary |
| `room_joined`         | Confirmation + summary |
| `player_joined`       | Updated room summary |
| `game_starting`       | Pre-game signal |
| `round_start`         | Round number, timer, params |
| `order_confirmed`     | Echo of submitted qty |
| `order_update`        | How many players have ordered |
| `round_results`       | Demand reveal + per-player results |
| `game_over`           | Final leaderboard |
| `player_disconnected` | Who left + updated summary |
| `error`               | Error message string |
