const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static("public"));

const PORT = 3000;

let rooms = {};

const CANVAS_W = 1400;
const CANVAS_H = 900;
const BASE_SPEED = 2.5;
const SPEED_INCREMENT = 0.5; // extra speed every interval
const SPEED_INTERVAL = 10;   // seconds between speed increases
const MAX_SPEED = 8;         // cap so it doesn't go insane
const TURN_SPEED = 0.045;    // radians per tick (slightly lower for bigger map)
const TRAIL_MAX = 5000;      // longer trails for bigger map
const COLLISION_RADIUS = 4;
const COLLISION_SKIP_OWN = 20;

// Spawn positions for 1400x900 map (pointing inward)
const spawnConfigs = [
  { x: 250, y: 200, angle: Math.PI * 0.25 },   // top-left, facing down-right
  { x: 1150, y: 200, angle: Math.PI * 0.75 },  // top-right, facing down-left
  { x: 1150, y: 700, angle: Math.PI * 1.25 },  // bottom-right, facing up-left
  { x: 250, y: 700, angle: Math.PI * 1.75 },   // bottom-left, facing up-right
];

const COLORS = ["#00ffff", "#ff2e63", "#00ff88", "#ffaa00"];

// ── ROOM CODE ──
function generateRoomCode() {
  let code;
  do {
    code = Math.floor(1000 + Math.random() * 9000).toString();
  } while (rooms[code]);
  return code;
}

// ── CREATE PLAYER ──
function createPlayer(id, index, name) {
  const spawn = spawnConfigs[index % spawnConfigs.length];
  return {
    id,
    name: typeof name === "string" && name.trim().length > 0 ? name.trim() : "Player",
    x: CANVAS_W / 2,
    y: CANVAS_H / 2,
    angle: 0,
    turning: 0, // -1 = left, 0 = straight, 1 = right
    trail: [],
    alive: true,
    score: 0,
    color: COLORS[index % COLORS.length],
    spawnIndex: index,
  };
}

// ── CALCULATE CURRENT SPEED ──
function getRoomSpeed(room) {
  if (!room.roundStartTime) return BASE_SPEED;
  const elapsed = (Date.now() - room.roundStartTime) / 1000;
  const boosts = Math.floor(elapsed / SPEED_INTERVAL);
  return Math.min(BASE_SPEED + boosts * SPEED_INCREMENT, MAX_SPEED);
}

// ── MOVE PLAYER ──
function movePlayer(p, speed) {
  // Apply turning
  p.angle += p.turning * TURN_SPEED;

  // Move forward at current speed
  p.x += Math.cos(p.angle) * speed;
  p.y += Math.sin(p.angle) * speed;

  // Record trail
  p.trail.push({ x: p.x, y: p.y });
  if (p.trail.length > TRAIL_MAX) p.trail.shift();

  // Wall collision
  if (p.x < 0 || p.x > CANVAS_W || p.y < 0 || p.y > CANVAS_H) {
    p.alive = false;
  }
}

// ── COLLISION CHECK ──
function checkCollision(p, players) {
  for (let id in players) {
    const other = players[id];
    if (!other.alive && id !== p.id) continue;

    const trail = other.trail;
    // Skip the tail end of own trail to avoid immediate self-collision
    const end = id === p.id ? trail.length - COLLISION_SKIP_OWN : trail.length - 2;

    for (let i = 0; i < end; i++) {
      const t = trail[i];
      const dx = p.x - t.x;
      const dy = p.y - t.y;
      if (dx * dx + dy * dy < COLLISION_RADIUS * COLLISION_RADIUS) {
        return true;
      }
    }
  }
  return false;
}

// ── START ROUND ──
function startRound(room) {
  let i = 0;
  for (let id in room.players) {
    const p = room.players[id];
    const spawn = spawnConfigs[i % spawnConfigs.length];
    p.x = spawn.x;
    p.y = spawn.y;
    p.angle = spawn.angle;
    p.turning = 0;
    p.trail = [];
    p.alive = true;
    i++;
  }
  room.roundActive = true;
  room.countdown = 0;
  room.roundStartTime = Date.now();
}

// ── COUNTDOWN HELPER ──
function startCountdown(room, callback) {
  room.centerPhase = true;
  room.countdown = 3;
  const interval = setInterval(() => {
    room.countdown--;
    if (room.countdown <= 0) {
      clearInterval(interval);
      callback();
    }
  }, 1000);
}

