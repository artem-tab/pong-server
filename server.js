// server.js — вертикальный Pong: ракетки сверху/снизу, мяч медленнее на 20%
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.get("/", (_, res) => res.send("Pong server is running!"));

// очередь на матч
let waiting = null;
// roomId -> { players:[idTop,idBottom], state, inputs }
const rooms = new Map();

// базовое состояние игры
function newGameState(w, h) {
  return {
    w, h,
    // скорость мяча на 20% ниже прежней (было ~0.35/0.45 на мс)
    ball: { x: w / 2, y: h / 2, vx: 0.28, vy: 0.36, r: 8 },
    // теперь ракетки двигаются по X (влево/вправо), стоят Y-константами (сверху/снизу)
    p1: { x: w / 2, vx: 0, score: 0 }, // верхняя
    p2: { x: w / 2, vx: 0, score: 0 }, // нижняя
    paddle: { w: 90, h: 14, margin: 18, speed: 0.6 }, // ширина ракетки по X
    running: true
  };
}

// случайный перезапуск мяча из центра в любую сторону
function relaunchBall(s) {
  s.ball.x = s.w / 2;
  s.ball.y = s.h / 2;
  const sign = () => (Math.random() < 0.5 ? -1 : 1);
  // небольшая вариативность скоростей, ~20% ниже базовых
  s.ball.vx = sign() * (0.24 + Math.random() * 0.06);
  s.ball.vy = sign() * (0.30 + Math.random() * 0.08);
}

io.on("connection", (socket) => {
  if (waiting && waiting.connected) {
    // формируем комнату: первый игрок — верхняя ракетка, второй — нижняя
    const top = waiting;
    const bottom = socket;
    waiting = null;

    const room = `r_${top.id}_${bottom.id}_${Date.now()}`;
    top.join(room);
    bottom.join(room);

    const W = 360, H = 640; // портретная база, клиент масштабирует
    const state = newGameState(W, H);
    const inputs = {
      [top.id]: { left: false, right: false },
      [bottom.id]: { left: false, right: false }
    };
    rooms.set(room, { players: [top.id, bottom.id], state, inputs });

    io.to(room).emit("start", {
      room,
      sideOf: { [top.id]: "top", [bottom.id]: "bottom" }
    });
  } else {
    waiting = socket;
    socket.emit("waiting", "Ждём соперника…");
  }

  // принимаем управление: left/right вместо up/down
  socket.on("input", ({ room, left, right }) => {
    const r = rooms.get(room);
    if (!r) return;
    r.inputs[socket.id] = { left: !!left, right: !!right };
  });

  socket.on("disconnect", () => {
    if (waiting === socket) waiting = null;
    for (const [room, r] of rooms.entries()) {
      if (r.players.includes(socket.id)) {
        io.to(room).emit("gameover", { reason: "opponent_left" });
        rooms.delete(room);
      }
    }
  });
});

// игровой цикл (30 Гц)
const TICK_MS = 33;
setInterval(() => {
  for (const [room, r] of rooms.entries()) {
    const s = r.state;
    const [idTop, idBottom] = r.players;
    const inpTop = r.inputs[idTop] || { left: false, right: false };
    const inpBot = r.inputs[idBottom] || { left: false, right: false };

    // скорость ракеток НЕ меняем (только мяч замедлили)
    const sp = s.paddle.speed;

    // верхняя ракетка
    s.p1.vx = (inpTop.left ? -sp : 0) + (inpTop.right ? sp : 0);
    s.p1.x += s.p1.vx * TICK_MS;
    s.p1.x = Math.max(s.paddle.w / 2 + s.paddle.margin,
                      Math.min(s.w - s.paddle.w / 2 - s.paddle.margin, s.p1.x));

    // нижняя ракетка
    s.p2.vx = (inpBot.left ? -sp : 0) + (inpBot.right ? sp : 0);
    s.p2.x += s.p2.vx * TICK_MS;
    s.p2.x = Math.max(s.paddle.w / 2 + s.paddle.margin,
                      Math.min(s.w - s.paddle.w / 2 - s.paddle.margin, s.p2.x));

    // мяч
    s.ball.x += s.ball.vx * TICK_MS;
    s.ball.y += s.ball.vy * TICK_MS;

    // отскок от боковых стен (лево/право)
    if (s.ball.x - s.ball.r <= 0 || s.ball.x + s.ball.r >= s.w) {
      s.ball.vx *= -1;
    }

    // координаты ракеток по Y
    const topY = s.paddle.margin;
    const botY = s.h - s.paddle.margin - s.paddle.h;

    // столкновение с верхней ракеткой
    if (s.ball.vy < 0 && s.ball.y - s.ball.r <= topY + s.paddle.h) {
      const half = s.paddle.w / 2;
      if (s.ball.x >= s.p1.x - half && s.ball.x <= s.p1.x + half) {
        s.ball.vy = Math.abs(s.ball.vy) * 1.02; // вниз
        // добавим «срез»: куда попал мяч относительно центра ракетки
        const offset = (s.ball.x - s.p1.x) / half;
        s.ball.vx += offset * 0.03;
      }
    }

    // столкновение с нижней ракеткой
    if (s.ball.vy > 0 && s.ball.y + s.ball.r >= botY) {
      const half = s.paddle.w / 2;
      if (s.ball.x >= s.p2.x - half && s.ball.x <= s.p2.x + half) {
        s.ball.vy = -Math.abs(s.ball.vy) * 1.02; // вверх
        const offset = (s.ball.x - s.p2.x) / half;
        s.ball.vx += offset * 0.03;
      }
    }

    // гол (вылет за пределы по Y)
    if (s.ball.y + s.ball.r < 0) {
      // мяч ушёл за верх — очко нижнему
      s.p2.score += 1;
      relaunchBall(s);
    } else if (s.ball.y - s.ball.r > s.h) {
      // мяч ушёл за низ — очко верхнему
      s.p1.score += 1;
      relaunchBall(s);
    }

    io.to(room).emit("state", { ...s, room });
  }
}, TICK_MS);

// один listen, без дублирования PORT
const port = Number(process.env.PORT) || 3000;
server.listen(port, () => console.log(`Server running on ${port}`));
