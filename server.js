// ============================================================
//  NEWSVENDOR GAME — Node.js + Express + Socket.io Server
// ============================================================

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// Serve static files from /public
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));

// Explicit root route — ensures Render/Glitch always find index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// Catch-all fallback for any other GET (SPA safety net)
app.get("*", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// ── PORT ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// ============================================================
//  IN-MEMORY GAME STATE
// ============================================================
/*
  rooms = {
    [roomCode]: {
      code:          string,
      hostId:        string (socket.id),
      status:        "lobby" | "ordering" | "results" | "finished",
      round:         number,
      maxRounds:     number,
      distribution:  "uniform" | "normal" | "random",
      params: {
        price:           number,   // selling price per unit
        cost:            number,   // purchase cost per unit
        opportunityCost: number,   // per unit of unmet demand
        demandMin:       number,   // for uniform
        demandMax:       number,   // for uniform / normal mean
        demandStd:       number,   // for normal
      },
      timer:         NodeJS.Timeout | null,
      players: {
        [socketId]: {
          id:        string,
          name:      string,
          totalProfit: number,
          history:   Array<RoundResult>,
          orderThisRound: number | null,
          connected: boolean,
        }
      }
    }
  }
*/
const rooms = {};

// ============================================================
//  HELPERS — Room Code & Validation
// ============================================================

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms[code] ? generateRoomCode() : code; // retry on collision
}

function getRoomSummary(room) {
  return {
    code:         room.code,
    status:       room.status,
    round:        room.round,
    maxRounds:    room.maxRounds,
    distribution: room.distribution,
    params:       room.params,
    players: Object.values(room.players).map((p) => ({
      id:           p.id,
      name:         p.name,
      totalProfit:  p.totalProfit,
      connected:    p.connected,
      ordered:      p.orderThisRound !== null,
    })),
  };
}

// ============================================================
//  DEMAND GENERATION
// ============================================================

/**
 * Box-Muller transform → standard normal sample
 */
function sampleNormal(mean, std) {
  let u, v;
  do { u = Math.random(); } while (u === 0);
  do { v = Math.random(); } while (v === 0);
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(0, Math.round(mean + z * std));
}

/**
 * Sample from a Poisson distribution (Knuth algorithm)
 */
function samplePoisson(lambda) {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

function generateDemand(distribution, params) {
  switch (distribution) {
    case "uniform":
      return Math.floor(
        Math.random() * (params.demandMax - params.demandMin + 1) + params.demandMin
      );
    case "normal":
      return sampleNormal(params.demandMax /* used as mean */, params.demandStd);
    case "random": {
      // 50/50 between Poisson and high-variance spike
      if (Math.random() < 0.5) {
        return samplePoisson(params.demandMax);
      } else {
        // High-variance: uniform ± 60% of mean
        const spread = Math.round(params.demandMax * 0.6);
        return Math.max(
          0,
          Math.round(
            params.demandMax + (Math.random() * 2 - 1) * spread
          )
        );
      }
    }
    default:
      return Math.floor(Math.random() * 100) + 1;
  }
}

// ============================================================
//  PROFIT CALCULATION
// ============================================================

/**
 * Profit = (Qty Sold × Price) − (Qty Ordered × Cost) − (Unmet Demand × OpportunityCost)
 * Qty Sold     = min(Ordered, Demand)
 * Unmet Demand = max(0, Demand − Ordered)
 */
function calculateProfit(ordered, demand, { price, cost, opportunityCost }) {
  const qtySold      = Math.min(ordered, demand);
  const unmetDemand  = Math.max(0, demand - ordered);
  const revenue      = qtySold * price;
  const totalCost    = ordered * cost;
  const lostProfit   = unmetDemand * opportunityCost;
  const profit       = revenue - totalCost - lostProfit;

  return {
    ordered,
    demand,
    qtySold,
    unmetDemand,
    revenue,
    totalCost,
    lostProfit,
    profit,
  };
}

// ============================================================
//  ROUND RESOLUTION
// ============================================================

function resolveRound(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }

  room.status = "results";
  const demand = generateDemand(room.distribution, room.params);
  const roundResults = [];

  for (const player of Object.values(room.players)) {
    // Default order = 0 if player didn't submit in time
    const ordered = player.orderThisRound !== null ? player.orderThisRound : 0;
    const result  = calculateProfit(ordered, demand, room.params);
    player.totalProfit += result.profit;
    player.history.push({ round: room.round, demand, ...result });
    roundResults.push({ playerId: player.id, playerName: player.name, ...result });
    player.orderThisRound = null; // reset for next round
  }

  // Sort leaderboard by total profit (desc)
  const leaderboard = Object.values(room.players)
    .map((p) => ({ id: p.id, name: p.name, totalProfit: p.totalProfit }))
    .sort((a, b) => b.totalProfit - a.totalProfit);

  const isGameOver = room.round >= room.maxRounds;

  const payload = {
    round: room.round,
    demand,
    distribution: room.distribution,
    results: roundResults,
    leaderboard,
    isGameOver,
  };

  io.to(room.code).emit("round_results", payload);

  if (isGameOver) {
    room.status = "finished";
    io.to(room.code).emit("game_over", { leaderboard });
  }
}

