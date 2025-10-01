// server.js — вертикальный Pong с выбором из 4 столов
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.get("/", (_, res) => res.send("Pong server is running!"));

// 4 стола для игры
const tables = {
  table1: { waiting: null, room: null },
  table2: { waiting: null, room: null },
  table3: { waiting: null, room: null },
  table4: { waiting: null, room: null }
};

// roomId -> { players:[idTop,idBottom], state, inputs, tableId }
const rooms = new Map();

// базовое состояние игры
function newGameState(w, h) {
  return {
    w, h,
    ball: { x: w / 2, y: h / 2, vx: 0.28, vy: 0.36, r: 8 },
    p1: { x: w / 2, vx: 0, score: 0 }, // верхняя
    p2: { x: w / 2, vx: 0, score: 0 }, // нижняя
    paddle: { w: 90, h: 14, margin: 18, speed: 0.6 },
    running: true,
    maxScore: 10
  };
}

// случайный перезапуск мяча из центра
function relaunchBall(s) {
  s.ball.x = s.w / 2;
  s.ball.y = s.h / 2;
  const sign = () => (Math.random() < 0.5 ? -1 : 1);
  s.ball.vx = sign() * (0.24 + Math.random() * 0.06);
  s.ball.vy = sign() * (0.30 + Math.random() * 0.08);
}

// получить статус всех столов
function getTablesStatus() {
  return {
    table1: tables.table1.waiting ? 'waiting' : (tables.table1.room ? 'playing' : 'free'),
    table2: tables.table2.waiting ? 'waiting' : (tables.table2.room ? 'playing' : 'free'),
    table3: tables.table3.waiting ? 'waiting' : (tables.table3.room ? 'playing' : 'free'),
    table4: tables.table4.waiting ? 'waiting' : (tables.table4.room ? 'playing' : 'free')
  };
}

io.on("connection", (socket) => {
  console.log(`Player connected: ${socket.id}`);
  
  // отправляем статус столов
  socket.emit('tables_status', getTablesStatus());

  // игрок выбирает стол
  socket.on('join_table', (tableId) => {
    const table = tables[tableId];
    if (!table) {
      socket.emit('error', 'Стол не существует');
      return;
    }

    if (table.room) {
      socket.emit('error', 'Стол занят');
      return;
    }

    if (table.waiting && table.waiting.connected) {
      // есть ожидающий игрок — начинаем игру
      const top = table.waiting;
      const bottom = socket;
      table.waiting = null;

      const room = `${tableId}_${Date.now()}`;
      top.join(room);
      bottom.join(room);

      const W = 360, H = 640;
      const state = newGameState(W, H);
      const inputs = {
        [top.id]: { left: false, right: false },
        [bottom.id]: { left: false, right: false }
      };
      
      rooms.set(room, { 
        players: [top.id, bottom.id], 
        state, 
        inputs,
        tableId 
      });
      
      table.room = room;

      io.to(room).emit("start", {
        room,
        sideOf: { [top.id]: "top", [bottom.id]: "bottom" }
      });

      // обновляем статус столов для всех
      io.emit('tables_status', getTablesStatus());
      
      console.log(`Game started at ${tableId}: ${top.id} vs ${bottom.id}`);
    } else {
      // становимся ожидающим игроком
      table.waiting = socket;
      socket.emit("waiting", `Ждём соперника за столом ${tableId.slice(-1)}…`);
      
      // обновляем статус столов для всех
      io.emit('tables_status', getTablesStatus());
      
      console.log(`Player ${socket.id} waiting at ${tableId}`);
    }
  });

  // управление
  socket.on("input", ({ room, left, right }) => {
    const r = rooms.get(room);
    if (!r) return;
    r.inputs[socket.id] = { left: !!left, right: !!right };
  });

  socket.on("disconnect", () => {
    console.log(`Player disconnected: ${socket.id}`);
    
    // убираем из ожидания
    for (const tableId in tables) {
      if (tables[tableId].waiting === socket) {
        tables[tableId].waiting = null;
      }
    }

    // завершаем активные игры
    for (const [room, r] of rooms.entries()) {
      if (r.players.includes(socket.id)) {
        io.to(room).emit("gameover", { reason: "Соперник отключился" });
        
        // освобождаем стол
        const table = tables[r.tableId];
        if (table) table.room = null;
        
        rooms.delete(room);
      }
    }

    // обновляем статус столов
    io.emit('tables_status', getTablesStatus());
  });
});

// игровой цикл (30 Гц)
const TICK_MS = 33;
setInterval(() => {
  for (const [room, r] of rooms.entries()) {
    const s = r.state;
    if (!s.running) continue;

    const [idTop, idBottom] = r.players;
    const inpTop = r.inputs[idTop] || { left: false, right: false };
    const inpBot = r.inputs[idBottom] || { left: false, right: false };

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

    // отскок от боковых стен
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
        s.ball.vy = Math.abs(s.ball.vy) * 1.02;
        const offset = (s.ball.x - s.p1.x) / half;
        s.ball.vx += offset * 0.03;
      }
    }

    // столкновение с нижней ракеткой
    if (s.ball.vy > 0 && s.ball.y + s.ball.r >= botY) {
      const half = s.paddle.w / 2;
      if (s.ball.x >= s.p2.x - half && s.ball.x <= s.p2.x + half) {
        s.ball.vy = -Math.abs(s.ball.vy) * 1.02;
        const offset = (s.ball.x - s.p2.x) / half;
        s.ball.vx += offset * 0.03;
      }
    }

    // гол
    if (s.ball.y + s.ball.r < 0) {
      s.p2.score += 1;
      relaunchBall(s);
    } else if (s.ball.y - s.ball.r > s.h) {
      s.p1.score += 1;
      relaunchBall(s);
    }

    // проверка победы (до 10 очков)
    if (s.p1.score >= s.maxScore || s.p2.score >= s.maxScore) {
      s.running = false;
      const winner = s.p1.score >= s.maxScore ? "Верхний игрок" : "Нижний игрок";
      io.to(room).emit("gameover", { 
        reason: `Победа! ${winner} выиграл ${Math.max(s.p1.score, s.p2.score)}:${Math.min(s.p1.score, s.p2.score)}`,
        finalScore: { top: s.p1.score, bottom: s.p2.score }
      });
      
      // освобождаем стол
      const table = tables[r.tableId];
      if (table) table.room = null;
      
      rooms.delete(room);
      
      // обновляем статус столов
      io.emit('tables_status', getTablesStatus());
    }

    io.to(room).emit("state", { ...s, room });
  }
}, TICK_MS);

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => console.log(`Server running on ${port}`));
