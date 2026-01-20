from flask import Flask, render_template
from flask_socketio import SocketIO, emit
import os

app = Flask(__name__)
# CORSを許可し、Vercelなどの外部ドメインからの接続を可能にする
socketio = SocketIO(app, cors_allowed_origins="*")

# メッセージ履歴を保存するリスト
messages_log = []

@app.route('/')
def index():
    return "Chat API is running."

# UptimeRobotなどのスリープ防止用
@app.route('/healthcheck')
def healthcheck():
    return 'OK', 200

# 新しく誰かが接続したとき
@socketio.on('connect')
def handle_connect():
    # 接続した本人にだけ、これまでの履歴（最大50件）を送信
    emit('load_history', messages_log)

# メッセージを受け取ったとき
@socketio.on('send_message')
def handle_message(data):
    # 履歴に追加
    messages_log.append(data)
    
    # 50件を超えたら一番古いものを削除してメモリを節約
    if len(messages_log) > 50:
        messages_log.pop(0)
        
    # 全員にメッセージを転送（放送）
    emit('receive_message', data, broadcast=True)

if __name__ == '__main__':
    # Renderの環境変数に合わせてポートを設定
    port = int(os.environ.get("PORT", 5000))
    socketio.run(app, host='0.0.0.0', port=port)
