/* ============================================================
   Sheep Fight 2 - نظام اللعب مع صديق (Friend System Client)
   ============================================================
   يعمل كطبقة علوية فوق اللعبة. لا يعدّل game.js.

   الإصدار الحالي يعتمد على Supabase Realtime مباشرة (بدون خادم Node):
     - المضيف ينشئ كود غرفة ويدخل القناة مع حضوره (presence) كـ host.
     - الضيف يدخل نفس القناة بالكود كـ guest.
     - يتعرف الطرفان على بعضهما عبر الحضور، ويتبادلان إشارة "بدء المباراة"
       عبر broadcast، ثم يبدأ كلاهما المباراة على خادم المطابقة (SERVER_IP).
   هذا يعمل على GitHub Pages وأي استضافة ثابتة.
   ============================================================ */
(function () {
  'use strict';

  var rt = {
    channel: null,
    role: null,            // 'host' | 'guest' (يُضبط قبل فتح القناة)
    joinFinalized: false,  // هل اكتمل انضمام الضيف
    joinCb: null,          // رد انضمام الضيف المعلّق
    joinTimer: null,       // مهلة "لم يتم العثور على الكود"
    hostHadGuest: false,   // هل انضم ضيف إلى غرفة المضيف
    lastPeerSeen: 0,       // آخر نبضة استُلمت من الصديق
    hbTimer: null,         // مؤقّت إرسال النبضات
    watchTimer: null,      // مؤقّت مراقبة انقطاع الصديق
  };

  var sb = null;         // عميل Supabase
  var myRoomCode = null; // الكود الذي أنشأناه (مضيف)
  var joinedCode = null; // الكود الذي انضممنا إليه (ضيف)
  var role = null;       // 'host' | 'guest'
  var roomReady = false; // هل اكتمل ربط الصديقين
  var matchStarting = false;
  var myName = null;     // الاسم المُرسل للصديق
  var peerName = null;   // اسم الصديق المقابل

  var state = { busy: false, started: false };

  var el = {};

  function $(id) { return document.getElementById(id); }

  // ---------- أدوات ----------
  function setStatus(msg, kind) {
    if (!el.status) return;
    el.status.textContent = msg;
    el.status.className = 'friend-status show ' + (kind || 'info');
  }
  function clearStatus() {
    if (el.status) { el.status.className = 'friend-status'; el.status.textContent = ''; }
  }
  var fallbackName = null;
  function currentName() {
    try {
      if (window.ig && ig.game) {
        if (ig.game.playerName && String(ig.game.playerName).trim()) return String(ig.game.playerName).trim();
        if (ig.game.defaultPlayerName && String(ig.game.defaultPlayerName).trim()) return String(ig.game.defaultPlayerName).trim();
      }
    } catch (e) {}
    if (!fallbackName) fallbackName = 'Player' + Math.floor(1000 + Math.random() * 9000);
    return fallbackName;
  }
  function currentAvatar() {
    try {
      if (window.ig && ig.game && typeof ig.game.avatarId === 'number') return ig.game.avatarId;
    } catch (e) {}
    return 0;
  }
  function codeLength() {
    return (window.SheepFriendConfig && window.SheepFriendConfig.codeLength) || 6;
  }
  function randomCode() {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var out = '';
    for (var i = 0; i < codeLength(); i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  // ---------- بدء المباراة الفعلية (خادم المطابقة) ----------
  function launchGameMatch() {
    try {
      if (!window.ig || !ig.game || !ig.game.network_game) {
        setStatus('اللعبة لم تتهيأ بعد. حاول مجدداً بعد قليل.', 'error');
        return false;
      }
      var ng = ig.game.network_game;
      if (!ng.socket || ng.socket.disconnected) {
        setStatus('خادم المباريات غير متصل.', 'error');
        return false;
      }
      if (matchStarting) return false;
      matchStarting = true;

      var data = { playerName: currentName() || ig.game.playerName, avatarId: ig.game.avatarId };
      var ok = ng.requestGame(
        data,
        function () { /* onConfirmed: اللعبة ستنتقل للمطابقة تلقائياً */ },
        function () {
          matchStarting = false;
          setStatus('فشل بدء المباراة. حاول مرة أخرى.', 'error');
        }
      );
      if (ok === false) {
        matchStarting = false;
        setStatus('تعذّر بدء المباراة الآن.', 'error');
      }
      return ok;
    } catch (e) {
      matchStarting = false;
      setStatus('حدث خطأ أثناء بدء المباراة.', 'error');
      return false;
    }
  }

  // ============================================================
  //  طبقة التوصيل عبر Supabase Realtime (broadcast + نبضات)
  //  ملاحظة: الحضور (presence) غير معتمد في build هذه المكتبة،
  //  لذلك نستبدله بتحيات ونبضات عبر broadcast.
  // ============================================================
  var HB_INTERVAL = 2500;   // إرسال نبضة كل 2.5 ثانية
  var PEER_TIMEOUT = 8000;  // يعتبر الصديق غادراً بعد 8 ثوانٍ دون نبضة
  var HOST_WAIT = 6000;     // مهلة الضيف لانتظار المضيف

  function ensureRt(cb) {
    if (sb) { cb(null); return; }
    var cfg = window.SheepFriendConfig;
    if (!cfg || !cfg.supabaseUrl || !cfg.supabaseAnonKey || typeof supabase === 'undefined') {
      cb('ميزة الأصدقاء غير متاحة الآن (Supabase غير مُهيأ).');
      return;
    }
    try {
      sb = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
      cb(null);
    } catch (e) {
      sb = null;
      cb('تعذّر تهيئة اتصال Supabase.');
    }
  }

  function rtBroadcast(ev, payload) {
    if (!rt.channel) return;
    try {
      rt.channel.send({ type: 'broadcast', event: ev, payload: payload || {} });
    } catch (e) {}
  }

  function rtStartHeartbeat() {
    rtStopHeartbeat();
    var send = function () {
      rtBroadcast('hb', { role: rt.role, name: currentName(), avatar: currentAvatar() });
    };
    send();
    rt.hbTimer = setInterval(send, HB_INTERVAL);
  }
  function rtStopHeartbeat() {
    if (rt.hbTimer) { clearInterval(rt.hbTimer); rt.hbTimer = null; }
  }

  // معالجة تحيات/نبضات الصديق
  function rtOnPeerMessage(payload) {
    if (!payload || !payload.role || payload.role === rt.role) return;
    if (payload.role === 'host' && rt.role === 'guest') {
      peerName = payload.name;
      rt.lastPeerSeen = Date.now();
      if (!rt.joinFinalized) finalizeGuestJoin({ name: payload.name, avatar: payload.avatar });
    } else if (payload.role === 'guest' && rt.role === 'host') {
      peerName = payload.name;
      rt.lastPeerSeen = Date.now();
      if (!rt.hostHadGuest) {
        rt.hostHadGuest = true;
        roomReady = true;
        showReadyState();
        setStatus('انضم صديقك (' + peerName + ')! اضغط العب لبدء المباراة.', 'ok');
      }
    }
  }

  function rtOnPeerBye() {
    if (rt.role === 'host') {
      if (rt.hostHadGuest && Date.now() - rt.lastPeerSeen > 1200) {
        rt.hostHadGuest = false;
        roomReady = false;
        peerName = null;
        showReadyState();
        setStatus('غادر صديقك الغرفة. بانتظار انضمام صديق جديد.', 'info');
      }
    } else if (rt.joinFinalized) {
      setStatus('غادر صديقك الغرفة.', 'error');
      closeOverlay(true);
    }
  }

  // مراقبة انقطاع الصديق
  function rtWatchPeer() {
    rtStopWatch();
    if (rt.role === 'host') {
      rt.watchTimer = setInterval(function () {
        if (rt.hostHadGuest && Date.now() - rt.lastPeerSeen > PEER_TIMEOUT) {
          rt.hostHadGuest = false;
          roomReady = false;
          peerName = null;
          showReadyState();
          setStatus('غادر صديقك الغرفة. بانتظار انضمام صديق جديد.', 'info');
        }
      }, 1500);
    } else {
      rt.watchTimer = setInterval(function () {
        if (rt.joinFinalized && Date.now() - rt.lastPeerSeen > PEER_TIMEOUT) {
          setStatus('غادر صديقك الغرفة.', 'error');
          closeOverlay(true);
        }
      }, 1500);
    }
  }
  function rtStopWatch() {
    if (rt.watchTimer) { clearInterval(rt.watchTimer); rt.watchTimer = null; }
  }

  function rtLeave() {
    rtStopHeartbeat();
    rtStopWatch();
    if (rt.channel) rtBroadcast('bye', { role: rt.role });
    var ch = rt.channel;
    rt.channel = null;
    rt.role = null; rt.joinFinalized = false; rt.joinCb = null; rt.joinTimer = null;
    rt.hostHadGuest = false; rt.lastPeerSeen = 0;
    if (ch && sb) {
      setTimeout(function () { try { sb.removeChannel(ch); } catch (e) {} }, 0);
    }
  }

  // إنشاء غرفة (مضيف): يفتح القناة ويعلن حضوره
  function rtCreateRoom(cb) {
    ensureRt(function (err) {
      if (err) { cb(err); return; }
      rt.role = 'host';
      var code = randomCode();
      rt.hostHadGuest = false;
      rt.lastPeerSeen = 0;
      rt.channel = sb.channel('friend-room:' + code);
      rt.channel.on('broadcast', { event: 'hello' }, function (msg) { rtOnPeerMessage(msg.payload); });
      rt.channel.on('broadcast', { event: 'hb' }, function (msg) { rtOnPeerMessage(msg.payload); });
      rt.channel.on('broadcast', { event: 'bye' }, function () { rtOnPeerBye(); });
      rt.channel.on('broadcast', { event: 'match-start' }, function () { launchedFromPeer(); });
      rt.channel.subscribe(function (status, sErr) {
        if (status !== 'SUBSCRIBED') {
          try { cb((sErr && sErr.message) || 'فشل الاتصال بـ Supabase.'); } catch (e) {}
          rtLeave();
          return;
        }
        rtBroadcast('hello', { role: 'host', name: currentName(), avatar: currentAvatar(), code: code });
        rtStartHeartbeat();
        rtWatchPeer();
        cb(null, code);
      });
    });
  }

  // الانضمام (ضيف): يدخل القناة وينتظر تحية/نبضة المضيف
  function rtJoinRoom(code, cb) {
    ensureRt(function (err) {
      if (err) { cb(err); return; }
      rt.role = 'guest';
      rt.joinFinalized = false;
      rt.joinCb = cb;
      rt.lastPeerSeen = 0;
      rt.channel = sb.channel('friend-room:' + code);
      rt.channel.on('broadcast', { event: 'hello' }, function (msg) { rtOnPeerMessage(msg.payload); });
      rt.channel.on('broadcast', { event: 'hb' }, function (msg) { rtOnPeerMessage(msg.payload); });
      rt.channel.on('broadcast', { event: 'bye' }, function () { rtOnPeerBye(); });
      rt.channel.on('broadcast', { event: 'match-start' }, function () { launchedFromPeer(); });
      rt.channel.subscribe(function (status, sErr) {
        if (status !== 'SUBSCRIBED') {
          rtLeave();
          cb((sErr && sErr.message) || 'فشل الاتصال بـ Supabase.');
          return;
        }
        rtBroadcast('hello', { role: 'guest', name: currentName(), avatar: currentAvatar() });
        rtStartHeartbeat();
        rtWatchPeer();
        rt.joinTimer = setTimeout(function () {
          rt.joinTimer = null;
          if (!rt.joinFinalized) {
            var cbb = rt.joinCb; rt.joinCb = null;
            rtLeave();
            try { cbb && cbb('لم يتم العثور على هذا الكود. تأكد منه.'); } catch (e) {}
          }
        }, HOST_WAIT);
      });
    });
  }

  function finalizeGuestJoin(host) {
    if (rt.joinFinalized) return;
    var cb = rt.joinCb; rt.joinCb = null;
    if (!host) return;
    var mine = String(currentName() || '').trim().toLowerCase();
    if (host.name && String(host.name).trim().toLowerCase() === mine) {
      rtLeave();
      try { cb && cb('اختر اسماً مختلفاً عن اسم الصديق.'); } catch (e) {}
      return;
    }
    rt.joinFinalized = true;
    if (rt.joinTimer) { clearTimeout(rt.joinTimer); rt.joinTimer = null; }
    rt.lastPeerSeen = Date.now();
    try { cb && cb(null, host); } catch (e) {}
  }

  function launchedFromPeer() {
    roomReady = true;
    setStatus('تبدأ المباراة...', 'ok');
    launchGameMatch();
  }

  function rtSendMatchStart(cb) {
    if (!rt.channel) { cb('انقطع الاتصال. حاول مجدداً.'); return; }
    rt.channel.send({ type: 'broadcast', event: 'match-start', payload: { code: myRoomCode || '' } })
      .then(function () { cb(null); })
      .catch(function () { cb('تعذّر إرسال إشارة البدء.'); });
  }

  // ---------- منطق المضيف ----------
  function hostCreateRoom() {
    if (state.busy) return;
    state.busy = true;
    el.hostBtn.disabled = true;
    clearStatus();
    setStatus('جاري إنشاء الغرفة...', 'info');
    rtCreateRoom(function (err, code) {
      state.busy = false;
      el.hostBtn.disabled = false;
      if (err) return setStatus(err, 'error');
      role = 'host';
      myRoomCode = code;
      myName = currentName();
      el.hostCode.textContent = code;
      el.hostCodeBox.style.display = 'flex';
      el.hostStatus.textContent = 'شارك هذا الكود مع صديقك ليتمكن من الانضمام.';
      el.hostPlayBtn.disabled = true; // يُفعَّل عند انضمام الضيف
      setStatus('بانتظار انضمام صديقك بالكود: ' + code, 'info');
    });
  }

  function hostStart() {
    if (!roomReady || state.busy) {
      if (!roomReady) setStatus('بانتظار انضمام صديقك أولاً.', 'error');
      return;
    }
    state.busy = true;
    setStatus('جاري بدء المباراة مع الصديق...', 'ok');
    rtSendMatchStart(function (err) {
      state.busy = false;
      if (err) return setStatus(err, 'error');
      setStatus('البدء...', 'ok');
      launchedFromPeer();
    });
  }

  // ---------- منطق الضيف ----------
  function guestJoin() {
    if (state.busy) return;
    var code = (el.joinInput.value || '').trim().toUpperCase();
    if (!code) return setStatus('أدخل كود صديقك أولاً.', 'error');
    if (code.length !== codeLength()) return setStatus('الكود يجب أن يكون ' + codeLength() + ' أحرف.', 'error');
    state.busy = true;
    el.joinBtn.disabled = true;
    clearStatus();
    setStatus('جاري الاتصال بالغرفة...', 'info');
    rtJoinRoom(code, function (err, host) {
      state.busy = false;
      el.joinBtn.disabled = false;
      if (err) return setStatus(err, 'error');
      role = 'guest';
      joinedCode = code;
      myName = currentName();
      peerName = host.name;
      if (el.joinStatus) el.joinStatus.textContent = 'تم الربط مع ' + host.name + '!';
      setStatus('تم الربط! بانتظار بدء صديقك المباراة.', 'ok');
      roomReady = true;
      showReadyState();
    });
  }

  // ---------- عرض الحالة الجاهزة ----------
  function showReadyState() {
    if (el.playersBox) {
      el.playersBox.classList.add('show');
      var hostLabel = el.hostPlayerName, guestLabel = el.guestPlayerName;
      if (role === 'host') {
        if (hostLabel) hostLabel.textContent = 'أنت (' + (myName || currentName()) + ')';
        if (guestLabel) guestLabel.textContent = 'صديقك' + (peerName ? ' (' + peerName + ')' : '');
      } else {
        if (hostLabel) hostLabel.textContent = 'الصديق المضيف' + (peerName ? ' (' + peerName + ')' : '');
        if (guestLabel) guestLabel.textContent = 'أنت (' + (myName || currentName()) + ')';
      }
    }
    if (role === 'host' && el.hostPlayBtn) el.hostPlayBtn.disabled = !(roomReady && peerName);
  }

  // ---------- فتح/إغلاق ----------
  function openOverlay() {
    el.overlay.classList.add('open');
  }
  function closeOverlay(silent) {
    el.overlay.classList.remove('open');
    resetLocal();
    if (!silent) {
      // لا شيء إضافي
    }
  }
  function resetLocal() {
    rtLeave();
    if (role === 'host') myRoomCode = null;
    if (role === 'guest') joinedCode = null;
    role = null; roomReady = false; state.busy = false; matchStarting = false;
    if (el.hostCodeBox) el.hostCodeBox.style.display = 'none';
    if (el.playersBox) el.playersBox.classList.remove('show');
    if (el.hostPlayBtn) el.hostPlayBtn.disabled = true;
    if (el.joinInput) el.joinInput.value = '';
    if (el.hostStatus) el.hostStatus.textContent = '';
    if (el.joinStatus) el.joinStatus.textContent = '';
    clearStatus();
  }

  // ---------- تهيئة الواجهة ----------
  function ensureHostStatus() {
    if (!el.hostStatus) {
      el.hostStatus = document.createElement('div');
      el.hostStatus.id = 'friendHostStatus';
      el.hostStatus.className = 'fp-hint';
      el.hostStatus.style.marginTop = '8px';
      if (el.hostCodeBox) el.hostCodeBox.parentNode.insertBefore(el.hostStatus, el.hostCodeBox.nextSibling);
    }
    if (!el.joinStatus) {
      el.joinStatus = document.createElement('div');
      el.joinStatus.id = 'friendJoinStatus';
      el.joinStatus.className = 'fp-hint';
      el.joinStatus.style.marginTop = '8px';
      if (el.joinForm) el.joinForm.appendChild(el.joinStatus);
    }
  }

  function buildUI() {
    if ($('friendOverlay')) return;

    var css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = 'friend/friend.css';
    document.head.appendChild(css);

    var fab = document.createElement('button');
    fab.id = 'friendFab';
    fab.className = 'friend-fab';
    fab.innerHTML = '<span class="ff-icon">👥</span><span>العب مع صديق</span>';
    fab.addEventListener('click', openOverlay);
    document.body.appendChild(fab);

    var overlay = document.createElement('div');
    overlay.id = 'friendOverlay';
    overlay.className = 'friend-overlay';
    overlay.innerHTML =
      '<div class="friend-panel">' +
        '<div class="fp-head">' +
          '<h2 class="fp-title">العب مع صديق</h2>' +
          '<button class="fp-close" id="friendClose" aria-label="إغلاق">&times;</button>' +
        '</div>' +
        '<p class="fp-sub">أنشئ غرفة وشارك الكود مع صديقك، أو أدخل كود صديقك للانضمام إليه.</p>' +
        '<div class="friend-tabs">' +
          '<button class="friend-tab active" id="friendTabHost">إنشاء غرفة</button>' +
          '<button class="friend-tab" id="friendTabJoin">الانضمام بكود</button>' +
        '</div>' +
        '<div class="friend-view active" id="friendViewHost">' +
          '<div class="fp-label">كود غرفتك</div>' +
          '<div class="friend-code-box" id="friendHostCodeBox" style="display:none;">' +
            '<div class="friend-code" id="friendHostCode">------</div>' +
            '<button class="friend-copy" id="friendCopy">نسخ</button>' +
          '</div>' +
          '<button class="friend-btn primary" id="friendHostBtn">إنشاء الغرفة</button>' +
          '<button class="friend-btn" id="friendHostPlay" disabled>العب والبدء</button>' +
        '</div>' +
        '<div class="friend-view" id="friendViewJoin">' +
          '<form id="friendJoinForm" autocomplete="off">' +
            '<div class="fp-label">كود الصديق</div>' +
            '<input class="friend-input" id="friendJoinInput" maxlength="10" placeholder="ABC123" autocomplete="off" />' +
            '<button class="friend-btn primary" type="submit" id="friendJoinBtn">الانضمام والعب</button>' +
          '</form>' +
        '</div>' +
        '<div class="friend-players" id="friendPlayers">' +
          '<div class="friend-player"><span class="fp-role">أنت</span><span class="fp-name" id="friendHostPlayerName">...</span></div>' +
          '<div class="friend-player"><span class="fp-role">صديق</span><span class="fp-name" id="friendGuestPlayerName">...</span></div>' +
        '</div>' +
        '<div class="friend-status" id="friendStatus"></div>' +
      '</div>';
    document.body.appendChild(overlay);

    el.overlay = overlay;
    el.fab = fab;
    el.close = $('friendClose');
    el.tabHost = $('friendTabHost');
    el.tabJoin = $('friendTabJoin');
    el.viewHost = $('friendViewHost');
    el.viewJoin = $('friendViewJoin');
    el.hostCodeBox = $('friendHostCodeBox');
    el.hostCode = $('friendHostCode');
    el.copy = $('friendCopy');
    el.hostBtn = $('friendHostBtn');
    el.hostPlayBtn = $('friendHostPlay');
    el.joinForm = $('friendJoinForm');
    el.joinInput = $('friendJoinInput');
    el.joinBtn = $('friendJoinBtn');
    el.playersBox = $('friendPlayers');
    el.hostPlayerName = $('friendHostPlayerName');
    el.guestPlayerName = $('friendGuestPlayerName');
    el.status = $('friendStatus');

    ensureHostStatus();

    el.close.addEventListener('click', function () { closeOverlay(); });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeOverlay(); });

    el.tabHost.addEventListener('click', function () {
      el.tabHost.classList.add('active'); el.tabJoin.classList.remove('active');
      el.viewHost.classList.add('active'); el.viewJoin.classList.remove('active');
    });
    el.tabJoin.addEventListener('click', function () {
      el.tabJoin.classList.add('active'); el.tabHost.classList.remove('active');
      el.viewJoin.classList.add('active'); el.viewHost.classList.remove('active');
    });

    el.hostBtn.addEventListener('click', hostCreateRoom);
    el.hostPlayBtn.addEventListener('click', hostStart);
    el.copy.addEventListener('click', function () {
      if (myRoomCode) {
        var t = document.createElement('textarea');
        t.value = myRoomCode; document.body.appendChild(t); t.select();
        try { document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(t);
        setStatus('تم نسخ الكود: ' + myRoomCode, 'ok');
      }
    });
    el.joinForm.addEventListener('submit', function (e) { e.preventDefault(); guestJoin(); });
  }

  // ---------- إظهار الزر فقط في الشاشة الرئيسية ----------
  function hideFabIfNotHome() {
    var inMatch = false;
    try {
      if (window.ig && ig.game) {
        var dir = ig.game.director && ig.game.director.current;
        if (dir && /(^|\.)(game|end)$/.test(String(dir))) inMatch = true;
      }
    } catch (e) {}
    if (el.fab) el.fab.classList.toggle('hidden', inMatch);
    if (inMatch) { try { closeOverlay(true); } catch (e) {} }
  }

  // ---------- جلوبال ----------
  window.SheepFriend = {
    open: openOverlay,
    close: closeOverlay,
    launchMatch: launchGameMatch,
    get code() { return myRoomCode || joinedCode; },
  };

  // ---------- البدء ----------
  function init() {
    buildUI();
    setInterval(hideFabIfNotHome, 1200);
    ensureRt(function () { /* نتجاهل الخطأ هنا؛ يظهر عند الاستخدام */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();