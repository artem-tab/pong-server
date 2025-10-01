import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// Проверка, что сервер работает
app.get("/", (req, res) => {
  res.send("Pong server is running!");
});

// Простая очередь для матчинга игроков
let waitingPlayer = null;

io.on("connection", (socket) => {
  console.log("New connection:", socket.id);

  if (waitingPlayer) {
    // Создаём комнату из двух игроков
    const room = `room_${waitingPlayer.id}_${socket.id}`;
    socket.join(room);
    waitingPlayer.join(room);

    io.to(room).emit("start", { room });
    waitingPlayer = null;
  } else {
    waitingPlayer = socket;
    socket.emit("waiting", "Ждём соперника...");
  }

  socket.on("input", (data) => {
    // Передаём сигналы второму игроку
    socket.to(data.room).emit("input", data);
  });

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);
    if (waitingPlayer === socket) {
      waitingPlayer = null;
    }
  });
});

// Render подставит порт через переменную окружения
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));
