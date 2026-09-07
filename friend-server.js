// ============================================================
// Sheep Fight 2 - خادم الأصدقاء (Friend Server)
// يربط الصديقين عبر كود واحد باستخدام Socket.IO + Supabase.
//
// التشغيل:
//   node friend-server.js
//   ثم افتح http://localhost:3080
//
// إعداد Supabase (مطلوب للربط عبر الإنترنت بين لاعبين مختلفين):
//   أنشئ مشروعاً في https://supabase.com ثم شغّل supabase_schema.sql
//   ضع القيم في config أدناه (friendSupabaseUrl / friendSupabaseKey).
//   يمكن أيضاً ضبطها كمتغيرات بيئة:
//     SUPABASE_URL  SUPABASE_ANON_KEY  SUPABASE_SERVICE_KEY
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

// ----------------------- الإعدادات ---------------------------
const HTTP_PORT = process.env.PORT || 3080;
const SOCKET_PATH = '/friend-socket';

const config = {
  // --- Supabase ---
  // أنشئ مشروعاً في supabase.com ثم انسخ القيم من Project Settings > API
  friendSupabaseUrl: process.env.SUPABASE_URL || '',
  friendSupabaseKey: process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '',
  // --- خادم المباريات (سيرفرك الخاص) ---
  // عنوان خادم المطابقة الذي تملكه (يُستخدم لإعلام النوافذ المنبثقة فقط)
  matchServerHost: process.env.MATCH_SERVER_HOST || 'common.marketjs-multiplayer.com',
  // --- النطاق الأمامي (يُوضع في index.html تلقائياً عبر /api/config) ---
  publicHost: process.env.PUBLIC_HOST || '',
  // --- خيارات ---
  codeLength: 6,          // طول كود الربط
  roomTtlMinutes: 10,     // مهلة بقاء الغرفة إذا لم يُنضم صديق
  codeAlphabet: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', // بلا أحرف/أرقام ملتبسة
};

// إتاحة مسار socket.io للمتصفح
const socketIoClientPath = path.join(
  path.dirname(require.resolve('socket.io/package.json')),
  'client-dist', 'socket.io.min.js'
);

// ----------------------- الأدوات المساعدة --------------------
function mimeType(ext) {
  const map = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.ttf': 'font/ttf', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
  };
  return map[ext] || 'application/octet-stream';
}

function fail(res, code, msg) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: msg }));
}

function ok(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, ...data }));
}

