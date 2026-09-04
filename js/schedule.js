// js/schedule.js — official-facing tabs: Availability, My Games, Crew, Season,
// Profile (incl. change PIN, dark mode toggle in profile, add-to-home-screen),
// and the Video Replay Editor tab. Depends on globals from core.js.

  const EDITOR_ACTION_URL = "https://fcehtovermlilpvwcksl.supabase.co/functions/v1/editor-action";


  async function loadEditorMonths() {
    const { data: games } = await sb.from('games').select('window_month').order('window_month');
    const monthsRaw = [...new Set((games || []).map(g => g.window_month))];
    const months = monthsRaw.slice().sort((a, b) => {
      if (a === 'preseason') return -1;
      if (b === 'preseason') return 1;
      return a.localeCompare(b);
    });
    const { data: windows } = await sb.from('month_windows').select('month, label');
    const labelMap = {};
    (windows || []).forEach(w => { labelMap[w.month] = w.label; });
    const sel = document.getElementById('editorMonthSelect');
    sel.innerHTML = '<option value="">Select Month...</option>';
    months.forEach(m => {
      const label = labelMap[m] || (/^\d{4}-\d{2}$/.test(m) ? new Date(m + "-01T12:00:00").toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : m);
      sel.innerHTML += '<option value="' + m + '">' + esc(label) + '</option>';
    });
  }


  async function loadEditorGames() {
    const month = document.getElementById('editorMonthSelect').value;
    const cont = document.getElementById('editorGameList');
    if (!month) { cont.innerHTML = ''; return; }
    cont.innerHTML = '<div style="padding:14px; text-align:center; color:var(--muted-text); font-size:12px;">Loading...</div>';
    const position = sessionEditorPosition;

    const { data: games } = await sb.from('games').select('id, game_number, date, time, opponent_name, promo')
      .eq('window_month', month).order('date');
    const gameList = games || [];
    if (!gameList.length) { cont.innerHTML = '<div class="empty-state">No games this month.</div>'; return; }

    const gameIds = gameList.map(g => g.id);
    const { data: assignments } = await sb.from('assignments').select('game_id, position, officials(name)').in('game_id', gameIds).eq('position', position);
    const { data: restrictions } = await sb.from('role_restrictions').select('officials(name)').eq('position', position);
    const pool = (restrictions || []).map(r => r.officials?.name).filter(Boolean).sort();

    const assignByGame = {};
    (assignments || []).forEach(a => { assignByGame[a.game_id] = a.officials ? a.officials.name : ''; });

    cont.innerHTML = gameList.map(g => {
      const dateLabel = new Date(g.date + "T12:00:00").toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const current = assignByGame[g.id] || '';
      const optHtml = '<option value="">-- Vacant --</option>' + pool.map(n => '<option value="' + esc(n) + '"' + (n === current ? ' selected' : '') + '>' + esc(n) + '</option>').join('');
      const promoHtml = g.promo
        ? '<div style="font-size:10px; color:var(--icedogs-red); font-weight:800; margin-top:2px;">' + getPromoIcon(g.promo) + ' ' + esc(g.promo) + '</div>'
        : '';
      return '<div class="list-item">'
        + '<div style="flex:1;"><div style="font-weight:700; font-size:13px;">#' + esc(g.game_number) + ' vs ' + esc(g.opponent_name) + '</div><div style="font-size:11px; color:var(--muted-text);">' + dateLabel + ' @ ' + (g.time || 'TBD') + '</div>' + promoHtml + '</div>'
        + '<select style="width:150px; height:38px; margin:0; font-size:12px;" onchange="updateEditorAssignment(\'' + g.id + '\', this.value)">' + optHtml + '</select>'
        + '</div>';
    }).join('');
  }


  async function updateEditorAssignment(gameId, officialName) {
    const res = await fetch(EDITOR_ACTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
      body: JSON.stringify({ token: sessionToken, gameId, position: sessionEditorPosition, officialName: officialName || null })
    });
    const data = await res.json();
    if (data.success) showToast('✓ Saved');
    else { showToast(data.msg || 'Failed to update'); loadEditorGames(); }
  }


  async function loadProfile() {
    const cont = document.getElementById('profileCont');
    cont.innerHTML = skeletonRows(3);

    const { data: me } = await sb.from('officials').select('name, email, phone, address, pass_pref, profile_complete').eq('id', sessionOfficial.id).maybeSingle();
    const { data: admins } = await sb.from('officials').select('name, email').eq('role', 'Admin').order('name');
    const ADMIN_ORDER = ['Wayne Briggs-Jude', 'Curtis Pirson'];
    const sortedAdmins = (admins || []).slice().sort((a, b) => {
      const ai = ADMIN_ORDER.indexOf(a.name);
      const bi = ADMIN_ORDER.indexOf(b.name);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      return a.name.localeCompare(b.name);
    });

    const initial = (me.name || '?').charAt(0).toUpperCase();
    let html = '<div class="card">'
      + '<div style="display:flex; align-items:center; gap:10px; margin-bottom:16px;">'
      + '<div style="width:40px; height:40px; border-radius:50%; background:var(--icedogs-red); color:white; display:flex; align-items:center; justify-content:center; font-weight:900; font-size:16px;">' + initial + '</div>'
      + '<div><div style="font-weight:900; font-size:15px;">' + esc(me.name) + '</div><div style="font-size:11px; color:#888;">Profile on file</div></div></div>'
      + '<div style="border-radius:12px; overflow:hidden; border:1px solid var(--ios-sep); margin-bottom:16px;">'
      + profileRow('Email', me.email)
      + profileRow('Phone', me.phone)
      + profileRow('Address', me.address)
      + profileRow('Pass Pref', me.pass_pref, true)
      + '</div>';

    if (me.profile_complete) {
      html += '<div style="background:rgba(245,158,11,0.12); border:1px solid rgba(245,158,11,0.35); border-radius:12px; padding:14px 16px; margin-bottom:16px;">'
        + '<div style="font-weight:900; font-size:12px; color:#f59e0b; margin-bottom:4px;">🔒 PROFILE LOCKED</div>'
        + '<div style="font-size:12px; color:var(--muted-text); line-height:1.5;">To update your information, please contact an admin below.</div></div>';
    }

    html += '<div style="border-radius:12px; overflow:hidden; border:1px solid var(--ios-sep);">'
      + sortedAdmins.map((a, i, arr) => {
          const border = i < arr.length - 1 ? 'border-bottom:1px solid var(--ios-sep);' : '';
          const emailBtn = a.email ? '<a href="mailto:' + a.email + '" style="background:var(--icedogs-red); color:white; padding:6px 12px; border-radius:8px; font-size:11px; font-weight:700; text-decoration:none;">Email</a>' : '';
          return '<div style="display:flex; align-items:center; gap:10px; padding:11px 14px; ' + border + '">'
            + '<div style="width:32px; height:32px; border-radius:50%; background:var(--icedogs-red); color:white; display:flex; align-items:center; justify-content:center; font-weight:900; font-size:13px;">' + a.name.charAt(0) + '</div>'
            + '<div style="flex:1;"><div style="font-weight:700; font-size:13px;">' + esc(a.name) + '</div>' + (a.email ? '<div style="font-size:11px; color:#888;">' + esc(a.email) + '</div>' : '') + '</div>'
            + emailBtn + '</div>';
        }).join('')
      + '</div>'
      + '<div class="card" style="margin-top:14px;">'
      + '<div style="font-weight:900; font-size:14px; margin-bottom:12px;">🔑 CHANGE PIN</div>'
      + '<div style="position:relative;">'
      + '<input type="password" id="pinCurrentPin" placeholder="Current PIN" inputmode="numeric" maxlength="6" style="text-align:center; padding-right:44px;">'
      + '<button type="button" onclick="togglePinVisibility(\'pinCurrentPin\', this)" style="position:absolute; right:12px; top:14px; background:none; border:none; cursor:pointer; padding:4px;" aria-label="Show current PIN">'
      + '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#888" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>'
      + '</button></div>'
      + '<div style="position:relative;">'
      + '<input type="password" id="pinNewPin" placeholder="New PIN (4-6 digits)" inputmode="numeric" maxlength="6" style="text-align:center; padding-right:44px;">'
      + '<button type="button" onclick="togglePinVisibility(\'pinNewPin\', this)" style="position:absolute; right:12px; top:14px; background:none; border:none; cursor:pointer; padding:4px;" aria-label="Show new PIN">'
      + '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#888" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>'
      + '</button></div>'
      + '<button class="btn-primary" onclick="submitChangePin()">Update PIN</button>'
      + '<div id="pinChangeMsg" style="display:none; font-size:12px; font-weight:700; text-align:center; margin-top:10px;"></div>'
      + '</div>'
      + '<div class="card" style="margin-top:14px;">'
      + '<div style="font-weight:900; font-size:14px; margin-bottom:6px;">📅 CALENDAR SYNC</div>'
      + '<div style="font-size:12px; color:var(--muted-text); margin-bottom:14px; line-height:1.5;">Subscribe once in your phone or computer calendar to see your assigned games automatically. Your device syncs on its own schedule — changes may take a few hours to appear. Always check the portal before game day.</div>'
      + '<input type="text" readonly id="icsUrlField" value="' + esc(ICS_FEED_URL + (sessionOfficial.icsToken || '')) + '" onclick="this.select()" style="font-size:12px;">'
      + '<button class="btn-primary" onclick="copyIcsUrl()">Copy Calendar Link</button>'
      + '<div id="icsCopyMsg" style="display:none; font-size:12px; font-weight:700; text-align:center; margin-top:10px;"></div>'
      + '</div>'
      + '<div style="display:flex; align-items:center; justify-content:space-between; padding:14px 16px; background:var(--ios-card); border-radius:12px; border:1px solid var(--ios-sep); margin-top:14px;">'
      + '<div><div style="font-weight:800; font-size:14px;">🌙 Dark Mode</div><div style="font-size:11px; color:var(--muted-text); margin-top:2px;">Switch to a darker colour scheme</div></div>'
      + '<label class="switch"><input type="checkbox" id="darkModeToggle" ' + (document.body.classList.contains('dark-mode') ? 'checked' : '') + ' onchange="toggleDarkMode(this.checked)"><span class="slider"></span></label></div>'
      + '</div>'
      + '<div id="homeScreenCard" style="display:none; padding:14px 16px; background:var(--ios-card); border-radius:12px; border:1px solid var(--ios-sep); margin-top:14px;">'
      + '<div style="font-weight:800; font-size:14px; margin-bottom:2px;">📱 Add to Home Screen</div>'
      + '<div id="homeScreenBody"></div>'
      + '</div>';

    cont.innerHTML = html;
    setupHomeScreenCard();
  }


  let deferredInstallPrompt = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
  });


  function setupHomeScreenCard() {
    const card = document.getElementById('homeScreenCard');
    const body = document.getElementById('homeScreenBody');
    if (!card || !body) return;

    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    if (isStandalone) return; // already installed, don't show

    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

    card.style.display = 'block';
    if (deferredInstallPrompt) {
      body.innerHTML = '<div style="font-size:11px; color:var(--muted-text); margin-bottom:10px;">Get one-tap access from your home screen.</div>'
        + '<button onclick="triggerInstallPrompt()" style="width:100%; height:44px; background:var(--icedogs-red); border:none; border-radius:10px; color:white; font-size:13px; font-weight:800; cursor:pointer;">Add to Home Screen</button>';
    } else if (isIOS) {
      body.innerHTML = '<div style="font-size:12px; color:var(--muted-text); line-height:1.6; margin-top:6px;">Tap the <strong>Share</strong> icon <span style="font-size:14px;">⬆️</span> in Safari\'s toolbar, then choose <strong>"Add to Home Screen."</strong></div>';
    } else {
      card.style.display = 'none';
    }
  }


  async function triggerInstallPrompt() {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    if (choice.outcome === 'accepted') {
      document.getElementById('homeScreenCard').style.display = 'none';
    }
  }


  const CHANGE_PIN_URL = "https://fcehtovermlilpvwcksl.supabase.co/functions/v1/change-pin";
  const ICS_FEED_URL = "https://fcehtovermlilpvwcksl.supabase.co/functions/v1/ics-feed?token=";

  async function copyIcsUrl() {
    const field = document.getElementById('icsUrlField');
    const msgEl = document.getElementById('icsCopyMsg');
    try {
      await navigator.clipboard.writeText(field.value);
      msgEl.style.display = 'block'; msgEl.style.color = '#166534'; msgEl.textContent = '✓ Copied! Paste this into your calendar app\'s "Subscribe by URL" option.';
    } catch (e) {
      field.select();
      msgEl.style.display = 'block'; msgEl.style.color = 'var(--muted-text)'; msgEl.textContent = 'Select the link above and copy it manually.';
    }
  }


  function togglePinVisibility(inputId, btn) {
    const input = document.getElementById(inputId);
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.innerHTML = showing
      ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#888" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>'
      : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#888" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>';
    btn.setAttribute('aria-label', showing ? 'Show PIN' : 'Hide PIN');
  }


  async function submitChangePin() {
    const currentPin = document.getElementById('pinCurrentPin').value.trim();
    const newPin = document.getElementById('pinNewPin').value.trim();
    const msgEl = document.getElementById('pinChangeMsg');

    if (!/^\d+$/.test(currentPin)) {
      msgEl.style.display = 'block'; msgEl.style.color = '#C8102E'; msgEl.textContent = 'Enter your current PIN';
      return;
    }
    if (!/^\d{4,6}$/.test(newPin)) {
      msgEl.style.display = 'block'; msgEl.style.color = '#C8102E'; msgEl.textContent = 'New PIN must be 4-6 digits';
      return;
    }

    msgEl.style.display = 'block'; msgEl.style.color = 'var(--muted-text)'; msgEl.textContent = 'Updating...';
    try {
      const res = await fetch(CHANGE_PIN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
        body: JSON.stringify({ token: sessionToken, currentPin, newPin })
      });
      const data = await res.json();
      if (data.success) {
        msgEl.style.color = '#166534'; msgEl.textContent = '✓ PIN updated!';
        document.getElementById('pinCurrentPin').value = '';
        document.getElementById('pinNewPin').value = '';
      } else {
        msgEl.style.color = '#C8102E'; msgEl.textContent = data.msg || 'Failed to update PIN';
      }
    } catch (e) {
      msgEl.style.color = '#C8102E'; msgEl.textContent = 'Network error — try again';
    }
  }


  function profileRow(label, value, isLast) {
    return '<div style="display:flex; justify-content:space-between; padding:11px 14px;' + (isLast ? '' : ' border-bottom:1px solid var(--ios-sep);') + ' background:var(--ios-card);">'
      + '<span style="font-size:11px; font-weight:800; color:var(--muted-text); text-transform:uppercase;">' + label + '</span>'
      + '<span style="font-size:13px; font-weight:700;">' + esc(value || '--') + '</span></div>';
  }


  let _seasonLoaded = false;

  async function loadSeason() {
    if (_seasonLoaded) return;
    _seasonLoaded = true;
    const cont = document.getElementById('seasonCont');
    cont.innerHTML = skeletonRows(4);

    const { data: teams } = await sb.from('teams').select('name, logo_url');
    const logoMap = {};
    (teams || []).forEach(t => { if (t.name && t.logo_url) logoMap[t.name.toLowerCase()] = t.logo_url; });

    const { data: sched } = await sb.from('schedule').select('*').order('date');
    const { data: syncSetting } = await sb.from('app_settings').select('value').eq('key', 'last_ohl_sync').maybeSingle();
    const lastSyncLabel = syncSetting && syncSetting.value
      ? new Date(syncSetting.value).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      : null;
    const games = sched || [];
    if (!games.length) {
      cont.innerHTML = '<div class="card"><div class="empty-state">No schedule synced yet.</div></div>';
      return;
    }

    let wins = 0, losses = 0, ties = 0;
    const enriched = games.map(g => {
      const hasScore = g.home_score !== null && g.away_score !== null;
      let result = null;
      if (hasScore) {
        const niagaraScore = g.is_home ? g.home_score : g.away_score;
        const oppScore = g.is_home ? g.away_score : g.home_score;
        result = niagaraScore > oppScore ? 'W' : (niagaraScore < oppScore ? 'L' : 'T');
        if (result === 'W') wins++; else if (result === 'L') losses++; else ties++;
      }
      const opponent = g.is_home ? g.away_team : g.home_team;
      return { ...g, hasScore, result, opponent };
    });

    const totalPlayed = wins + losses + ties;
    const recordStr = totalPlayed > 0 ? wins + '-' + losses + (ties > 0 ? '-' + ties : '') : 'Season not started';

    const monthMap = {}, monthOrder = [];
    enriched.forEach(g => {
      const key = new Date(g.date + "T12:00:00").toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      if (!monthMap[key]) { monthMap[key] = []; monthOrder.push(key); }
      monthMap[key].push(g);
    });

    let html = '<div class="card" style="padding:14px 16px; border:2px solid var(--icedogs-red); margin-bottom:12px; text-align:center;">'
      + '<div style="font-size:10px; font-weight:900; color:var(--muted-text); text-transform:uppercase; margin-bottom:4px;">SEASON RECORD</div>'
      + '<div style="font-size:28px; font-weight:900;">' + recordStr + '</div>'
      + (totalPlayed > 0 ? '<div style="font-size:11px; color:var(--muted-text); margin-top:3px;">' + totalPlayed + ' game' + (totalPlayed !== 1 ? 's' : '') + ' played</div>' : '')
      + (lastSyncLabel ? '<div style="font-size:10px; color:var(--muted-text); margin-top:6px; border-top:1px solid var(--ios-sep); padding-top:6px;">Last synced ' + lastSyncLabel + '</div>' : '')
      + '</div>';

    monthOrder.forEach(monthKey => {
      const mGames = monthMap[monthKey];
      const monthId = 'season_' + monthKey.replace(/\s/g, '_');
      html += '<div class="card" style="padding:0; overflow:hidden; margin-bottom:10px;">'
        + '<div onclick="toggleSeasonMonth(\'' + monthId + '\')" style="display:flex; align-items:center; justify-content:space-between; padding:12px 16px; background:#fafafa; border-bottom:1px solid var(--ios-sep); cursor:pointer;">'
        + '<span style="font-weight:900; font-size:13px; text-transform:uppercase;">' + monthKey + '</span>'
        + '<span id="' + monthId + '_chev" style="color:var(--muted-text); font-size:12px;">▼</span></div>'
        + '<div id="' + monthId + '" style="display:none;">'
        + mGames.map(g => {
            const dateLabel = new Date(g.date + "T12:00:00").toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
            const logo = getLogoForTeam(g.opponent, logoMap) || '';
            const homeAway = g.is_home
              ? '<span style="font-size:9px; font-weight:900; background:var(--icedogs-red); color:white; padding:1px 5px; border-radius:3px; margin-left:4px;">HOME</span>'
              : '<span style="font-size:9px; font-weight:900; background:var(--ios-sep); color:var(--muted-text); padding:1px 5px; border-radius:3px; margin-left:4px;">AWAY</span>';
            const scoreHtml = g.hasScore
              ? '<div style="font-size:15px; font-weight:900;">' + (g.is_home ? g.home_score : g.away_score) + ' – ' + (g.is_home ? g.away_score : g.home_score) + '</div>'
              : '<div style="font-size:11px; font-weight:700; color:var(--muted-text);">' + (g.game_time || 'Upcoming') + '</div>';
            const badge = g.hasScore
              ? '<div class="result-badge result-' + g.result + '">' + g.result + '</div>'
              : '<div class="result-badge result-upcoming">—</div>';
            const logoHtml = logo
              ? '<img src="' + logo + '" style="width:32px; height:32px; object-fit:contain;">'
              : '<div style="width:32px; height:32px; border-radius:50%; background:var(--ios-sep); display:flex; align-items:center; justify-content:center; font-size:10px; font-weight:900;">' + (g.opponent ? g.opponent.charAt(0) : '?') + '</div>';
            return '<div style="display:flex; align-items:center; gap:10px; padding:11px 14px; border-bottom:1px solid var(--ios-sep);">'
              + logoHtml
              + '<div style="flex:1; min-width:0;"><div style="font-weight:800; font-size:13px;">vs ' + esc(g.opponent) + homeAway + '</div>'
              + '<div style="font-size:11px; color:var(--muted-text); margin-top:1px;">' + dateLabel + '</div></div>'
              + scoreHtml + badge + '</div>';
          }).join('')
        + '</div></div>';
    });

    cont.innerHTML = html;
  }


  function toggleSeasonMonth(monthId) {
    const body = document.getElementById(monthId);
    const chev = document.getElementById(monthId + '_chev');
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    if (chev) chev.textContent = open ? '▼' : '▲';
  }


  async function loadCrew() {
    const cont = document.getElementById('crewList');
    cont.innerHTML = skeletonRows(3);

    const todayStr = new Date().toISOString().slice(0, 10);
    const { data: games } = await sb
      .from('games')
      .select('id, game_number, date, time, opponent_name, promo')
      .gte('date', todayStr)
      .order('date')
      .limit(10);

    const gameList = games || [];
    if (!gameList.length) { cont.innerHTML = '<div class="empty-state">No upcoming games.</div>'; return; }

    const { data: teams } = await sb.from('teams').select('name, logo_url');
    const logoMap = {};
    (teams || []).forEach(t => { if (t.name && t.logo_url) logoMap[t.name.toLowerCase()] = t.logo_url; });

    const gameIds = gameList.map(g => g.id);
    const { data: assignments } = await sb
      .from('assignments')
      .select('game_id, position, officials(name)')
      .in('game_id', gameIds);
    const { data: avail } = await sb
      .from('availability')
      .select('game_id, status, officials(name)')
      .in('game_id', gameIds)
      .eq('status', 'Available');

    const rosterByGame = {};
    (assignments || []).forEach(a => {
      if (!a.officials) return;
      if (!rosterByGame[a.game_id]) rosterByGame[a.game_id] = [];
      rosterByGame[a.game_id].push({ position: a.position, name: a.officials.name });
    });
    Object.values(rosterByGame).forEach(roster => roster.sort((a, b) => ALL_POSITIONS.indexOf(a.position) - ALL_POSITIONS.indexOf(b.position)));
    const availByGame = {};
    (avail || []).forEach(a => {
      if (!a.officials) return;
      if (!availByGame[a.game_id]) availByGame[a.game_id] = [];
      availByGame[a.game_id].push(a.officials.name);
    });

    cont.innerHTML = gameList.map(g => {
      const dateLabel = new Date(g.date + "T12:00:00").toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const roster = rosterByGame[g.id] || [];
      const assignedNames = new Set(roster.map(r => r.name));
      const unscheduled = (availByGame[g.id] || []).filter(n => !assignedNames.has(n));

      const crewRows = roster.length
        ? roster.map(r => {
            const posKey = (r.position || '').trim().toLowerCase();
            const hl = HIGHLIGHT_POSITIONS.indexOf(posKey) !== -1;
            const nameStyle = hl ? 'font-weight:900; color:var(--icedogs-red);' : 'font-weight:700;';
            const posStyle = hl ? 'color:var(--icedogs-red); font-weight:900;' : 'color:var(--muted-text); font-weight:900;';
            return '<div style="display:flex; justify-content:space-between; padding:5px 0; border-bottom:1px solid var(--ios-sep);"><span style="font-size:10px; text-transform:uppercase; ' + posStyle + '">' + esc(r.position) + '</span><span style="font-size:12px; ' + nameStyle + '">' + esc(r.name) + (r.name === sessionOfficial.name ? ' ★' : '') + '</span></div>';
          }).join('')
        : '<div style="font-size:12px; color:var(--muted-text); font-style:italic; padding:6px 0;">No assignments yet.</div>';

      const availChips = unscheduled.length
        ? '<div style="margin-top:8px; padding-top:8px; border-top:1px solid var(--ios-sep);"><div style="font-size:10px; font-weight:900; color:var(--muted-text); text-transform:uppercase; margin-bottom:6px;">Available · Not Scheduled</div><div style="display:flex; flex-wrap:wrap; gap:5px;">'
          + unscheduled.map(n => '<span style="background:#f0fdf4; border:1px solid #86efac; color:#166534; font-size:11px; font-weight:700; padding:3px 9px; border-radius:20px;">' + esc(n) + (n === sessionOfficial.name ? ' ★' : '') + '</span>').join('')
          + '</div></div>'
        : '';

      const logo = getLogoForTeam(g.opponent_name, logoMap) || '';
      const logoHtml = logo
        ? '<img src="' + esc(logo) + '" style="width:32px; height:32px; object-fit:contain; flex-shrink:0;" onerror="this.style.display=\'none\'">'
        : '<div style="width:32px; height:32px; border-radius:50%; background:var(--ios-sep); flex-shrink:0; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:900; color:var(--muted-text);">' + (g.opponent_name ? g.opponent_name.charAt(0) : '?') + '</div>';

      const promoHtml = g.promo
        ? '<div style="font-size:10px; color:var(--icedogs-red); font-weight:800; margin-bottom:6px;">' + getPromoIcon(g.promo) + ' ' + esc(g.promo) + '</div>'
        : '';

      return '<div style="border-bottom:1px solid var(--ios-sep); padding:12px 14px; display:flex; gap:10px;">'
        + logoHtml
        + '<div style="flex:1; min-width:0;">'
        + '<div style="font-weight:800; font-size:13px;">vs ' + esc(g.opponent_name) + '</div>'
        + '<div style="font-size:11px; color:var(--muted-text); margin-bottom:6px;">' + dateLabel + ' @ ' + (g.time || 'TBD') + '</div>'
        + promoHtml
        + crewRows + availChips
        + '</div></div>';
    }).join('');
  }


  async function loadMyGames() {
    const cont = document.getElementById('myGamesList');
    cont.innerHTML = skeletonRows(3);

    const { data: assignments } = await sb
      .from('assignments')
      .select('position, games(id, game_number, date, time, opponent_name, promo)')
      .eq('official_id', sessionOfficial.id);

    const rows = (assignments || [])
      .filter(a => a.games)
      .map(a => ({ position: a.position, date: a.games.date, time: a.games.time, opponent: a.games.opponent_name, gameNumber: a.games.game_number, promo: a.games.promo }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    if (!rows.length) {
      cont.innerHTML = '<div class="empty-state">No games assigned yet.</div>';
      return;
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    const upcoming = rows.filter(r => r.date >= todayStr);
    const past = rows.filter(r => r.date < todayStr);

    function rowHtml(r, isPast) {
      const dateLabel = new Date(r.date + "T12:00:00").toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const promoHtml = r.promo
        ? '<div style="font-size:10px; color:var(--icedogs-red); font-weight:800; margin-top:2px;">' + getPromoIcon(r.promo) + ' ' + esc(r.promo) + '</div>'
        : '';
      return '<div class="list-item"' + (isPast ? ' style="opacity:0.7;"' : '') + '>'
        + '<div style="flex:1;"><div style="font-weight:700; font-size:13px;">' + (isPast ? '' : '') + 'vs ' + esc(r.opponent) + '</div>'
        + '<div style="font-size:11px; color:var(--muted-text);">' + dateLabel + ' @ ' + (r.time || 'TBD') + '</div>' + promoHtml + '</div>'
        + '<span style="background:var(--icedogs-red); color:white; font-size:10px; font-weight:900; padding:4px 10px; border-radius:20px; white-space:nowrap;">' + esc(r.position) + '</span>'
        + '</div>';
    }

    let html = '';
    if (upcoming.length) {
      html += upcoming.map(r => rowHtml(r, false)).join('');
    } else {
      html += '<div class="empty-state">No upcoming games.</div>';
    }
    if (past.length) {
      html += '<div style="padding:10px 15px; font-size:11px; font-weight:900; color:var(--muted-text); text-transform:uppercase; border-top:1px solid var(--ios-sep); border-bottom:1px solid var(--ios-sep); background:#fafafa;">Past Games</div>';
      html += past.map(r => rowHtml(r, true)).join('');
    }
    cont.innerHTML = html;
  }

  const SAVE_AVAIL_URL = "https://fcehtovermlilpvwcksl.supabase.co/functions/v1/save-availability";

  let reasonOptions = [];

  let currentMonthGames = [];


  async function loadAvailMonths() {
    const { data: monthsRaw } = await sb.from('month_windows').select('month, label, status').eq('status', 'Active').order('month');
    const months = (monthsRaw || []).slice().sort((a, b) => {
      if (a.month === 'preseason') return -1;
      if (b.month === 'preseason') return 1;
      return a.month.localeCompare(b.month);
    });
    const { data: reasons } = await sb.from('reasons').select('label').order('sort_order');
    reasonOptions = (reasons || []).map(r => r.label);

    const sel = document.getElementById('availMonthSelect');
    sel.innerHTML = '<option value="">Select Month...</option>';
    (months || []).forEach(m => {
      const label = m.label || (/^\d{4}-\d{2}$/.test(m.month) ? new Date(m.month + "-01T12:00:00").toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : m.month);
      sel.innerHTML += '<option value="' + m.month + '">' + esc(label) + '</option>';
    });
  }


  async function loadAvailGames() {
    const month = document.getElementById('availMonthSelect').value;
    const cont = document.getElementById('availGameList');
    const saveBtn = document.getElementById('availSaveBtn');
    document.getElementById('availMsg').style.display = 'none';
    if (!month) { cont.innerHTML = ''; saveBtn.style.display = 'none'; return; }

    cont.innerHTML = '<div style="padding:14px; text-align:center; color:var(--muted-text); font-size:12px;">Loading games...</div>';

    const { data: games } = await sb
      .from('games')
      .select('id, game_number, date, time, opponent_name, promo')
      .eq('window_month', month)
      .order('date');

    const { data: existing } = await sb
      .from('availability')
      .select('game_id, status, reason')
      .eq('official_id', sessionOfficial.id);
    const existingMap = {};
    (existing || []).forEach(e => { existingMap[e.game_id] = e; });

    currentMonthGames = games || [];

    if (!currentMonthGames.length) {
      cont.innerHTML = '<div class="empty-state">No games scheduled this month.</div>';
      saveBtn.style.display = 'none';
      return;
    }

    cont.innerHTML = currentMonthGames.map(g => {
      const saved = existingMap[g.id];
      const status = saved ? saved.status : 'Available';
      const dateLabel = new Date(g.date + "T12:00:00").toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const reasonOpts = reasonOptions.map(r => '<option value="' + esc(r) + '"' + (saved && saved.reason === r ? ' selected' : '') + '>' + esc(r) + '</option>').join('');
      const promoHtml = g.promo
        ? '<div style="font-size:10px; color:var(--icedogs-red); font-weight:800; margin-top:2px;">' + getPromoIcon(g.promo) + ' ' + esc(g.promo) + '</div>'
        : '';
      return '<div class="list-item" style="flex-direction:column; align-items:stretch;" data-game-id="' + g.id + '">'
        + '<div style="display:flex; justify-content:space-between; align-items:center; width:100%;">'
        + '<div><div style="font-weight:700; font-size:13px;">vs ' + esc(g.opponent_name) + '</div><div style="font-size:11px; color:var(--muted-text);">' + dateLabel + ' @ ' + (g.time || 'TBD') + '</div>' + promoHtml + '</div>'
        + '<select class="avail-status" style="width:140px; height:38px; margin:0;" onchange="toggleReasonVisibility(this)">'
        + '<option value="Available"' + (status === 'Available' ? ' selected' : '') + '>Available</option>'
        + '<option value="Not Available"' + (status === 'Not Available' ? ' selected' : '') + '>Not Available</option>'
        + '</select></div>'
        + '<select class="avail-reason" style="margin-top:8px; height:38px; display:' + (status === 'Not Available' ? 'block' : 'none') + ';"><option value="">-- Reason --</option>' + reasonOpts + '</select>'
        + '</div>';
    }).join('');

    saveBtn.style.display = 'block';
  }


  function toggleReasonVisibility(sel) {
    const row = sel.closest('.list-item');
    const reasonSel = row.querySelector('.avail-reason');
    reasonSel.style.display = sel.value === 'Not Available' ? 'block' : 'none';
  }


  async function submitAvailability() {
    const month = document.getElementById('availMonthSelect').value;
    const rows = document.querySelectorAll('#availGameList .list-item');
    const results = [];
    rows.forEach(row => {
      const gameDbId = row.dataset.gameId;
      const game = currentMonthGames.find(g => g.id === gameDbId);
      if (!game) return;
      const status = row.querySelector('.avail-status').value;
      const reason = row.querySelector('.avail-reason').value;
      results.push({ gameId: game.game_number, status, reason });
    });

    const msgEl = document.getElementById('availMsg');
    msgEl.style.display = 'block';
    msgEl.style.color = 'var(--muted-text)';
    msgEl.textContent = 'Saving...';

    try {
      const res = await fetch(SAVE_AVAIL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
        body: JSON.stringify({ token: sessionToken, month, results })
      });
      const data = await res.json();
      if (data.success) {
        msgEl.style.color = '#166534';
        msgEl.textContent = '✓ Availability saved!';
      } else if (data.alreadySubmitted) {
        msgEl.style.color = '#991b1b';
        msgEl.textContent = 'Already submitted for this month.';
      } else {
        msgEl.style.color = '#C8102E';
        msgEl.textContent = data.msg || 'Save failed';
      }
    } catch (e) {
      msgEl.style.color = '#C8102E';
      msgEl.textContent = 'Network error — try again';
    }
  }
