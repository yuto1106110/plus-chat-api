const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());

// --- 1. MongoDB 接続設定 ---
const MONGO_URI = process.env.DATABASE_URL;
mongoose.connect(MONGO_URI, {
    maxPoolSize: 50,
    serverSelectionTimeoutMS: 5000,
})
.then(() => console.log("✅ MongoDB Connected!"))
.catch(err => console.error("❌ MongoDB Connection Error:", err));

// --- 2. スキーマ定義 ---
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    userId: { type: String, required: true, unique: true },
    role: { type: String, default: 'USER' },
    isBanned: { type: Boolean, default: false },
    isShadowBanned: { type: Boolean, default: false },
    muteUntil: { type: Date, default: null }
});
const User = mongoose.model('User', UserSchema);

const MessageSchema = new mongoose.Schema({
    id: Number,
    userId: String,
    user: String,
    text: String,
    role: String,
    createdAt: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', MessageSchema);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const COOLDOWN_MS = 2500;
const lastMessageTimes = new Map();

function sanitize(str) {
    if (typeof str !== 'string') return "";
    return str.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

// --- 3. API (認証) ---
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    try {
        const existing = await User.findOne({ username }).lean();
        if (existing) return res.json({ success: false, message: "既に使われています" });
        const userId = "u_" + Math.random().toString(36).substring(2, 12);
        const newUser = new User({ username, password, userId });
        await newUser.save();
        res.json({ success: true });
    } catch (e) { res.json({ success: false }); }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ username, password }).lean();
        if (!user) return res.json({ success: false, message: "認証失敗" });
        if (user.isBanned) return res.json({ success: false, message: "BANされています" });
        res.json({ success: true, userId: user.userId, username: user.username, role: user.role });
    } catch (e) { res.json({ success: false }); }
});

// --- 4. Socket.io ---
io.on('connection', async (socket) => {
    io.emit('online count', io.engine.clientsCount);

    const history = await Message.find().sort({ createdAt: -1 }).limit(50).lean();
    socket.emit('load messages', history.reverse());

    // 【重要】UIの状態表示ボックスに対応する取得イベント
    socket.on('get user status', async (targetId) => {
        try {
            const target = await User.findOne({ userId: targetId }).lean();
            if (!target) return;

            let muteStatus = "なし";
            if (target.muteUntil) {
                if (target.muteUntil > new Date()) {
                    muteStatus = target.muteUntil.getTime() > 4000000000000 ? "永久" : target.muteUntil.toLocaleString();
                }
            }

            socket.emit('user status data', {
                isBanned: target.isBanned,
                isShadowBanned: target.isShadowBanned,
                muteStatus: muteStatus
            });
        } catch (e) { console.error(e); }
    });

    socket.on('chat message', async (data) => {
        try {
            const sender = await User.findOne({ userId: data.userId }).select('username role isBanned isShadowBanned muteUntil').lean();
            if (!sender || sender.isBanned) return;

            const now = Date.now();
            if (now - (lastMessageTimes.get(data.userId) || 0) < COOLDOWN_MS) {
                return socket.emit('system message', "連投禁止です");
            }

            if (sender.muteUntil && sender.muteUntil > new Date()) {
                return socket.emit('system message', "ミュート中です");
            }

            const msgData = {
                id: now,
                userId: data.userId,
                user: sender.username,
                text: sanitize(data.text),
                role: sender.role
            };

            if (sender.isShadowBanned) {
                return socket.emit('chat message', msgData); // 本人にのみ返す
            }

            io.emit('chat message', msgData);
            lastMessageTimes.set(data.userId, now);
            new Message(msgData).save();
        } catch (e) { console.error(e); }
    });

    socket.on('admin command', async (data) => {
        try {
            const admin = await User.findOne({ userId: data.myId }).select('role').lean();
            if (!admin || (admin.role !== 'ADMIN' && admin.role !== 'OWNER')) return;

            const targetId = data.targetId;

            if (data.type === 'delete') {
                await Message.deleteOne({ id: data.msgId });
                io.emit('delete message', data.msgId);
            } else if (data.type === 'ban') {
                await User.updateOne({ userId: targetId }, { isBanned: true });
                io.emit('force logout user', targetId);
            } else if (data.type === 'unban') {
                await User.updateOne({ userId: targetId }, { isBanned: false });
            } else if (data.type === 'shadowban') {
                await User.updateOne({ userId: targetId }, { isShadowBanned: true });
            } else if (data.type === 'unshadowban') {
                await User.updateOne({ userId: targetId }, { isShadowBanned: false });
            } else if (data.type === 'mute') {
                const date = data.minutes ? new Date(Date.now() + data.minutes * 60000) : new Date(8640000000000000);
                await User.updateOne({ userId: targetId }, { muteUntil: date });
            } else if (data.type === 'unmute') {
                await User.updateOne({ userId: targetId }, { muteUntil: null });
            } else if (data.type === 'promote') {
                await User.updateOne({ userId: targetId }, { role: 'ADMIN' });
            } else if (data.type === 'demote') {
                await User.updateOne({ userId: targetId }, { role: 'USER' });
            }
        } catch (e) { console.error(e); }
    });

    socket.on('admin global command', async (data) => {
        try {
            const owner = await User.findOne({ userId: data.myId }).select('role').lean();
            if (!owner || owner.role !== 'OWNER') return;
            
            if (data.type === 'clearall') {
                await Message.deleteMany({});
                io.emit('clear all messages');
            } else if (data.type === 'kickall') {
                io.emit('force logout');
            }
        } catch (e) { console.error(e); }
    });

    socket.on('disconnect', () => { io.emit('online count', io.engine.clientsCount); });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 API Live on ${PORT}`));