function randomCode(len) {
  const chars = config.codeAlphabet;
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// ----------------------- Supabase (REST) ----------------------
const supabase = {
  ready() {
    return !!(config.friendSupabaseUrl && config.friendSupabaseKey);
  },
  endpoint(table) {
    return `${config.friendSupabaseUrl.replace(/\/$/, '')}/rest/v1/${table}`;
  },
  headers() {
    return {
      'apikey': config.friendSupabaseKey,
      'Authorization': `Bearer ${config.friendSupabaseKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    };
  },
  async insert(table, row) {
    const r = await fetch(this.endpoint(table), {
      method: 'POST', headers: this.headers(), body: JSON.stringify(row),
    });
    if (!r.ok) throw new Error(`supabase insert ${r.status}`);
    return (await r.json())[0];
  },
  async selectBy(table, field, value) {
    const url = `${this.endpoint(table)}?${field}=eq.${encodeURIComponent(value)}&select=*`;
    const r = await fetch(url, { headers: this.headers() });
    if (!r.ok) throw new Error(`supabase select ${r.status}`);
    return await r.json();
  },
  async update(table, id, patch) {
    patch.updated_at = new Date().toISOString();
    const url = `${this.endpoint(table)}?id=eq.${id}`;
    const r = await fetch(url, {
      method: 'PATCH', headers: this.headers(), body: JSON.stringify(patch),
    });
    if (!r.ok) throw new Error(`supabase update ${r.status}`);
    return await r.json();
  },
  async deleteByCode(table, code) {
    const url = `${this.endpoint(table)}?code=eq.${encodeURIComponent(code)}`;
    const r = await fetch(url, {
      method: 'DELETE', headers: { ...this.headers(), 'Prefer': 'return=minimal' },
    });
    if (!r.ok) throw new Error(`supabase delete ${r.status}`);
  },
};

// خلفية ذاكرة محلية تُستخدم عند عدم إعداد Supabase (للاختبار المحلي فقط)
const inMemory = new Map(); // code -> room object

// ----------------------- طبقة الغرف ---------------------------
async function generateUniqueCode() {
  for (let i = 0; i < 20; i++) {
    const code = randomCode(config.codeLength);
    const exists = supabase.ready()
      ? (await supabase.selectBy('friend_rooms', 'code', code)).length > 0
      : inMemory.has(code);
    if (!exists) return code;
  }
  throw new Error('could not generate a unique code');
}

function roomFromRow(f) {
  return {
    id: f.id, code: f.code,
    hostName: f.host_name, hostAvatar: f.host_avatar, hostSid: f.host_sid,
    guestName: f.guest_name, guestAvatar: f.guest_avatar, guestSid: f.guest_sid,
    status: f.status,
  };
}

async function readRoomByCode(code) {
  if (supabase.ready()) {
    const rows = await supabase.selectBy('friend_rooms', 'code', code);
    return rows.length ? roomFromRow(rows[0]) : null;
  }
  return inMemory.get(code) || null;
}

async function saveRoom(room) {
  if (supabase.ready()) {
    await supabase.update('friend_rooms', room.id, {
      host_sid: room.hostSid, guest_name: room.guestName,
      guest_avatar: room.guestAvatar, guest_sid: room.guestSid, status: room.status,
    });
  } else {
    inMemory.set(room.code, room);
  }
}

async function removeRoom(roomOrCode) {
  const code = typeof roomOrCode === 'string' ? roomOrCode : (roomOrCode && roomOrCode.code);
  if (!code) return;
  if (supabase.ready()) {
    try { await supabase.deleteByCode('friend_rooms', code); } catch (e) { /* ignore */ }
  }
  inMemory.delete(code);
}

// تنظيف الغرف المنتهية (للخلفية الذاكرية فقط)
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of inMemory) {
    if (!room.guestSid && now - room.created_at > config.roomTtlMinutes * 60000) {
      inMemory.delete(code);
    }
  }
}, 60000);

// ----------------------- خادم HTTP ---------------------------
const httpServer = http.createServer((req, res) => {
  let url = req.url.split('?')[0];

  // نقطة نهاية تكوين العميل (تُسدّد القيم من الخادم حتى لا نخزن المفاتيح بالمتصفح)
  if (url === '/api/config') {
    return ok(res, {
      socketPath: SOCKET_PATH,
      codeLength: config.codeLength,
      matchServerHost: config.matchServerHost,
    });
  }

  // استضافة ملف عميل socket.io (بدون CDN خارجي)
  if (url === '/socket.io-client.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    return res.end(fs.readFileSync(socketIoClientPath));
  }

  if (url === '/') url = '/index.html';

  // الافتراضي: خدمة الملفات الثابتة من مجلد المشروع
  const filePath = path.join(__dirname, url);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mimeType(path.extname(filePath).toLowerCase()) });
    res.end(data);
  });
});

// ----------------------- Socket.IO ----------------------------
const io = new Server(httpServer, {
  path: SOCKET_PATH,
  cors: { origin: '*' },
});

// ربط معرف socket بالغرفة الحالية للاعب
const sidRoom = new Map(); // socket.id -> room.code

io.on('connection', (socket) => {
  socket.on('create-room', async (payload, ack) => {
    const name = String((payload && payload.playerName) || '').trim();
    const avatar = (payload && payload.avatarId) != null ? payload.avatarId : 0;
    try {
      if (!name) throw new Error('empty_name');
      const code = await generateUniqueCode();
      const room = {
        id: null, code,
        hostName: name, hostAvatar: avatar, hostSid: socket.id,
        guestName: null, guestAvatar: null, guestSid: null,
        status: 'waiting', created_at: Date.now(),
      };
      if (supabase.ready()) {
        const row = await supabase.insert('friend_rooms', {
          code, host_name: name, host_avatar: avatar, host_sid: socket.id,
          status: 'waiting',
        });
        room.id = row.id;
      } else {
        inMemory.set(code, room);
      }
      sidRoom.set(socket.id, code);
      socket.join(code);
      if (ack) ack({ ok: true, code, hostName: name });
    } catch (e) {
      if (ack) ack({ ok: false, error: e.message || 'create failed' });
    }
  });

  socket.on('join-room', async (payload, ack) => {
    const code = String((payload && payload.code) || '').trim().toUpperCase();
    const name = String((payload && payload.playerName) || '').trim();
    const avatar = (payload && payload.avatarId) != null ? payload.avatarId : 0;
    try {
      if (!code) throw new Error('empty_code');
      if (!name) throw new Error('empty_name');
      const room = await readRoomByCode(code);
      if (!room) throw new Error('not_found');
      if (room.hostSid === socket.id) throw new Error('self_join');
      if (room.guestSid) throw new Error('room_full');
      if (room.hostName === name) throw new Error('same_name');

      room.guestName = name; room.guestAvatar = avatar; room.guestSid = socket.id;
      room.status = 'ready';
      await saveRoom(room);

      sidRoom.set(socket.id, code);
      socket.join(code);

      // أبلغ الطرفين بأنهما جاهزان للّعب
      io.to(code).emit('room-ready', {
        code,
        host: { name: room.hostName, avatar: room.hostAvatar },
        guest: { name: room.guestName, avatar: room.guestAvatar },
      });
      // أبلغ المضيف تحديداً لفتح زر اللعب
      io.to(room.hostSid).emit('guest-joined', { guestName: room.guestName });

      if (ack) ack({ ok: true, code, hostName: room.hostName, roomReady: true });
    } catch (e) {
      if (ack) ack({ ok: false, error: e.message || 'join failed' });
    }
  });

  // المضيف يطلب بدء المباراة (بعد جهوز الطرفين)
  socket.on('start-match', async (payload, ack) => {
    const code = sidRoom.get(socket.id);
    if (!code) { if (ack) ack({ ok: false, error: 'no_room' }); return; }
    const room = await readRoomByCode(code);
    if (!room) { if (ack) ack({ ok: false, error: 'not_found' }); return; }
    if (room.status !== 'ready') { if (ack) ack({ ok: false, error: 'not_ready' }); return; }
    room.status = 'playing';
    await saveRoom(room);
    // أبلغ الطرفين لبدء المباراة معاً
    io.to(code).emit('match-start', {
      code,
      players: [
        { name: room.hostName, avatar: room.hostAvatar, role: 'host' },
        { name: room.guestName, avatar: room.guestAvatar, role: 'guest' },
      ],
    });
    if (ack) ack({ ok: true });
  });

  socket.on('leave-room', async function (arg) {
    const ack = typeof arg === 'function' ? arg : null;
    const code = sidRoom.get(socket.id);
    if (!code) { if (ack) ack({ ok: false }); return; }
    await removeRoom(code);
    sidRoom.delete(socket.id);
    io.to(code).emit('room-closed');
    if (ack) ack({ ok: true });
  });

  socket.on('disconnect', async () => {
    const code = sidRoom.get(socket.id);
    sidRoom.delete(socket.id);
    if (!code) return;
    const room = await readRoomByCode(code).catch(() => null);
    if (room && room.hostSid === socket.id) {
      // انقطع المضيف -> أغلِق الغرفة
      await removeRoom(code);
      io.to(code).emit('room-closed');
    } else if (room && room.guestSid === socket.id) {
      // انقطع الضيف -> عُد إلى حالة الانتظار وأبلغ المضيف
      room.guestSid = null; room.guestName = null; room.guestAvatar = null;
      room.status = 'waiting';
      await saveRoom(room);
      io.to(room.hostSid).emit('guest-left');
    }
  });
});

// حماية إضافية: لا ينهار الخادم كاملاً بسبب خطأ غير متوقع في معالج حدث واحد
process.on('uncaughtException', (e) => {
  console.log('uncaughtException:', e && e.message);
});

httpServer.listen(HTTP_PORT, () => {
  console.log('============================================');
  console.log(' Sheep Fight 2 - Friend Server');
  console.log(` تشغيل على:         http://localhost:${HTTP_PORT}`);
  console.log(` Socket path:       ${SOCKET_PATH}`);
  console.log(` Supabase:          ${supabase.ready() ? 'مفعّل' : 'غير مفعّل (وضع ذاكرة محلي للاختبار)'}`);
  console.log('============================================');
});
