const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const mimeTypes = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav'
};
const SOCKET_PATH = '/friend-socket';
const socketIoClientPath = path.join(
  path.dirname(require.resolve('socket.io/package.json')),
  'client-dist', 'socket.io.min.js'
);

// --- خلفية ذاكرة محلية للغرف (لاستخدامها بدون Supabase في الاختبار المحلي) ---
const inMemory = new Map();

function randomCode(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

const server = http.createServer((req, res) => {
  let url = req.url.split('?')[0];
  if (url === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, socketPath: SOCKET_PATH, codeLength: 6, matchServerHost: '' }));
    return;
  }
  if (url === '/socket.io-client.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    res.end(fs.readFileSync(socketIoClientPath));
    return;
  }
  if (url === '/') url = '/index.html';
  const filePath = path.join(__dirname, url);
  const ext = path.extname(filePath).toLowerCase();
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// --- Socket.IO لنظام الأصدقاء ---
const io = new Server(server, { path: SOCKET_PATH, cors: { origin: '*' } });
const sidRoom = new Map();

io.on('connection', (socket) => {
  socket.on('create-room', (payload, ack) => {
    const name = String((payload && payload.playerName) || '').trim();
    const avatar = (payload && payload.avatarId) != null ? payload.avatarId : 0;
    let code;
    do { code = randomCode(6); } while (inMemory.has(code) && inMemory.get(code).status !== 'closed');
    const room = {
      code, hostName: name, hostAvatar: avatar, hostSid: socket.id,
      guestName: null, guestAvatar: null, guestSid: null, status: 'waiting'
    };
    inMemory.set(code, room);
    sidRoom.set(socket.id, code);
    socket.join(code);
    if (ack) ack({ ok: true, code, hostName: name });
  });

  socket.on('join-room', (payload, ack) => {
    const code = String((payload && payload.code) || '').trim().toUpperCase();
    const name = String((payload && payload.playerName) || '').trim();
    const avatar = (payload && payload.avatarId) != null ? payload.avatarId : 0;
    const room = inMemory.get(code);
    if (!room) { if (ack) return ack({ ok: false, error: 'not_found' }); return; }
    if (room.hostSid === socket.id) { if (ack) return ack({ ok: false, error: 'self_join' }); return; }
    if (room.guestSid) { if (ack) return ack({ ok: false, error: 'room_full' }); return; }
    if (room.hostName === name) { if (ack) return ack({ ok: false, error: 'same_name' }); return; }
    room.guestName = name; room.guestAvatar = avatar; room.guestSid = socket.id; room.status = 'ready';
    sidRoom.set(socket.id, code);
    socket.join(code);
    io.to(code).emit('room-ready', {
      code,
      host: { name: room.hostName, avatar: room.hostAvatar },
      guest: { name: room.guestName, avatar: room.guestAvatar },
    });
    io.to(room.hostSid).emit('guest-joined', { guestName: room.guestName });
    if (ack) ack({ ok: true, code, hostName: room.hostName, roomReady: true });
  });

  socket.on('start-match', (payload, ack) => {
    const code = sidRoom.get(socket.id);
    const room = inMemory.get(code);
    if (!room) { if (ack) return ack({ ok: false, error: 'not_found' }); return; }
    if (room.status !== 'ready') { if (ack) return ack({ ok: false, error: 'not_ready' }); return; }
    room.status = 'playing';
    io.to(code).emit('match-start', {
      code,
      players: [
        { name: room.hostName, avatar: room.hostAvatar, role: 'host' },
        { name: room.guestName, avatar: room.guestAvatar, role: 'guest' },
      ],
    });
    if (ack) ack({ ok: true });
  });

  socket.on('leave-room', (ack) => {
    const code = sidRoom.get(socket.id);
    if (!code) { if (ack) ack({ ok: false }); return; }
    inMemory.delete(code);
    sidRoom.delete(socket.id);
    io.to(code).emit('room-closed');
    if (ack) ack({ ok: true });
  });

  socket.on('disconnect', () => {
    const code = sidRoom.get(socket.id);
    sidRoom.delete(socket.id);
    if (!code) return;
    const room = inMemory.get(code);
    if (room && room.hostSid === socket.id) {
      inMemory.delete(code);
      io.to(code).emit('room-closed');
    } else if (room && room.guestSid === socket.id) {
      room.guestSid = null; room.guestName = null; room.guestAvatar = null; room.status = 'waiting';
      io.to(room.hostSid).emit('guest-left');
    }
  });
});

server.listen(3070, () => {
  console.log('Serving Chicken Battles (معارك الدجاج) on http://localhost:3070');
  console.log('Friend system socket ready at path:', SOCKET_PATH);
});
