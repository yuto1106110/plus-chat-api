const express = require('express');
const { PrismaClient } = require('@prisma/client');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const prisma = new PrismaClient();
const server = http.createServer(app);

// --- 修正ポイント1: CORSを全許可に ---
app.use(cors()); 

const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

app.use(express.json());

const ROLES = { OWNER: 100, ADMIN: 50, USER: 0 };

// --- オンライン管理 ---
let onlineUsers = new Set();

// 登録API
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ success: false, message: "入力が足りません" });
        
        const count = await prisma.user.count();
        const role = count === 0 ? 'OWNER' : 'USER';
        
        await prisma.user.create({ data: { username, password, role } });
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "登録失敗（既に存在する名前かもしれません）" });
    }
});

// ログインAPI
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await prisma.user.findUnique({ where: { username } });
        if (user && user.password === password) {
            if (user.isBanned) return res.json({ success: false, message: 'BANされています' });
            res.json({ success: true, username: user.username, userId: user.id, role: user.role });
        } else {
            res.json({ success: false, message: "ユーザー名またはパスワードが違います" });
        }
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// --- Socket.io ---
io.on('connection', async (socket) => {
    onlineUsers.add(socket.id);
    io.emit('online count', onlineUsers.size);

    // 履歴読み込み
    try {
        const msgs = await prisma.message.findMany({ take: 50, orderBy: { createdAt: 'desc' } });
        socket.emit('load messages', msgs.reverse());
    } catch (err) { console.error(err); }

    // メッセージ送信
    socket.on('chat message', async (data) => {
        if (!data || !data.text || !data.user) return;
        try {
            const user = await prisma.user.findUnique({ where: { username: data.user } });
            if (!user || user.isBanned) return;

            // ミュート自動解除判定
            if (user.isMuted) {
                if (user.muteUntil && new Date() > user.muteUntil) {
                    await prisma.user.update({ where: { id: user.id }, data: { isMuted: false, muteUntil: null } });
                } else {
                    return; // まだミュート中
                }
            }

            const newMsg = await prisma.message.create({
                data: { 
                    user: data.user, 
                    text: data.text, 
                    userId: String(user.id), 
                    role: user.role 
                }
            });
            io.emit('chat message', newMsg);
        } catch (err) { console.error(err); }
    });

    // 管理コマンド
    socket.on('admin command', async (data) => {
        try {
            const op = await prisma.user.findUnique({ where: { id: Number(data.myId) } });
            const tg = await prisma.user.findUnique({ where: { id: Number(data.targetId) } });
            if (!op || !tg || ROLES[op.role] < ROLES.ADMIN) return;

            let updateData = {};
            if (data.type === 'mute') {
                updateData.isMuted = true;
                updateData.muteUntil = data.minutes ? new Date(Date.now() + data.minutes * 60000) : null;
            }
            if (data.type === 'unmute') { updateData.isMuted = false; updateData.muteUntil = null; }
            if (data.type === 'ban') updateData.isBanned = true;
            if (data.type === 'unban') updateData.isBanned = false;
            if (data.type === 'promote' && op.role === 'OWNER') updateData.role = 'ADMIN';
            if (data.type === 'demote' && op.role === 'OWNER') updateData.role = 'USER';

            if (Object.keys(updateData).length > 0) {
                await prisma.user.update({ where: { id: tg.id }, data: updateData });
                io.emit('system message', `${tg.username}のステータスを更新しました`);
            }
            if (data.type === 'delete' && data.msgId) {
                await prisma.message.delete({ where: { id: Number(data.msgId) } });
                io.emit('delete message', data.msgId);
            }
        } catch (err) { console.error(err); }
    });

    socket.on('disconnect', () => {
        onlineUsers.delete(socket.id);
        io.emit('online count', onlineUsers.size);
    });
});

// --- 修正ポイント2: PortをRender環境に合わせる ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
