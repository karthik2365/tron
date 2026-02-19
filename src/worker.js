// ── Cloudflare Worker Entry Point ──
export default {
    async fetch(request, env) {
        // Handle WebSocket upgrade → route to Durable Object
        const upgradeHeader = request.headers.get("Upgrade");
        if (upgradeHeader && upgradeHeader.toLowerCase() === "websocket") {
            const id = env.GAME_SERVER.idFromName("main");
            const obj = env.GAME_SERVER.get(id);
            return obj.fetch(request);
        }

        // Everything else → serve static assets
        return env.ASSETS.fetch(request);
    },
};

// ── Game Constants ──
const CANVAS_W = 1400;
const CANVAS_H = 900;
const BASE_SPEED = 2.5;
const SPEED_INCREMENT = 0.5;
const SPEED_INTERVAL = 10;
const MAX_SPEED = 8;
const TURN_SPEED = 0.045;
const TRAIL_MAX = 5000;
const COLLISION_RADIUS = 4;
const COLLISION_SKIP_OWN = 20;

const COLORS = ["#00ffff", "#ff2e63", "#00ff88", "#ffaa00"];

const spawnConfigs = [
    { x: 250, y: 200, angle: Math.PI * 0.25 },
    { x: 1150, y: 200, angle: Math.PI * 0.75 },
    { x: 1150, y: 700, angle: Math.PI * 1.25 },
    { x: 250, y: 700, angle: Math.PI * 1.75 },
];

