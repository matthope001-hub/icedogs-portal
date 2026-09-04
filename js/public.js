// js/public.js — public landing page: countdown timer, upcoming home games list,
// broadcast notices shown before login. Depends on globals from core.js.

  let countdownTimer;

  // Keyword -> icon mapping for promo nights. Matched against the promo text
  // stored on each game; falls back to a generic ticket icon if nothing matches.
  const PROMO_ICONS = [
    { match: /home opener/i, icon: '🏒' },
    { match: /rivalry/i, icon: '🔥' },
    { match: /halloween/i, icon: '🎃' },
    { match: /birthday/i, icon: '🎂' },
    { match: /football/i, icon: '🏈' },
    { match: /teddy bear/i, icon: '🧸' },
    { match: /christmas/i, icon: '🎄' },
    { match: /new year/i, icon: '🎉' },
    { match: /autograph/i, icon: '✍️' },
    { match: /cancer/i, icon: '🎗️' },
    { match: /bobblehead/i, icon: '🪀' },
    { match: /country night/i, icon: '🤠' },
    { match: /fan appreciation/i, icon: '🙌' },
  ];

  // Positions to visually highlight (bold + IceDogs red) on the public crew list.
  // Matched case-insensitively, trimmed, to avoid silent mismatches with DB values.
  const HIGHLIGHT_POSITIONS = ['video replay', 'pa announcer'];

  function getPromoIcon(promoText) {
    if (!promoText) return '';
    const found = PROMO_ICONS.find(p => p.match.test(promoText));
    return found ? found.icon : '🎫';
  }


  async function loadLoginPageDataFromSupabase() {
    const { data: teams } = await sb.from('teams').select('name, logo_url');
    const logoMap = {};
    (teams || []).forEach(t => { if (t.name && t.logo_url) logoMap[t.name.toLowerCase()] = t.logo_url; });
    const mainLogo = logoMap['niagara'] || '';

    const todayStr = new Date().toISOString().slice(0, 10);
    const { data: games } = await sb
      .from('games')
      .select('id, game_number, date, time, opponent_name, schedule_locked, promo')
      .gte('date', todayStr)
      .order('date', { ascending: true })
      .limit(5);

    const gameList = games || [];
    const gameIds = gameList.map(g => g.id);

    let rosterByGame = {};
    if (gameIds.length) {
      const { data: assignments } = await sb
        .from('assignments')
        .select('game_id, position, officials(name)')
        .in('game_id', gameIds);
      (assignments || []).forEach(a => {
        if (!a.officials || !a.officials.name) return;
        if (!rosterByGame[a.game_id]) rosterByGame[a.game_id] = [];
        rosterByGame[a.game_id].push({ position: a.position, name: a.officials.name });
      });
      Object.values(rosterByGame).forEach(roster => roster.sort((a, b) => ALL_POSITIONS.indexOf(a.position) - ALL_POSITIONS.indexOf(b.position)));
    }

    let availByGame = {};
    if (gameIds.length) {
      const { data: avail } = await sb
        .from('availability')
        .select('game_id, status, officials(name)')
        .in('game_id', gameIds)
        .eq('status', 'Available');
      (avail || []).forEach(a => {
        if (!a.officials || !a.officials.name) return;
        if (!availByGame[a.game_id]) availByGame[a.game_id] = [];
        availByGame[a.game_id].push(a.officials.name);
      });
    }

    const upcoming = gameList.map(g => {
      const dt = new Date(g.date + "T00:00:00");
      const timeMatch = (g.time || "").match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
      if (timeMatch) {
        let h = parseInt(timeMatch[1], 10);
        const m = parseInt(timeMatch[2], 10);
        const ampm = (timeMatch[3] || "").toUpperCase();
        if (ampm === "PM" && h !== 12) h += 12;
        if (ampm === "AM" && h === 12) h = 0;
        dt.setHours(h, m, 0, 0);
      }
      return {
        gameId: g.game_number,
        logo: getLogoForTeam(g.opponent_name, logoMap),
        opponent: g.opponent_name,
        date: fmtDateLabel(g.date),
        time: g.time || "TBD",
        isoTimestamp: dt.getTime(),
        scheduleLocked: !!g.schedule_locked,
        promo: g.promo || '',
        roster: rosterByGame[g.id] || [],
        available: availByGame[g.id] || []
      };
    });

    const { data: officials } = await sb.from('officials').select('name').order('name');
    const officialNames = (officials || []).map(o => o.name);

    const nowIso = new Date().toISOString();
    const { data: broadcasts } = await sb
      .from('broadcasts')
      .select('message, type, sent_at, expires_at')
      .eq('active', true)
      .order('sent_at', { ascending: false });
    const activeBroadcasts = (broadcasts || [])
      .filter(b => !b.expires_at || b.expires_at >= nowIso)
      .map(b => ({ type: b.type, sentAt: new Date(b.sent_at).toLocaleDateString() }));

    return {
      dashboard: { mainLogo, upcoming },
      officials: officialNames,
      broadcasts: activeBroadcasts
    };
  }


  function renderLoginBroadcastNotice(broadcasts) {
    const cont = document.getElementById('loginBroadcastNotice');
    if (!cont) return;
    if (!broadcasts || broadcasts.length === 0) { cont.style.display = 'none'; return; }
    const TYPE_CFG = {
      urgent:   { icon: '🚨', label: 'URGENT',   color: '#C8102E', bg: 'rgba(200,16,46,0.08)',   border: 'rgba(200,16,46,0.3)'   },
      reminder: { icon: '⏰', label: 'REMINDER', color: '#b45309', bg: 'rgba(180,83,9,0.08)',    border: 'rgba(180,83,9,0.3)'    },
      info:     { icon: 'ℹ️', label: 'NOTICE',   color: '#1d4ed8', bg: 'rgba(29,78,216,0.08)',   border: 'rgba(29,78,216,0.3)'   }
    };
    cont.style.display = 'block';
    cont.innerHTML = broadcasts.map(function(b) {
      const cfg = TYPE_CFG[b.type] || TYPE_CFG.info;
      return '<div style="background:' + cfg.bg + '; border:1px solid ' + cfg.border + '; border-radius:12px; padding:11px 14px; margin-bottom:8px; display:flex; align-items:center; gap:10px;">'
        + '<span style="font-size:18px; flex-shrink:0;">' + cfg.icon + '</span>'
        + '<div style="flex:1; min-width:0;"><div style="font-size:11px; font-weight:900; color:' + cfg.color + '; text-transform:uppercase;">' + cfg.label + ' — Portal Notice</div>'
        + '<div style="font-size:11px; color:var(--muted-text); margin-top:2px;">Posted ' + esc(b.sentAt) + ' — Sign in to view</div></div></div>';
    }).join('');
  }


  function renderPublicDashboard(data) {
    if (data.mainLogo) {
      document.getElementById("loginLogoCont").innerHTML = '<img src="' + data.mainLogo + '" class="main-portal-logo">';
    }
    const cont = document.getElementById("publicGamesList");
    if (!data.upcoming || data.upcoming.length === 0) { cont.innerHTML = '<div class="empty-state">No upcoming home games.</div>'; return; }
    const next = data.upcoming[0];
    const now  = new Date().getTime();
    const threeHours = 3 * 60 * 60 * 1000;
    const isInProgress = next.isoTimestamp <= now && now - next.isoTimestamp < threeHours;
    var timerHtml = isInProgress
      ? '<div id="timerCont"><div class="live-badge"><span>●</span> GAME IN PROGRESS</div></div>'
      : '<div id="timerCont"><div class="timer-header">NEXT GAME IN</div><div class="timer-grid"><div class="timer-slot"><div class="timer-val" id="t-days">00</div><div class="timer-label">Days</div></div><div class="timer-sep">:</div><div class="timer-slot"><div class="timer-val" id="t-hrs">00</div><div class="timer-label">Hrs</div></div><div class="timer-sep">:</div><div class="timer-slot"><div class="timer-val" id="t-min">00</div><div class="timer-label">Min</div></div><div class="timer-sep">:</div><div class="timer-slot"><div class="timer-val" id="t-sec">00</div><div class="timer-label">Sec</div></div></div></div>';
    var html = timerHtml;
    data.upcoming.forEach(function(g) {
      var assignedHtml = g.roster && g.roster.length
        ? g.roster.map(function(r) {
            var posKey = (r.position || '').trim().toLowerCase();
            var hl = HIGHLIGHT_POSITIONS.indexOf(posKey) !== -1;
            var nameStyle = hl ? 'font-weight:900; color:#C8102E;' : 'font-weight:800;';
            var posStyle = hl ? 'color:#C8102E; font-weight:900;' : 'color:#888; font-weight:700;';
            return '<div style="display:flex; justify-content:space-between; padding:7px 0; border-bottom:1px solid #f0f0f0;"><span style="font-size:11px; text-transform:uppercase; ' + posStyle + '">' + r.position + '</span><span style="font-size:12px; ' + nameStyle + '">' + r.name + '</span></div>';
          }).join('')
        : '<div style="font-size:12px; color:var(--muted-text); font-style:italic; padding:8px 0;">No assignments yet.</div>';
      var promoHtml = g.promo
        ? '<div style="display:flex; align-items:center; gap:8px; background:linear-gradient(135deg, rgba(200,16,46,0.10), rgba(0,38,84,0.10)); border:1px solid rgba(200,16,46,0.25); border-radius:10px; padding:8px 12px; margin:8px 0;">'
          + '<span style="font-size:18px; flex-shrink:0;">' + getPromoIcon(g.promo) + '</span>'
          + '<span style="font-size:12px; font-weight:800; color:var(--icedogs-red, #C8102E);">' + esc(g.promo) + '</span>'
          + '</div>'
        : '';
      html += '<div class="list-item" style="flex-direction:column; align-items:stretch; padding:0;"><div style="display:flex; align-items:center; padding:12px 14px;"><img src="' + g.logo + '" class="team-logo" style="margin-right:12px;"><div style="flex:1;"><div style="font-weight:800; font-size:15px;">vs ' + esc(g.opponent) + '</div><div style="font-size:11px; color:var(--muted-text);">' + g.date + ' @ ' + g.time + '</div><div style="margin-top:5px;">' + (g.scheduleLocked ? '<span style="background:rgba(21,128,61,0.15); border:1px solid rgba(21,128,61,0.35); color:#22c55e; font-size:10px; font-weight:900; padding:3px 8px; border-radius:20px;">✓ Schedule Set</span>' : '<span style="background:rgba(220,38,38,0.12); border:1px solid rgba(220,38,38,0.3); color:#dc2626; font-size:10px; font-weight:900; padding:3px 8px; border-radius:20px;">⏳ Scheduling In Progress</span>') + '</div></div></div>' + (promoHtml ? '<div style="padding:0 14px;">' + promoHtml + '</div>' : '') + '<div style="padding:4px 14px 12px; border-top:1px solid var(--ios-sep);"><div style="font-size:10px; font-weight:900; color:#C8102E; margin-bottom:4px; padding-top:8px;">GAME #' + g.gameId + ' STAFF</div>' + assignedHtml + '</div></div>';
    });
    cont.innerHTML = html;
    startCountdown(next.isoTimestamp);
  }


  function startCountdown(targetTime) {
    if (countdownTimer) clearInterval(countdownTimer);
    const container = document.getElementById("timerCont");
    if (!container) return;
    function update() {
      const now  = new Date().getTime();
      const diff = targetTime - now;
      const threeHours = 3 * 60 * 60 * 1000;
      if (diff <= 0 && diff > -threeHours) { container.innerHTML = '<div class="live-badge"><span>●</span> GAME IN PROGRESS</div>'; return; }
      if (diff <= -threeHours) { clearInterval(countdownTimer); return; }
      const d = Math.floor(diff / 86400000), h = Math.floor((diff % 86400000) / 3600000), m = Math.floor((diff % 3600000) / 60000), s = Math.floor((diff % 60000) / 1000);
      const dEl = document.getElementById("t-days"), hEl = document.getElementById("t-hrs"), mEl = document.getElementById("t-min"), sEl = document.getElementById("t-sec");
      if (dEl) dEl.innerText = d.toString().padStart(2,'0');
      if (hEl) hEl.innerText = h.toString().padStart(2,'0');
      if (mEl) mEl.innerText = m.toString().padStart(2,'0');
      if (sEl) sEl.innerText = s.toString().padStart(2,'0');
    }
    update();
    countdownTimer = setInterval(update, 1000);
  }
