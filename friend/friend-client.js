/* ============================================================
   Sheep Fight 2 - نظام اللعب مع صديق (Friend System Client)
   ============================================================
   يعمل كطبقة علوية فوق اللعبة. لا يعدّل game.js.
   يتصل بخادم الأصدقاء friend-server.js عبر socket.io،
   وعند جهوز الصديقين يضغطان "العب" معاً لبدء المباراة على
   خادم المطابقة الخاص (SERVER_IP في index.html).
   ============================================================ */
(function () {
  'use strict';

  var cfg = { socketPath: '/friend-socket', codeLength: 6 };
  var socket = null;
  var myRoomCode = null;   // الكود الذي أنشأناه (مضيف)
  var joinedCode = null;   // الكود الذي انضممنا إليه (ضيف)
  var role = null;         // 'host' | 'guest'
  var roomReady = false;   // هل اكتمل ربط الصديقين
  var matchStarting = false;
  var myName = null;       // الاسم المُرسل للخادم
  var peerName = null;     // اسم الصديق المقابل

  var state = {
    busy: false,
    started: false,
  };

  // عناصر الواجهة
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

  // ---------- بدء المباراة الفعلية (خادم المطابقة الخاص) ----------
  // نعيد سلوك playGame() الموجود في اللعبة حتى يبدأ الطرفان معاً.
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

  // ---------- ربط socket ----------
  function connectSocket(cb) {
    if (socket && socket.connected) { cb && cb(); return; }
    if (!window.io) { cb && cb(new Error('no_io')); return; }
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = io({ path: cfg.socketPath, transports: ['websocket', 'polling'] });

    socket.on('connect', function () { cb && cb(); });
    socket.on('connect_error', function () { cb && cb(new Error('connect_error')); });
    socket.on('disconnect', function (reason) {
      if (myRoomCode || joinedCode) {
        setStatus('انقطع الاتصال بخادم الأصدقاء.', 'error');
      }
    });

    socket.on('room-ready', function (d) {
      if (d) {
        if (role === 'host') { myName = d.host && d.host.name; peerName = d.guest && d.guest.name; }
        else { myName = d.guest && d.guest.name; peerName = d.host && d.host.name; }
      }
      roomReady = true;
      setStatus('تم الربط! كلاكما جاهز للمباراة. اضغط العب.', 'ok');
      showReadyState();
    });
    socket.on('guest-joined', function (d) {
      if (role === 'host' && d && d.guestName) {
        peerName = d.guestName;
        showReadyState();
        if (myRoomCode && !roomReady) setStatus('انضم صديقك (' + d.guestName + ')! اضغط العب لبدء المباراة.', 'ok');
      }
    });
    socket.on('guest-left', function () {
      roomReady = false;
      setStatus('غادر صديقك الغرفة. بانتظار انضمام صديق جديد.', 'info');
      showReadyState();
    });
    socket.on('match-start', function () {
      roomReady = true;
      setStatus('تبدأ المباراة...', 'ok');
      launchGameMatch();
    });
    socket.on('room-closed', function () {
      closeOverlay(true);
    });
  }

  // ---------- منطق المضيف ----------
  function hostCreateRoom() {
    if (state.busy) return;
    state.busy = true;
    el.hostBtn.disabled = true;
    clearStatus();
    setStatus('جاري إنشاء الغرفة...', 'info');
    connectSocket(function (err) {
      if (err) { state.busy = false; el.hostBtn.disabled = false; return setStatus('تعذّر الاتصال بالخادم.', 'error'); }
      socket.emit('create-room', { playerName: currentName(), avatarId: currentAvatar() }, function (res) {
        state.busy = false;
        el.hostBtn.disabled = false;
        if (!res || !res.ok) return setStatus('تعذّر إنشاء الغرفة: ' + (res && res.error), 'error');
        role = 'host';
        myRoomCode = res.code;
        myName = currentName();
        el.hostCode.textContent = res.code;
        el.hostCodeBox.style.display = 'flex';
        el.hostStatus.textContent = 'شارك هذا الكود مع صديقك ليتمكن من الانضمام.';
        el.hostPlayBtn.disabled = true; // يُفعَّل عند انضمام الضيف
        setStatus('بانتظار انضمام صديقك بالكود: ' + res.code, 'info');
      });
    });
  }

  function hostStart() {
    if (!roomReady || state.busy || !socket) return;
    state.busy = true;
    setStatus('جاري بدء المباراة مع الصديق...', 'ok');
    socket.emit('start-match', {}, function (res) {
      state.busy = false;
      if (res && res.ok) {
        setStatus('البدء...', 'ok');
      } else {
        setStatus('لم يكن الطرفان جاهزين بعد. حاول مجدداً.', 'error');
      }
    });
  }

  // ---------- منطق الضيف ----------
  function guestJoin() {
    if (state.busy) return;
    var code = (el.joinInput.value || '').trim().toUpperCase();
    if (!code) return setStatus('أدخل كود صديقك أولاً.', 'error');
    if (code.length !== cfg.codeLength) return setStatus('الكود يجب أن يكون ' + cfg.codeLength + ' أحرف.', 'error');
    state.busy = true;
    el.joinBtn.disabled = true;
    clearStatus();
    setStatus('جاري الاتصال بالغرفة...', 'info');
    connectSocket(function (err) {
      if (err) { state.busy = false; el.joinBtn.disabled = false; return setStatus('تعذّر الاتصال بالخادم.', 'error'); }
      socket.emit('join-room', { code: code, playerName: currentName(), avatarId: currentAvatar() }, function (res) {
        state.busy = false;
        el.joinBtn.disabled = false;
        if (!res || !res.ok) return setStatus('تعذّر الانضمام: ' + friendErrorText(res && res.error), 'error');
        role = 'guest';
        joinedCode = res.code;
        myName = currentName();
        peerName = res.hostName;
        if (el.joinStatus) el.joinStatus.textContent = 'تم الربط مع ' + res.hostName + '!';
        setStatus('تم الربط! بانتظار بدء صديقك المباراة.', 'ok');
        roomReady = true;
        showReadyState();
      });
    });
  }

  function friendErrorText(code) {
    switch (code) {
      case 'not_found': return 'لم يتم العثور على هذا الكود. تأكد منه.';
      case 'room_full': return 'الغرفة ممتلئة بالفعل.';
      case 'self_join': return 'لا يمكن الانضمام إلى غرفتك الخاصة.';
      case 'same_name': return 'اختر اسماً مختلفاً عن اسم الصديق.';
      case 'empty_code': return 'أدخل الكود.';
      case 'empty_name': return 'أدخل اسمك أولاً في اللعبة.';
      default: return 'خطأ غير معروف.';
    }
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
    if (role === 'host' && el.hostPlayBtn) el.hostPlayBtn.disabled = !roomReady && !peerName;
  }

  // ---------- فتح/إغلاق ----------
  function openOverlay() {
    el.overlay.classList.add('open');
  }
  function closeOverlay(silent) {
    el.overlay.classList.remove('open');
    resetLocal();
    if (socket && (myRoomCode || joinedCode)) {
      try { socket.emit('leave-room'); } catch (e) {}
    }
    if (!silent) {
      // لا شيء إضافي
    }
    resetLocal();
  }
  function resetLocal() {
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
    // يُظهر الزر في الغالب عند تواجد اللاعب في الشاشة الرئيسية.
    // نتحقق بشكل دوري: يُظهر الزر دائماً إلا إذا كانت اللعبة قيد مباراة نشطة.
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
    fetch('/api/config')
      .then(function (r) { return r.json(); })
      .then(function (c) {
        if (c && c.socketPath) cfg.socketPath = c.socketPath;
        if (c && c.codeLength) cfg.codeLength = c.codeLength;
        buildUI();
        // نحدّث الاسم تلقائياً عند تغيّره في اللعبة
        setInterval(hideFabIfNotHome, 1200);
      })
      .catch(function () {
        // إذا فشل الاتصال بالخادم نخفي الزر
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
