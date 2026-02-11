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
const io = new Server(server, { cors: { origin: "*" } });

const JWT_SECRET = process.env.JWT_SECRET || 'secret';
let onlineCount = 0;

// 権限レベルの定義 (サーバー側で厳格管理)
const ROLES = { OWNER: 100, ADMIN: 50, MODERATOR: 20, USER: 0 };

// --- 認証API ---
app.post('/api/register', async (req, res) => {
  try {
    const hashedPassword = await bcrypt.hash(req.body.password, 10);
    // 最初の登録者のみをOWNERにする（あなた専用）
    const userCount = await prisma.user.count();
    const role = userCount === 0 ? "OWNER" : "USER";

    await prisma.user.create({ 
      data: { username: req.body.username, password: hashedPassword, role: role } 
    });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ success: false }); }
});

app.post('/api/login', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { username: req.body.username } });
  if (user && await bcrypt.compare(req.body.password, user.password)) {
    if (user.isBanned) return res.status(403).json({ success: false, message: "BANされています" });
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET);
    res.json({ 
      success: true, token, username: user.username, userId: user.id, role: user.role 
    });
  } else { res.status(401).json({ success: false }); }
});

// --- Socket.io ---
io.on('connection', async (socket) => {
  onlineCount++;
  io.emit('online count', onlineCount);

  const rawMessages = await prisma.message.findMany({ take: 50, orderBy: { createdAt: 'desc' } });
  socket.emit('load messages', rawMessages.reverse());

  socket.on('chat message', async (data) => {
    const user = await prisma.user.findUnique({ where: { username: data.user } });
    if (!user || user.isBanned) return;
    const savedMsg = await prisma.message.create({
      data: { user: data.user, text: data.text, userId: String(user.id), role: user.role }
    });
    io.emit('chat message', savedMsg);
  });

  // 【階層型管理コマンド】
  socket.on('admin command', async (data) => {
    const op = await prisma.user.findUnique({ where: { id: Number(data.myId) } });
    const tg = await prisma.user.findUnique({ where: { id: Number(data.targetId) } });
    if (!op || !tg) return;

    const opLevel = ROLES[op.role] || 0;
    const tgLevel = ROLES[tg.role] || 0;

    // 格上または同格への操作はサーバー側で拒否
    if (opLevel <= tgLevel) return console.log("権限不足: 格上への操作");

    if (data.type === 'ban' && opLevel >= ROLES.ADMIN) {
      await prisma.user.update({ where: { id: tg.id }, data: { isBanned: true } });
      io.emit('system message', `${tg.username} は追放されました`);
    } else if (data.type === 'promote' && opLevel === ROLES.OWNER) {
      await prisma.user.update({ where: { id: tg.id }, data: { role: data.newRole } });
      io.emit('system message', `${tg.username} は ${data.newRole} に任命されました`);
    }
  });

  socket.on('disconnect', () => { onlineCount--; io.emit('online count', onlineCount); });
});

server.listen(3000, () => console.log('Absolute Admin Server running'));
