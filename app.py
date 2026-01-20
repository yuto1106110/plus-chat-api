from flask import Flask, request, jsonify, session
from flask_socketio import SocketIO, emit
from flask_sqlalchemy import SQLAlchemy
from datetime import datetime
import os

app = Flask(__name__)
app.config['SECRET_KEY'] = 'your-secret-key' # ログイン管理に必要
# データベースの設定 (SQLite)
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///chat.db'
db = SQLAlchemy(app)
socketio = SocketIO(app, cors_allowed_origins="*")

# ユーザーモデル
class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(20), unique=True, nullable=False)

# メッセージ履歴（メモリ保持）
messages_log = []

# 初回起動時にデータベースを作成
with app.app_context():
    db.create_all()

# --- API ルート ---

@app.route('/api/register', methods=['POST'])
def register():
    data = request.json
    username = data.get('username')
    if User.query.filter_by(username=username).first():
        return jsonify({"success": False, "message": "この名前は既に使われています"}), 400
    
    new_user = User(username=username)
    db.session.add(new_user)
    db.session.commit()
    session['username'] = username
    return jsonify({"success": True, "username": username})

@app.route('/api/check_session')
def check_session():
    if 'username' in session:
        return jsonify({"is_logged_in": True, "username": session['username']})
    return jsonify({"is_logged_in": False})

# --- Socket.IO ---

@socketio.on('connect')
def handle_connect():
    emit('load_history', messages_log)

@socketio.on('send_message')
def handle_message(data):
    # タイムスタンプを追加 (例: 15:30)
    now = datetime.now()
    data['time'] = now.strftime("%H:%M")
    
    messages_log.append(data)
    if len(messages_log) > 50:
        messages_log.pop(0)
    emit('receive_message', data, broadcast=True)

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 5000))
    socketio.run(app, host='0.0.0.0', port=port)
