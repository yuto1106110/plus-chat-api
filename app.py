from flask import Flask, request, jsonify
from flask_socketio import SocketIO, emit
from flask_cors import CORS
from datetime import datetime
import os

app = Flask(__name__)
app.config['SECRET_KEY'] = 'test-key'
CORS(app, supports_credentials=True, origins="*")
socketio = SocketIO(app, cors_allowed_origins="*", manage_session=False)

# メッセージ履歴
messages_log = []

@app.route('/')
def index():
    return "Chat API is running (Simple Mode)."

@app.route('/api/auth', methods=['POST'])
def auth():
    data = request.get_json()
    # データベースを通さず、名前があればOKにする
    username = data.get('username')
    if username:
        return jsonify({"success": True, "username": username})
    return jsonify({"success": False, "message": "名前を入力してください"}), 400

@socketio.on('connect')
def handle_connect():
    emit('load_history', messages_log)

@socketio.on('send_message')
def handle_message(data):
    data['time'] = datetime.now().strftime("%H:%M")
    messages_log.append(data)
    if len(messages_log) > 50:
        messages_log.pop(0)
    emit('receive_message', data, broadcast=True)

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 5000))
    socketio.run(app, host='0.0.0.0', port=port)