// ── Durable Object: GameServer ──
export class GameServer {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        this.rooms = {};
        this.sessions = new Map(); // ws → { id, room }
        this.gameLoopInterval = null;
    }

    async fetch(request) {
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.handleSession(server);
        return new Response(null, { status: 101, webSocket: client });
    }

    // ── Session Handling ──
    handleSession(ws) {
        ws.accept();

        const id = Math.random().toString(36).substr(2, 9);
        const session = { id, ws, room: null };
        this.sessions.set(ws, session);

        ws.send(JSON.stringify({ type: "init", id }));

        // Start game loop if not already running
        if (!this.gameLoopInterval) {
            this.gameLoopInterval = setInterval(() => this.gameLoop(), 1000 / 60);
        }

        ws.addEventListener("message", (event) => {
            let data;
            try {
                data = JSON.parse(event.data);
            } catch (e) {
                return;
            }
            this.handleMessage(session, data);
        });

        ws.addEventListener("close", () => {
            this.handleClose(session);
            this.sessions.delete(ws);

            // Stop game loop if no sessions left
            if (this.sessions.size === 0 && this.gameLoopInterval) {
                clearInterval(this.gameLoopInterval);
                this.gameLoopInterval = null;
            }
        });

        ws.addEventListener("error", () => {
            this.handleClose(session);
            this.sessions.delete(ws);
        });
    }

    // ── Message Router ──
    handleMessage(session, data) {
        const { id, ws } = session;

        // HOST
        if (data.type === "create") {
            const code = this.generateRoomCode();
            this.rooms[code] = {
                players: {},
                roundActive: false,
                centerPhase: false,
                gameStarted: false,
                matchWinner: null,
                hostId: id,
                countdown: 0,
                roundStartTime: null,
                currentSpeed: BASE_SPEED,
            };
            session.room = code;
            this.rooms[code].players[id] = this.createPlayer(id, 0, data.name);
            ws.send(JSON.stringify({ type: "roomCreated", code }));
            this.broadcastPlayerList(code);
        }

        // JOIN
        if (data.type === "join") {
            const code = data.code;
            if (!this.rooms[code]) {
                ws.send(JSON.stringify({ type: "error", message: "Room not found" }));
                return;
            }
            const playerCount = Object.keys(this.rooms[code].players).length;
            if (playerCount >= 4) {
                ws.send(JSON.stringify({ type: "error", message: "Room is full (max 4)" }));
                return;
            }
            if (this.rooms[code].gameStarted) {
                ws.send(JSON.stringify({ type: "error", message: "Game already in progress" }));
                return;
            }

            this.rooms[code].players[id] = this.createPlayer(id, playerCount, data.name);
            session.room = code;
            ws.send(JSON.stringify({ type: "joined", code }));
            this.broadcastPlayerList(code);
        }

        // START
        if (data.type === "start") {
            const room = this.rooms[session.room];
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
            this.broadcastToRoom(session.room, { type: "gameStart" });
            this.startCountdown(room, () => {
                this.startRound(room);
                room.centerPhase = false;
            });
        }

        // TURNING
        if (data.type === "turn") {
            const room = this.rooms[session.room];
            if (!room) return;
            const p = room.players[id];
            if (!p || !p.alive) return;
            if (data.dir === -1 || data.dir === 0 || data.dir === 1) {
                p.turning = data.dir;
            }
        }
    }

    // ── Close Handler ──
    handleClose(session) {
        const room = this.rooms[session.room];
        if (room) {
            delete room.players[session.id];
            if (Object.keys(room.players).length === 0) {
                delete this.rooms[session.room];
            } else {
                this.broadcastPlayerList(session.room);
            }
        }
    }

    // ── Helpers ──
    generateRoomCode() {
        let code;
        do {
            code = Math.floor(1000 + Math.random() * 9000).toString();
        } while (this.rooms[code]);
        return code;
    }

    createPlayer(id, index, name) {
        return {
            id,
            name: typeof name === "string" && name.trim().length > 0 ? name.trim() : "Player",
            x: CANVAS_W / 2,
            y: CANVAS_H / 2,
            angle: 0,
            turning: 0,
            trail: [],
            alive: true,
            score: 0,
            color: COLORS[index % COLORS.length],
            spawnIndex: index,
        };
    }

    getRoomSpeed(room) {
        if (!room.roundStartTime) return BASE_SPEED;
        const elapsed = (Date.now() - room.roundStartTime) / 1000;
        const boosts = Math.floor(elapsed / SPEED_INTERVAL);
        return Math.min(BASE_SPEED + boosts * SPEED_INCREMENT, MAX_SPEED);
    }

    movePlayer(p, speed) {
        p.angle += p.turning * TURN_SPEED;
        p.x += Math.cos(p.angle) * speed;
        p.y += Math.sin(p.angle) * speed;

        p.trail.push({ x: p.x, y: p.y });
        if (p.trail.length > TRAIL_MAX) p.trail.shift();

        if (p.x < 0 || p.x > CANVAS_W || p.y < 0 || p.y > CANVAS_H) {
            p.alive = false;
        }
    }

    checkCollision(p, players) {
        for (let id in players) {
            const other = players[id];
            if (!other.alive && id !== p.id) continue;

            const trail = other.trail;
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

    startRound(room) {
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

    startCountdown(room, callback) {
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

    broadcastPlayerList(code) {
        if (!this.rooms[code]) return;
        const names = {};
        for (let id in this.rooms[code].players) {
            names[id] = {
                name: this.rooms[code].players[id].name,
                color: this.rooms[code].players[id].color,
            };
        }
        this.broadcastToRoom(code, { type: "playerList", players: names });
    }

    broadcastToRoom(code, data) {
        const msg = JSON.stringify(data);
        for (const [ws, session] of this.sessions) {
            if (session.room === code) {
                try {
                    ws.send(msg);
                } catch (e) {
                    // Client disconnected
                }
            }
        }
    }

    // ── Game Loop (60fps) ──
    gameLoop() {
        for (let code in this.rooms) {
            const room = this.rooms[code];
            const players = room.players;

            // Move during active round
            if (room.roundActive) {
                const currentSpeed = this.getRoomSpeed(room);
                room.currentSpeed = currentSpeed;
                for (let id in players) {
                    const p = players[id];
                    if (!p.alive) continue;
                    this.movePlayer(p, currentSpeed);
                    if (this.checkCollision(p, players)) {
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
                            room.matchWinner = winner.name;
                            setTimeout(() => {
                                for (let id in players) {
                                    players[id].score = 0;
                                    players[id].trail = [];
                                    players[id].alive = true;
                                    players[id].turning = 0;
                                }
                                room.matchWinner = null;
                                this.startCountdown(room, () => {
                                    this.startRound(room);
                                    room.centerPhase = false;
                                });
                            }, 4000);
                        } else {
                            setTimeout(() => {
                                this.startCountdown(room, () => {
                                    this.startRound(room);
                                    room.centerPhase = false;
                                });
                            }, 2000);
                        }
                    } else {
                        // Draw
                        setTimeout(() => {
                            this.startCountdown(room, () => {
                                this.startRound(room);
                                room.centerPhase = false;
                            });
                        }, 2000);
                    }
                }
            }

            // Broadcast state
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

            for (const [ws, session] of this.sessions) {
                if (session.room === code) {
                    try {
                        ws.send(state);
                    } catch (e) {
                        // Client disconnected
                    }
                }
            }
        }
    }
}