// ── WEBSOCKET ──
wss.on("connection", (ws) => {
  const id = Math.random().toString(36).substr(2, 9);
  ws.id = id;

  ws.send(JSON.stringify({ type: "init", id }));

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch (e) {
      return;
    }

    // HOST
    if (data.type === "create") {
      const code = generateRoomCode();
      rooms[code] = {
        players: {},
        roundActive: false,
        centerPhase: false,
        gameStarted: false,
        matchWinner: null,
        hostId: id,
        countdown: 0,
      };
      ws.room = code;
      rooms[code].players[id] = createPlayer(id, 0, data.name);

      ws.send(JSON.stringify({ type: "roomCreated", code }));
      broadcastPlayerList(code);
    }

    // JOIN
    if (data.type === "join") {
      const code = data.code;
      if (!rooms[code]) {
        ws.send(JSON.stringify({ type: "error", message: "Room not found" }));
        return;
      }
      const playerCount = Object.keys(rooms[code].players).length;
      if (playerCount >= 4) {
        ws.send(JSON.stringify({ type: "error", message: "Room is full (max 4)" }));
        return;
      }
      if (rooms[code].gameStarted) {
        ws.send(JSON.stringify({ type: "error", message: "Game already in progress" }));
        return;
      }

      rooms[code].players[id] = createPlayer(id, playerCount, data.name);
      ws.room = code;

      ws.send(JSON.stringify({ type: "joined", code }));
      broadcastPlayerList(code);
    }

    // START
    if (data.type === "start") {
      const room = rooms[ws.room];
      if (!room) return;

      const playerCount = Object.keys(room.players).length;
      if (playerCount < 2) {
        ws.send(JSON.stringify({ type: "error", message: "Need at least 2 players to start!" }));
        return;
      }
      if (id !== room.hostId) {
        ws.send(JSON.stringify({ type: "error", message: "Only the host can start" }));
        return;
      }

      room.gameStarted = true;
      broadcastToRoom(ws.room, { type: "gameStart" });

      startCountdown(room, () => {
        startRound(room);
        room.centerPhase = false;
      });
    }

    // TURNING
    if (data.type === "turn") {
      const room = rooms[ws.room];
      if (!room) return;
      const p = room.players[id];
      if (!p || !p.alive) return;
      // data.dir: -1 (left), 0 (straight), 1 (right)
      if (data.dir === -1 || data.dir === 0 || data.dir === 1) {
        p.turning = data.dir;
      }
    }
  });

  ws.on("close", () => {
    const room = rooms[ws.room];
    if (room) {
      delete room.players[id];
      if (Object.keys(room.players).length === 0) {
        delete rooms[ws.room];
      } else {
        broadcastPlayerList(ws.room);
      }
    }
  });
});

// ── HELPERS ──
function broadcastPlayerList(code) {
  if (!rooms[code]) return;
  const names = {};
  for (let id in rooms[code].players) {
    names[id] = {
      name: rooms[code].players[id].name,
      color: rooms[code].players[id].color,
    };
  }
  broadcastToRoom(code, { type: "playerList", players: names });
}

function broadcastToRoom(code, data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.room === code && client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// ── GAME LOOP (60fps) ──
function gameLoop() {
  for (let code in rooms) {
    const room = rooms[code];
    const players = room.players;

    // Move during active round
    if (room.roundActive) {
      const currentSpeed = getRoomSpeed(room);
      room.currentSpeed = currentSpeed;
      for (let id in players) {
        const p = players[id];
        if (!p.alive) continue;
        movePlayer(p, currentSpeed);
        if (checkCollision(p, players)) {
          p.alive = false;
        }
      }
    }

    // Check round winner
    const totalPlayers = Object.keys(players).length;
    const alive = Object.values(players).filter((p) => p.alive);

    if (room.roundActive && totalPlayers >= 2) {
      if (alive.length <= 1) {
        room.roundActive = false;

        if (alive.length === 1) {
          const winner = alive[0];
          winner.score++;

          if (winner.score >= 3) {
            // Match win
            room.matchWinner = winner.name;
            setTimeout(() => {
              for (let id in players) {
                players[id].score = 0;
                players[id].trail = [];
                players[id].alive = true;
                players[id].turning = 0;
              }
              room.matchWinner = null;
              startCountdown(room, () => {
                startRound(room);
                room.centerPhase = false;
              });
            }, 4000);
          } else {
            // Next round
            setTimeout(() => {
              startCountdown(room, () => {
                startRound(room);
                room.centerPhase = false;
              });
            }, 2000);
          }
        } else {
          // Draw - all dead
          setTimeout(() => {
            startCountdown(room, () => {
              startRound(room);
              room.centerPhase = false;
            });
          }, 2000);
        }
      }
    }

    // Broadcast state
    // Send minimal trail data — only send every Nth point to reduce bandwidth
    const compactPlayers = {};
    for (let id in players) {
      const p = players[id];
      compactPlayers[id] = {
        name: p.name,
        x: Math.round(p.x * 10) / 10,
        y: Math.round(p.y * 10) / 10,
        angle: Math.round(p.angle * 100) / 100,
        trail: p.trail,
        alive: p.alive,
        score: p.score,
        color: p.color,
      };
    }

    // Calculate round elapsed time
    const roundElapsed = room.roundStartTime
      ? Math.floor((Date.now() - room.roundStartTime) / 1000)
      : 0;

    const state = JSON.stringify({
      type: "state",
      players: compactPlayers,
      winner: room.matchWinner,
      center: room.centerPhase,
      countdown: room.countdown || 0,
      speed: room.currentSpeed || BASE_SPEED,
      elapsed: roundElapsed,
      mapW: CANVAS_W,
      mapH: CANVAS_H,
    });

    wss.clients.forEach((client) => {
      if (client.room === code && client.readyState === WebSocket.OPEN) {
        client.send(state);
      }
    });
  }
}

setInterval(gameLoop, 1000 / 60);

server.listen(PORT, () => {
  console.log("Server running http://localhost:" + PORT);
});
