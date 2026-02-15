const express = require('express');
const { PrismaClient } = require('@prisma/client');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const prisma = new PrismaClient();
const server = http.createServer(app);

app.use(cors());
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
app.use(express.json());

const ROLES = { OWNER: 100, ADMIN: 50, USER: 0 };
let onlineUsers = new Set();

// 登録
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        const count = await prisma.user.count();
        const role = count === 0 ? 'OWNER' : 'USER';
        await prisma.user.create({ data: { username, password, role } });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

// ログイン
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await prisma.user.findUnique({ where: { username } });
        if (user && user.password === password) {
            if (user.isBanned) return res.json({ success: false, message: 'BAN中' });
            res.json({ success: true, username: user.username, userId: user.id, role: user.role });
        } else { res.json({ success: false }); }
    } catch (e) { res.status(500).json({ success: false }); }
});

io.on('connection', async (socket) => {
    onlineUsers.add(socket.id);
    io.emit('online count', onlineUsers.size);

    const msgs = await prisma.message.findMany({ take: 50, orderBy: { createdAt: 'desc' } });
    socket.emit('load messages', msgs.reverse());

    // ステータス取得用
    socket.on('get user status', async (targetId) => {
        try {
            const user = await prisma.user.findUnique({ where: { id: Number(targetId) } });
            if (!user) return;
            let muteMsg = "なし";
            if (user.isMuted) {
                if (user.muteUntil) {
                    const diff = Math.ceil((user.muteUntil - new Date()) / 60000);
                    muteMsg = diff > 0 ? `残り${diff}分` : "期限切れ";
                } else { muteMsg = "永久"; }
            }
            socket.emit('user status data', { isBanned: user.isBanned, muteStatus: muteMsg });
        } catch (e) { console.error(e); }
    });

    socket.on('chat message', async (data) => {
        try {
            const user = await prisma.user.findUnique({ where: { username: data.user } });
            if (!user || user.isBanned) return;
            if (user.isMuted) {
                if (user.muteUntil && new Date() > user.muteUntil) {
                    await prisma.user.update({ where: { id: user.id }, data: { isMuted: false, muteUntil: null } });
                } else { return; }
            }
            const newMsg = await prisma.message.create({
                data: { user: data.user, text: data.text, userId: String(user.id), role: user.role }
            });
            io.emit('chat message', newMsg);
        } catch (err) { console.error(err); }
    });

    socket.on('admin command', async (data) => {
        try {
            const op = await prisma.user.findUnique({ where: { id: Number(data.myId) } });
            const tg = await prisma.user.findUnique({ where: { id: Number(data.targetId) } });
            if (!op || !tg || ROLES[op.role] < ROLES.ADMIN) return;

            let up = {};
            if (data.type === 'mute') {
                up.isMuted = true;
                up.muteUntil = data.minutes ? new Date(Date.now() + data.minutes * 60000) : null;
            }
            if (data.type === 'unmute') { up.isMuted = false; up.muteUntil = null; }
            if (data.type === 'ban') up.isBanned = true;
            if (data.type === 'unban') up.isBanned = false;
            if (data.type === 'promote' && op.role === 'OWNER') up.role = 'ADMIN';
            if (data.type === 'demote' && op.role === 'OWNER') up.role = 'USER';

            if (Object.keys(up).length > 0) await prisma.user.update({ where: { id: tg.id }, data: up });
            if (data.type === 'delete' && data.msgId) {
                await prisma.message.delete({ where: { id: Number(data.msgId) } });
                io.emit('delete message', data.msgId);
            }
            io.emit('system message', '更新完了');
        } catch (err) { console.error(err); }
    });

    socket.on('disconnect', () => {
        onlineUsers.delete(socket.id);
        io.emit('online count', onlineUsers.size);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Ready'));
