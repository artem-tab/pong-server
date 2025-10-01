// server.js — авторитетная физика Pong (2 игрока, 30 тиков/сек)
import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.get("/", (_, res) => res.send("Pong server is running!"));

let waiting = null;
const rooms = new Map(); // roomId -> { players:[idA,idB], state, inputs }

function newGameState(w, h) {
  return {
    w, h,
    ball: { x: w/2, y: h/2, vx: 0.35, vy: 0.45, r: 8 },
    p1: { y: h/2, vy: 0, score: 0 },
    p2: { y: h/2, vy: 0, score: 0 },
    paddle: { w: 14, h: 90, margin: 18, speed: 0.6 },
    running: true
  };
}

io.on("connection", (socket) => {
  // матчмейкинг 1×1
  if (waiting && waiting.connected) {
    const a = waiting; const b = socket;
    waiting = null;
    const room = `r_${a.id}_${b.id}_${Date.now()}`;
    a.join(room); b.join(room);

    // вертикальное поле адаптивно (мобильный портрет), но зададим базу
    const W = 360, H = 640;
    const state = newGameState(W, H);
    const inputs = { [a.id]: { up:false, down:false }, [b.id]: { up:false, down:false } };
    rooms.set(room, { players:[a.id,b.id], state, inputs });

    io.to(room).emit("start", { room, sideOf: { [a.id]:"left", [b.id]:"right" } });
  } else {
    waiting = socket;
    socket.emit("waiting", "Ждём соперника…");
  }

  socket.on("input", ({ room, up, down }) => {
    const r = rooms.get(room);
    if (!r) return;
    r.inputs[socket.id] = { up: !!up, down: !!down };
  });

  socket.on("disconnect", () => {
    // если игрок был в очереди
    if (waiting === socket) waiting = null;

    // если игрок был в комнате — завершаем матч
    for (const [room, r] of rooms.entries()) {
      if (r.players.includes(socket.id)) {
        io.to(room).emit("gameover", { reason: "opponent_left" });
        rooms.delete(room);
      }
    }
  });
});

// игровой цикл для всех комнат
const TICK_MS = 33; // ~30 Гц
setInterval(() => {
  for (const [room, r] of rooms.entries()) {
    const s = r.state;
    const [idL, idR] = r.players;
    const inpL = r.inputs[idL] || {up:false,down:false};
    const inpR = r.inputs[idR] || {up:false,down:false};

    // апдейты ракеток
    s.p1.vy = (inpL.up ? -s.paddle.speed : 0) + (inpL.down ? s.paddle.speed : 0);
    s.p2.vy = (inpR.up ? -s.paddle.speed : 0) + (inpR.down ? s.paddle.speed : 0);
    s.p1.y = Math.max(s.paddle.h/2, Math.min(s.h - s.paddle.h/2, s.p1.y + s.p1.vy*TICK_MS));
    s.p2.y = Math.max(s.paddle.h/2, Math.min(s.h - s.paddle.h/2, s.p2.y + s.p2.vy*TICK_MS));

    // мяч
    s.ball.x += s.ball.vx * TICK_MS;
    s.ball.y += s.ball.vy * TICK_MS;

    // отскок по вертикали
    if (s.ball.y - s.ball.r <= 0 || s.ball.y + s.ball.r >= s.h) s.ball.vy *= -1;

    // столкновения с ракетками
    const leftX  = s.paddle.margin + s.paddle.w;
    const rightX = s.w - s.paddle.margin - s.paddle.w;

    // левая
    if (s.ball.x - s.ball.r <= leftX) {
      const top = s.p1.y - s.paddle.h/2, bot = s.p1.y + s.paddle.h/2;
      if (s.ball.y >= top && s.ball.y <= bot) {
        s.ball.vx = Math.abs(s.ball.vx) * 1.02; // ускоряем немного
      } else {
        s.p2.score += 1; // пропуск
        Object.assign(s, newGameState(s.w, s.h)); s.p2.score -= 0; s.p1.score -= 0; // сохраним очки
        s.p1.score = r.state.p1.score; s.p2.score = r.state.p2.score;
      }
    }

    // правая
    if (s.ball.x + s.ball.r >= rightX) {
      const top = s.p2.y - s.paddle.h/2, bot = s.p2.y + s.paddle.h/2;
      if (s.ball.y >= top && s.ball.y <= bot) {
        s.ball.vx = -Math.abs(s.ball.vx) * 1.02;
      } else {
        s.p1.score += 1;
        Object.assign(s, newGameState(s.w, s.h)); s.p1.score -= 0; s.p2.score -= 0;
        s.p1.score = r.state.p1.score; s.p2.score = r.state.p2.score;
      }
    }

    io.to(room).emit("state", { ...s, room });
  }
}, TICK_MS);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));
