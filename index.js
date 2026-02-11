require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const app = express();
const prisma = new PrismaClient();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const JWT_SECRET = process.env.JWT_SECRET || 'secret';

// --- アカウント系 ---
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await prisma.user.create({ data: { username, password: hashedPassword } });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, message: "登録失敗" });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await prisma.user.findUnique({ where: { username } });
  if (user && await bcrypt.compare(password, user.password)) {
    const token = jwt.sign({ username: user.username }, JWT_SECRET);
    res.json({ success: true, token, username: user.username });
  } else {
    res.status(401).json({ success: false });
  }
});

// --- チャット通信 (オンライン人数 & 最新50件) ---
let onlineCount = 0;

io.on('connection', async (socket) => {
  onlineCount++;
  io.emit('online count', onlineCount);

  try {
    // 最新50件を新しい順に取得して、反転（古い順）させて送る
    const rawMessages = await prisma.message.findMany({
      take: 50,
      orderBy: { createdAt: 'desc' }
    });
    socket.emit('load messages', rawMessages.reverse());
  } catch (err) { console.error(err); }

  socket.on('chat message', async (data) => {
    try {
      const savedMsg = await prisma.message.create({
        data: { user: data.user, text: data.text }
      });
      io.emit('chat message', savedMsg); 
    } catch (err) { console.error(err); }
  });

  socket.on('disconnect', () => {
    onlineCount--;
    io.emit('online count', onlineCount);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));
