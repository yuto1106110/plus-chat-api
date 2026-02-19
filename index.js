const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// --- サーバー設定 ---
const app = express();
app.use(cors());
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// --- 簡易データベース（実際にはMongoDB等を使うのが理想） ---
let messages = []; // メッセージ履歴
let users = {};    // ユーザー情報 {userId: {username, role, isBanned, muteUntil}}
let onlineUsers = new Set();

const ROLES = { OWNER: 100, ADMIN: 50, USER: 0 };

// --- 補助関数: HTMLエスケープ（サーバー側でも念のため実施） ---
function escapeHTML(str) {
    if (!str) return "";
    return String(str).replace(/[&<>"']/g, m => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
}

// --- API ルート (ログイン・登録) ---
app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    // 名前バリデーション
    const nameRegex = /^[a-zA-Z0-9ぁ-んァ-ヶー一-龠\-_]+$/;
    if (!nameRegex.test(username) || username.length > 15) {
        return res.json({ success: false, message: "不正なユーザー名です" });
    }
    // 本来はここでDB保存（パスワードはハッシュ化すること）
    const userId = "u_" + Math.random().toString(36).substring(2, 9);
    users[userId] = { username, password, role: 'USER', isBanned: false, muteUntil: 0 };
    res.json({ success: true, userId, username });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    // ユーザー検索 (簡易版)
    const userEntry = Object.entries(users).find(([id, u]) => u.username === username && u.password === password);
    if (userEntry) {
        const [userId, userData] = userEntry;
        if (userData.isBanned) return res.json({ success: false, message: "このアカウントはBANされています" });
        res.json({ success: true, userId, username, role: userData.role });
    } else {
        res.json({ success: false, message: "ユーザー名またはパスワードが違います" });
    }
});

// --- Socket.io 通信 ---
io.on('connection', (socket) => {
    onlineUsers.add(socket.id);
    io.emit('online count', onlineUsers.size);

    // 初回接続時にメッセージ履歴を送信
    socket.emit('load messages', messages.slice(-100));

    // メッセージ受信
    socket.on('chat message', (data) => {
        const { user, text } = data;
        
        // サーバー側バリデーション
        if (!text || text.length > 300) return;
        
        const cleanText = escapeHTML(text);
        const newMessage = {
            id: Date.now(),
            user: escapeHTML(user),
            text: cleanText,
            createdAt: new Date(),
            role: 'USER' // 本来はuserIdから紐付け
        };

        messages.push(newMessage);
        if (messages.length > 200) messages.shift(); // 履歴保持制限
        
        io.emit('chat message', newMessage);
    });

    // 管理者コマンド（削除・BAN・ミュート）
    socket.on('admin command', (data) => {
        const { type, targetId, myId, msgId } = data;
        // 本来はここで myId の権限チェックを行う
        
        if (type === 'delete') {
            messages = messages.filter(m => m.id !== msgId);
            io.emit('delete message', msgId);
        }
        
        if (type === 'ban') {
            if (users[targetId]) {
                users[targetId].isBanned = true;
                // BAN対象を強制切断させる命令を送るなどの処理
            }
        }
    });

    // 全体管理者コマンド (OWNER専用)
    socket.on('admin global command', (data) => {
        const { type, myId } = data;
        
        // 全員強制退出
        if (type === 'kickall') {
            io.emit('force logout'); 
        }

        // メッセージ全消去
        if (type === 'clearall') {
            messages = [];
            io.emit('clear all messages');
            io.emit('chat message', { id: 0, user: "SYSTEM", text: "管理者が履歴を全消去しました", role: "ADMIN" });
        }
    });

    socket.on('disconnect', () => {
        onlineUsers.delete(socket.id);
        io.emit('online count', onlineUsers.size);
    });
});

// ポート設定（Render等の環境変数に対応）
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

