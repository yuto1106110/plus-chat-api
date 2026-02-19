const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();

// --- セキュリティ対策：CORS設定をルートの最初に配置 ---
app.use(cors({
    origin: "*", 
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"]
}));
app.use(express.json());

// --- データベース接続 ---
const MONGO_URI = process.env.DATABASE_URL;
mongoose.connect(MONGO_URI, { maxPoolSize: 50 }).then(() => console.log("✅ DB Connected"));

// --- スキーマ定義 ---
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    userId: { type: String, required: true, unique: true },
    role: { type: String, default: 'USER' },
    isBanned: { type: Boolean, default: false },
    isShadowBanned: { type: Boolean, default: false },
    muteUntil: { type: Date, default: null },
    nameColor: { type: String, default: '#3ea6ff' }
});
const User = mongoose.model('User', UserSchema);

const MessageSchema = new mongoose.Schema({
    id: Number, userId: String, user: String, text: String, role: String, color: String,
    isEdited: { type: Boolean, default: false },
    replyTo: { type: Object, default: null },
    createdAt: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', MessageSchema);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- 防衛システム用変数 ---
const spamTrack = new Map();
const AUTO_MUTE_MINUTES = 10;
const SPAM_THRESHOLD = 5;
const SPAM_INTERVAL = 3000;

function sanitize(str) {
    if (!str) return "";
    return String(str).replace(/[&<>"']/g, m => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
}

// --- API ルート ---
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (await User.findOne({ username }).lean()) return res.json({ success: false, message: "この名前は使用されています" });
        const userId = "u_" + Math.random().toString(36).substring(2, 12);
        await new User({ username, password, userId }).save();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: "サーバーエラー" }); }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username, password }).lean();
        if (!user) return res.json({ success: false, message: "名前またはパスワードが違います" });
        if (user.isBanned) return res.json({ success: false, message: "BANされています" });
        res.json({ success: true, userId: user.userId, username: user.username, role: user.role, nameColor: user.nameColor });
    } catch (e) { res.status(500).json({ success: false, message: "サーバーエラー" }); }
});

// --- Socket.io ---
io.on('connection', async (socket) => {
    io.emit('online count', io.engine.clientsCount);
    const history = await Message.find().sort({ createdAt: -1 }).limit(50).lean();
    socket.emit('load messages', history.reverse());

    socket.on('chat message', async (data) => {
        const u = await User.findOne({ userId: data.userId }).lean();
        if (!u || u.isBanned || (u.muteUntil && u.muteUntil > new Date())) return;

        // 自動ミュートロジック
        const now = Date.now();
        const track = spamTrack.get(data.userId) || { count: 0, lastTime: now };
        if (now - track.lastTime < SPAM_INTERVAL) track.count++; else track.count = 1;
        track.lastTime = now;
        spamTrack.set(data.userId, track);

        if (track.count > SPAM_THRESHOLD) {
            const mt = new Date(now + AUTO_MUTE_MINUTES * 60000);
            await User.updateOne({ userId: data.userId }, { muteUntil: mt });
            socket.emit('system message', `連投防止のため${AUTO_MUTE_MINUTES}分間ミュートしました。`);
            return;
        }

        // 本文と返信先の両方をサニタイズ
        let safeReply = null;
        if (data.replyTo) {
            safeReply = { 
                id: data.replyTo.id, 
                user: sanitize(data.replyTo.user), 
                text: sanitize(data.replyTo.text) 
            };
        }

        const msg = {
            id: now, userId: data.userId, user: u.username, text: sanitize(data.text),
            role: u.role, color: u.nameColor, replyTo: safeReply, isEdited: false
        };

        if (!u.isShadowBanned) {
            io.emit('chat message', msg);
            await new Message(msg).save();
        } else {
            socket.emit('chat message', msg);
        }
    });

    // 管理者・編集・削除コマンド（中略：以前のロジックと同じものを統合）
    socket.on('edit message', async (d) => {
        const msg = await Message.findOne({ id: d.msgId });
        if (msg && msg.userId === d.myId) {
            const st = sanitize(d.newText);
            await Message.updateOne({ id: d.msgId }, { text: st, isEdited: true });
            io.emit('update message', { id: d.msgId, text: st, isEdited: true });
        }
    });

    socket.on('admin command', async (d) => {
        const a = await User.findOne({ userId: d.myId }).lean();
        if (!a || (a.role !== 'ADMIN' && a.role !== 'OWNER')) return;
        if (d.type === 'delete') { await Message.deleteOne({ id: d.msgId }); io.emit('delete message', d.msgId); }
        else if (d.type === 'ban') { await User.updateOne({ userId: d.targetId }, { isBanned: true }); io.emit('force logout user', d.targetId); }
        else if (d.type === 'unban') { await User.updateOne({ userId: d.targetId }, { isBanned: false }); }
        else if (d.type === 'mute') {
            const dt = d.minutes ? new Date(Date.now() + d.minutes * 60000) : new Date(253402214400000);
            await User.updateOne({ userId: d.targetId }, { muteUntil: dt });
        }
    });

    socket.on('admin global command', async (d) => {
        const o = await User.findOne({ userId: d.myId }).lean();
        if (o && o.role === 'OWNER') {
            if (d.type === 'clearall') { await Message.deleteMany({}); io.emit('clear all messages'); }
            else if (d.type === 'kickall') io.emit('force logout');
        }
    });

    socket.on('disconnect', () => io.emit('online count', io.engine.clientsCount));
});

server.listen(process.env.PORT || 10000, () => console.log("🚀 Server Ready"));