// ============================================================
//  ROUND START
// ============================================================

const DEFAULT_ROUND_DURATION_MS = 30_000;

function startRound(room) {
  room.round++;
  room.status = "ordering";

  // Reset orders
  for (const p of Object.values(room.players)) p.orderThisRound = null;

  const duration = room.roundDuration || DEFAULT_ROUND_DURATION_MS;
  io.to(room.code).emit("round_start", {
    round:        room.round,
    maxRounds:    room.maxRounds,
    duration:     duration,
    distribution: room.distribution,
    params:       room.params,
  });

  // Server-side timer
  room.timer = setTimeout(() => resolveRound(room), duration);
}

// ============================================================
//  CHECK IF ALL CONNECTED PLAYERS HAVE ORDERED
// ============================================================

function checkAllOrdered(room) {
  const connected = Object.values(room.players).filter((p) => p.connected);
  if (connected.length === 0) return;
  const allIn = connected.every((p) => p.orderThisRound !== null);
  if (allIn) resolveRound(room);
}

// ============================================================
//  SOCKET.IO EVENT HANDLERS
// ============================================================

io.on("connection", (socket) => {
  console.log(`[+] Socket connected: ${socket.id}`);

  // ── CREATE ROOM ──────────────────────────────────────────
  socket.on("create_room", ({ playerName, maxRounds, distribution, params }) => {
    if (!playerName || typeof playerName !== "string" || playerName.trim().length === 0) {
      return socket.emit("error", { message: "Invalid player name." });
    }

    const code = generateRoomCode();
    rooms[code] = {
      code,
      hostId:       socket.id,
      status:       "lobby",
      round:        0,
      maxRounds:    Math.min(Math.max(parseInt(maxRounds) || 5, 1), 20),
      distribution: ["uniform", "normal", "random"].includes(distribution)
        ? distribution
        : "uniform",
      params: {
        price:           Number(params?.price)           || 10,
        cost:            Number(params?.cost)            || 4,
        opportunityCost: Number(params?.opportunityCost) || 2,
        demandMin:       Number(params?.demandMin)       || 20,
        demandMax:       Number(params?.demandMax)       || 80,
        demandStd:       Number(params?.demandStd)       || 15,
      },
      timer:   null,
      players: {},
    };

    rooms[code].players[socket.id] = {
      id:             socket.id,
      name:           playerName.trim().slice(0, 24),
      totalProfit:    0,
      history:        [],
      orderThisRound: null,
      connected:      true,
    };

    socket.join(code);
    socket.emit("room_created", { code, roomSummary: getRoomSummary(rooms[code]) });
    console.log(`[Room ${code}] Created by ${playerName}`);
  });

  // ── JOIN ROOM ────────────────────────────────────────────
  socket.on("join_room", ({ playerName, roomCode }) => {
    const code = (roomCode || "").toUpperCase().trim();
    const room = rooms[code];

    if (!room) return socket.emit("error", { message: "Room not found." });
    if (!playerName || typeof playerName !== "string" || playerName.trim().length === 0)
      return socket.emit("error", { message: "Invalid player name." });

    const trimmedName = playerName.trim().slice(0, 24);
    const existingPlayer = Object.values(room.players).find(p => p.name === trimmedName);

    if (existingPlayer) {
      existingPlayer.id = socket.id;
      existingPlayer.connected = true;
      socket.join(code);
      socket.emit("room_joined", { code, roomSummary: getRoomSummary(room), reconnected: true });
      io.to(code).emit("player_joined", { roomSummary: getRoomSummary(room) });
      console.log(`[Room ${code}] ${trimmedName} reconnected`);
    } else {
      if (room.status !== "lobby") return socket.emit("error", { message: "Game already in progress." });
      const connectedCount = Object.values(room.players).filter(p => p.connected).length;
      if (connectedCount >= 8)
        return socket.emit("error", { message: "Room is full (max 8 players)." });

      room.players[socket.id] = {
        id:             socket.id,
        name:           trimmedName,
        totalProfit:    0,
        history:        [],
        orderThisRound: null,
        connected:      true,
      };

      socket.join(code);
      socket.emit("room_joined", { code, roomSummary: getRoomSummary(room) });
      io.to(code).emit("player_joined", { roomSummary: getRoomSummary(room) });
      console.log(`[Room ${code}] ${trimmedName} joined`);
    }
  });

  // ── START GAME (host only) ───────────────────────────────
  socket.on("start_game", ({ roomCode, roundDuration }) => {
    const room = rooms[roomCode];
    if (!room) return socket.emit("error", { message: "Room not found." });
    if (room.hostId !== socket.id) return socket.emit("error", { message: "Only the host can start the game." });
    if (room.status !== "lobby") return socket.emit("error", { message: "Game already started." });
    if (Object.keys(room.players).length < 1) return socket.emit("error", { message: "Need at least 1 player." });

    // Validate params
    const p = room.params;
    if (isNaN(p.price) || p.price <= 0) return socket.emit("error", { message: "Invalid price" });
    if (isNaN(p.cost) || p.cost < 0) return socket.emit("error", { message: "Invalid cost" });
    if (p.cost >= p.price) return socket.emit("error", { message: "Cost must be less than price" });
    if (isNaN(p.opportunityCost) || p.opportunityCost < 0) return socket.emit("error", { message: "Invalid opportunity cost" });

    if (roundDuration && !isNaN(roundDuration) && roundDuration > 0) {
      room.roundDuration = roundDuration * 1000;
    }

    io.to(roomCode).emit("game_starting", { roomSummary: getRoomSummary(room) });
    startRound(room);
  });

  // ── SUBMIT ORDER ─────────────────────────────────────────
  socket.on("submit_order", ({ roomCode, quantity }) => {
    const room = rooms[roomCode];
    if (!room) return socket.emit("error", { message: "Room not found." });
    if (room.status !== "ordering") return socket.emit("error", { message: "Not currently in ordering phase." });

    const player = room.players[socket.id];
    if (!player) return socket.emit("error", { message: "You are not in this room." });
    if (player.orderThisRound !== null) return socket.emit("error", { message: "Order already submitted." });

    const qty = parseInt(quantity);
    if (isNaN(qty) || qty < 0 || qty > 9999)
      return socket.emit("error", { message: "Invalid quantity (0–9999)." });

    player.orderThisRound = qty;
    socket.emit("order_confirmed", { quantity: qty });

    // Notify room how many have ordered
    const connected    = Object.values(room.players).filter((p) => p.connected);
    const orderedCount = connected.filter((p) => p.orderThisRound !== null).length;
    io.to(roomCode).emit("order_update", { orderedCount, totalPlayers: connected.length });

    checkAllOrdered(room);
  });

  // ── UPDATE PARAMS (host only, lobby or results phase) ───
  socket.on("update_params", ({ roomCode, distribution, params }) => {
    const room = rooms[roomCode];
    if (!room) return socket.emit("error", { message: "Room not found." });
    if (room.hostId !== socket.id) return socket.emit("error", { message: "Only the host can change parameters." });
    if (!["lobby", "results"].includes(room.status)) return socket.emit("error", { message: "Can only edit params in lobby or between rounds." });

    if (distribution && ["uniform", "normal", "random"].includes(distribution)) {
      room.distribution = distribution;
    }
    if (params) {
      const newParams = {
        price:           Number(params.price)           || room.params.price,
        cost:            Number(params.cost)            || room.params.cost,
        opportunityCost: Number(params.opportunityCost) >= 0 ? Number(params.opportunityCost) : room.params.opportunityCost,
        demandMin:       Number(params.demandMin)       >= 0 ? Number(params.demandMin)       : room.params.demandMin,
        demandMax:       Number(params.demandMax)       || room.params.demandMax,
        demandStd:       Number(params.demandStd)       || room.params.demandStd,
      };

      // Validate
      if (isNaN(newParams.price) || newParams.price <= 0) return socket.emit("error", { message: "Invalid price" });
      if (isNaN(newParams.cost) || newParams.cost < 0) return socket.emit("error", { message: "Invalid cost" });
      if (newParams.cost >= newParams.price) return socket.emit("error", { message: "Cost must be less than price" });
      if (isNaN(newParams.opportunityCost) || newParams.opportunityCost < 0) return socket.emit("error", { message: "Invalid opportunity cost" });

      room.params = newParams;
    }

    io.to(roomCode).emit("params_updated", {
      distribution: room.distribution,
      params:       room.params,
    });
    socket.emit("params_saved", { distribution: room.distribution, params: room.params });
    console.log(`[Room ${roomCode}] Params updated by host`);
  });

  // ── NEXT ROUND (host only) ───────────────────────────────
  socket.on("next_round", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return socket.emit("error", { message: "Room not found." });
    if (room.hostId !== socket.id) return socket.emit("error", { message: "Only the host can advance." });
    if (room.status !== "results") return socket.emit("error", { message: "Not in results phase." });
    if (room.round >= room.maxRounds) return socket.emit("error", { message: "Game is already over." });

    startRound(room);
  });

  // ── PLAY AGAIN (host only) ───────────────────────────────
  socket.on("play_again", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return socket.emit("error", { message: "Room not found." });
    if (room.hostId !== socket.id) return socket.emit("error", { message: "Only the host can reset the game." });

    for (const player of Object.values(room.players)) {
      player.totalProfit = 0;
      player.history = [];
      player.orderThisRound = null;
    }
    room.round = 0;
    room.status = "lobby";

    io.to(roomCode).emit("game_reset", { roomSummary: getRoomSummary(room) });
    console.log(`[Room ${roomCode}] Game reset by host`);
  });

  // ── DISCONNECT ───────────────────────────────────────────
  socket.on("disconnect", () => {
    console.log(`[-] Socket disconnected: ${socket.id}`);

    for (const [code, room] of Object.entries(rooms)) {
      const player = room.players[socket.id];
      if (!player) continue;

      player.connected = false;
      io.to(code).emit("player_disconnected", {
        playerId:     socket.id,
        playerName:   player.name,
        roomSummary:  getRoomSummary(room),
      });

      // Host migration on disconnect
      if (room.hostId === socket.id) {
        const nextHost = Object.values(room.players).find(p => p.connected && p.id !== socket.id);
        if (nextHost) {
          room.hostId = nextHost.id;
          io.to(code).emit('host_transferred', { newHostId: nextHost.id, newHostName: nextHost.name });
          console.log(`[Room ${code}] Host transferred to ${nextHost.name}`);
        }
      }

      // If all players disconnected, clean up after 2 minutes
      const anyConnected = Object.values(room.players).some((p) => p.connected);
      if (!anyConnected) {
        setTimeout(() => {
          if (rooms[code]) {
            if (room.timer) clearTimeout(room.timer);
            delete rooms[code];
            console.log(`[Room ${code}] Cleaned up — all players gone`);
          }
        }, 120_000);
      }

      // If active ordering round has all remaining players submitted, resolve
      if (room.status === "ordering") checkAllOrdered(room);

      break; // socket can only be in one room
    }
  });
});

// ============================================================
//  START SERVER
// ============================================================

server.listen(PORT, () => {
  console.log(`\n🎮 Newsvendor Game server running on http://localhost:${PORT}\n`);
});
