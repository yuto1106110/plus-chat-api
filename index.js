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
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';
const ROLES = { OWNER: 100, ADMIN: 50, USER: 0 };
let onlineUsers = new Set();

// --- 認証系 ---
app.post('/api/register', async (req, res) => {
    try {
        const hashedPassword = await bcrypt.hash(req.body.password, 10);
        const userCount = await prisma.user.count();
        const role = userCount === 0 ? "OWNER" : "USER";
        await prisma.user.create({ data: { username: req.body.username, password: hashedPassword, role } });
        res.json({ success: true });
    } catch (e) { res.status(400).json({ success: false }); }
});

app.post('/api/login', async (req, res) => {
    const user = await prisma.user.findUnique({ where: { username: req.body.username } });
    if (user && await bcrypt.compare(req.body.password, user.password)) {
        if (user.isBanned) return res.status(403).json({ success: false, message: "BANされています" });
        const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET);
        res.json({ success: true, token, username: user.username, userId: user.id, role: user.role });
    } else { res.status(401).json({ success: false }); }
});

// --- Socket.io ---
io.on('connection', async (socket) => {
    onlineUsers.add(socket.id);
    io.emit('online count', onlineUsers.size);

    const msgs = await prisma.message.findMany({ take: 50, orderBy: { createdAt: 'desc' } });
    socket.emit('load messages', msgs.reverse());

    socket.on('chat message', async (data) => {
        if (!data.text || !data.user) return;
        const user = await prisma.user.findUnique({ where: { username: data.user } });
        if (!user || user.isBanned || user.isMuted) return;

        const newMsg = await prisma.message.create({
            data: { 
                user: data.user, 
                text: data.text, 
                userId: String(user.id), 
                role: user.role, 
                isBanned: user.isBanned || false, 
                isMuted: user.isMuted || false 
            }
        });

        const count = await prisma.message.count();
        if (count > 50) {
            const oldest = await prisma.message.findMany({ orderBy: { createdAt: 'asc' }, take: count - 50 });
            await prisma.message.deleteMany({ where: { id: { in: oldest.map(m => m.id) } } });
        }
        io.emit('chat message', newMsg);
    });

    socket.on('admin command', async (data) => {
        if (!data.targetId || !data.myId) return; // undefinedガード
        const op = await prisma.user.findUnique({ where: { id: Number(data.myId) } });
        const tg = await prisma.user.findUnique({ where: { id: Number(data.targetId) } });
        if (!op || !tg) return;

        let updateData = {};
        const opLevel = ROLES[op.role] || 0;
        const tgLevel = ROLES[tg.role] || 0;

        if (opLevel >= ROLES.ADMIN && opLevel > tgLevel) {
            if (data.type === 'delete' && data.msgId) {
                await prisma.message.delete({ where: { id: Number(data.msgId) } });
                return io.emit('delete message', data.msgId);
            }
            if (data.type === 'mute') updateData = { isMuted: true };
            if (data.type === 'unmute') updateData = { isMuted: false };
        }

        if (op.role === 'OWNER' && op.id !== tg.id) {
            if (data.type === 'promote') updateData = { role: 'ADMIN' };
            if (data.type === 'demote') updateData = { role: 'USER' };
            if (data.type === 'ban') updateData = { isBanned: true };
            if (data.type === 'unban') updateData = { isBanned: false };
        }

        if (Object.keys(updateData).length > 0) {
            const updatedUser = await prisma.user.update({ where: { id: tg.id }, data: updateData });
            io.emit('user updated', { 
                userId: String(updatedUser.id), 
                role: updatedUser.role, 
                isBanned: updatedUser.isBanned, 
                isMuted: updatedUser.isMuted 
            });
        }
    });

    socket.on('disconnect', () => {
        onlineUsers.delete(socket.id);
        io.emit('online count', onlineUsers.size);
    });
});

server.listen(3000, () => console.log('Server running on 3000'));
