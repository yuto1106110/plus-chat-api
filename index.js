const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());

// MongoDB接続
const MONGO_URI = process.env.DATABASE_URL;
mongoose.connect(MONGO_URI, { maxPoolSize: 50 })
    .then(() => console.log("✅ MongoDB Connected!"))
    .catch(err => console.error("❌ DB Error:", err));

// スキーマ
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
    id: Number, userId: String, user: String, text: String, role: String, createdAt: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', MessageSchema);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const COOLDOWN_MS = 3000;
const lastMessageTimes = new Map();

function sanitize(str) { return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }

// 認証API
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    try {
        if (await User.findOne({ username }).lean()) return res.json({ success: false, message: "使用済み" });
        const userId = "u_" + Math.random().toString(36).substring(2, 12);
        await new User({ username, password, userId }).save();
        res.json({ success: true });
    } catch (e) { res.json({ success: false }); }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ username, password }).lean();
        if (!user) return res.json({ success: false, message: "失敗" });
        if (user.isBanned) return res.json({ success: false, message: "BAN中" });
        res.json({ success: true, userId: user.userId, username: user.username, role: user.role });
    } catch (e) { res.json({ success: false }); }
});

// Socket.io
io.on('connection', async (socket) => {
    io.emit('online count', io.engine.clientsCount);
    const history = await Message.find().sort({ createdAt: -1 }).limit(50).lean();
    socket.emit('load messages', history.reverse());

    // 状態取得（ミュート残り時間の計算）
    socket.on('get user status', async (tid) => {
        const t = await User.findOne({ userId: tid }).lean();
        if (!t) return;
        let m = "なし";
        if (t.muteUntil) {
            const now = new Date();
            const until = new Date(t.muteUntil);
            if (until > now) {
                const diffMs = until.getTime() - now.getTime();
                if (diffMs > 1000000000000) m = "永久";
                else m = `残り約 ${Math.ceil(diffMs / 60000)} 分`;
            } else {
                await User.updateOne({ userId: tid }, { muteUntil: null });
            }
        }
        socket.emit('user status data', { isBanned: t.isBanned, isShadowBanned: t.isShadowBanned, muteStatus: m });
    });

    socket.on('chat message', async (data) => {
        const u = await User.findOne({ userId: data.userId }).lean();
        if (!u || u.isBanned) return;
        if (Date.now() - (lastMessageTimes.get(data.userId) || 0) < COOLDOWN_MS) return socket.emit('system message', "連投禁止");
        if (u.muteUntil && new Date(u.muteUntil) > new Date()) return socket.emit('system message', "ミュート中");

        const msg = { id: Date.now(), userId: data.userId, user: u.username, text: sanitize(data.text), role: u.role };
        if (u.isShadowBanned) return socket.emit('chat message', msg);
        io.emit('chat message', msg);
        lastMessageTimes.set(data.userId, Date.now());
        new Message(msg).save();
    });

    socket.on('admin command', async (d) => {
        const a = await User.findOne({ userId: d.myId }).lean();
        if (!a || (a.role !== 'ADMIN' && a.role !== 'OWNER')) return;

        if (d.type === 'delete') { await Message.deleteOne({ id: d.msgId }); io.emit('delete message', d.msgId); }
        else if (d.type === 'ban') { await User.updateOne({ userId: d.targetId }, { isBanned: true }); io.emit('force logout user', d.targetId); }
        else if (d.type === 'unban') { await User.updateOne({ userId: d.targetId }, { isBanned: false }); }
        else if (d.type === 'shadowban') { await User.updateOne({ userId: d.targetId }, { isShadowBanned: true }); }
        else if (d.type === 'unshadowban') { await User.updateOne({ userId: d.targetId }, { isShadowBanned: false }); }
        else if (d.type === 'mute') {
            const dt = d.minutes ? new Date(Date.now() + parseInt(d.minutes) * 60000) : new Date(253402214400000);
            await User.updateOne({ userId: d.targetId }, { muteUntil: dt });
        }
        else if (d.type === 'unmute') { await User.updateOne({ userId: d.targetId }, { muteUntil: null }); }
        else if (d.type === 'promote') { await User.updateOne({ userId: d.targetId }, { role: 'ADMIN' }); }
        else if (d.type === 'demote') { await User.updateOne({ userId: d.targetId }, { role: 'USER' }); }
    });

    socket.on('admin global command', async (d) => {
        const o = await User.findOne({ userId: d.myId }).lean();
        if (!o || o.role !== 'OWNER') return;
        if (d.type === 'clearall') { await Message.deleteMany({}); io.emit('clear all messages'); }
        else if (d.type === 'kickall') io.emit('force logout');
    });

    socket.on('disconnect', () => io.emit('online count', io.engine.clientsCount));
});

server.listen(process.env.PORT || 10000);
