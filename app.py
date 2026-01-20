import os
from datetime import datetime, timedelta, timezone
from flask import Flask, request, jsonify
from flask_socketio import SocketIO, emit
from flask_sqlalchemy import SQLAlchemy
from flask_cors import CORS

app = Flask(__name__)
app.config['SECRET_KEY'] = 'super-secret-key'

# データベース設定
db_path = os.path.join('/tmp', 'chat_v2.db')
app.config['SQLALCHEMY_DATABASE_URI'] = f'sqlite:///{db_path}'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

# CORSを完全に許可
CORS(app, resources={r"/*": {"origins": "*"}}, supports_credentials=True)

db = SQLAlchemy(app)
# async_modeを明示的に指定して安定させます
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')

class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(20), unique=True, nullable=False)
    password = db.Column(db.String(20), nullable=False)

messages_log = []

# 初回のみテーブル作成
with app.app_context():
    db.create_all()

@app.route('/')
def index():
    return "Chat API is running."


@app.route('/healthcheck')
def healthcheck():
    return 'OK', 200

@app.route('/api/auth', methods=['POST'])
def auth():
    data = request.get_json()
    if not data:
        return jsonify({"success": False, "message": "No data"}), 400
        
    username = data.get('username', '').strip()
    password = data.get('password', '').strip()
    mode = data.get('mode')

    try:
        user = User.query.filter_by(username=username).first()
        if mode == 'register':
            if user:
                return jsonify({"success": False, "message": "既に存在します"}), 400
            new_user = User(username=username, password=password)
            db.session.add(new_user)
            db.session.commit()
            return jsonify({"success": True, "username": username})
        else:
            if user and user.password == password:
                return jsonify({"success": True, "username": username})
            return jsonify({"success": False, "message": "名前かパスが違います"}), 401
    except Exception as e:
        db.session.rollback()
        return jsonify({"success": False, "message": "Database Error"}), 500

@socketio.on('send_message')
def handle_message(data):
    jst = timezone(timedelta(hours=+9))
    data['time'] = datetime.now(jst).strftime("%H:%M")
    messages_log.append(data)
    if len(messages_log) > 50:
        messages_log.pop(0)
    emit('receive_message', data, broadcast=True)

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 5000))
    socketio.run(app, host='0.0.0.0', port=port)
