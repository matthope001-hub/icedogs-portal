// js/admin.js — everything under the Admin tab: scheduling matrix, games CRUD,
// teams CRUD, officials CRUD, fixed staff (PA Announcer/Video Replay), skills matrix,
// invites, availability windows, broadcasts, position setup, backups, season reset,
// stats/leaderboard. Depends on globals from core.js (sb, esc, callAdminAction, etc.).

  const SYNC_OHL_URL = "https://fcehtovermlilpvwcksl.supabase.co/functions/v1/sync-ohl-schedule";

  const EXPORT_BACKUP_URL = "https://fcehtovermlilpvwcksl.supabase.co/functions/v1/export-backup";


  async function exportBackupNow() {
    const status = document.getElementById('exportBackupStatus');
    status.textContent = 'Exporting...';
    showSaving('Exporting backup...');
    try {
      const res = await fetch(EXPORT_BACKUP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
        body: JSON.stringify({ token: sessionToken })
      });
      const data = await res.json();
      if (data.success) {
        hideSaving('Sent!');
        status.textContent = '✓ Backup emailed — check your Gmail inbox.';
      } else {
        hideSavingError('Export failed');
        status.textContent = '✗ ' + (data.msg || 'unknown error');
      }
    } catch (e) {
      hideSavingError('Export failed');
      status.textContent = '✗ Network error';
    }
  }


  async function adminSyncIceDogsSchedule() {
    const status = document.getElementById('syncIceDogsStatus');
    status.textContent = 'Syncing...';
    showSaving('Syncing IceDogs schedule...');
    try {
      const res = await fetch(SYNC_OHL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
        body: JSON.stringify({ token: sessionToken })
      });
      const data = await res.json();
      if (data.success) {
        hideSaving('Sync complete!');
        status.textContent = '✓ Synced ' + data.totalFromApi + ' games — ' + data.gamesInserted + ' new home game(s) added.';
      } else {
        hideSavingError('Sync failed');
        status.textContent = '✗ ' + (data.msg || 'unknown error');
      }
    } catch (e) {
      hideSavingError('Sync failed');
      status.textContent = '✗ Network error';
    }
  }

  let broadcastType = 'reminder';


  function switchAdminTopTab(tab) {
    document.getElementById('adminTopUsage').style.display = tab === 'usage' ? 'block' : 'none';
    document.getElementById('adminTopSettings').style.display = tab === 'settings' ? 'block' : 'none';
    const btnUsage = document.getElementById('adminTopBtnUsage');
    const btnSettings = document.getElementById('adminTopBtnSettings');
    btnUsage.style.background = tab === 'usage' ? 'var(--icedogs-red)' : 'none';
    btnUsage.style.color = tab === 'usage' ? 'white' : '#666';
    btnSettings.style.background = tab === 'settings' ? 'var(--icedogs-red)' : 'none';
    btnSettings.style.color = tab === 'settings' ? 'white' : '#666';
    if (tab === 'usage') switchAdminSubTab('sked');
  }

  function switchAdminSubTab(tab) {
    document.getElementById('adminSubSked').style.display = tab === 'sked' ? 'block' : 'none';
    document.getElementById('adminSubAvailWin').style.display = tab === 'availWin' ? 'block' : 'none';
    document.getElementById('adminSubBroadcast').style.display = tab === 'broadcast' ? 'block' : 'none';
    document.getElementById('adminSubGames').style.display = tab === 'games' ? 'block' : 'none';
    document.getElementById('adminSubOfficials').style.display = tab === 'officials' ? 'block' : 'none';
    document.getElementById('adminSubAvail').style.display = tab === 'avail' ? 'block' : 'none';
    document.getElementById('adminSubStats').style.display = tab === 'stats' ? 'block' : 'none';
    ['Sked', 'AvailWin', 'Broadcast', 'Games', 'Officials', 'Avail', 'Stats'].forEach(t => {
      const btn = document.getElementById('subTabBtn' + t);
      if (!btn) return;
      const key = t.charAt(0).toLowerCase() + t.slice(1);
      const active = key === tab;
      btn.style.background = active ? 'var(--icedogs-red)' : 'none';
      btn.style.color = active ? 'white' : '#666';
    });
    if (tab === 'avail') loadAdminAvailOfficials();
    if (tab === 'stats') { loadSeasonStats(); loadReasonStats(); loadSubmissionOverview(); }
  }


  function getCurrentSeasonRange() {
    const now = new Date();
    const curMonth = now.getMonth() + 1;
    const curYear = now.getFullYear();
    // Cutover in July, not September — by mid-summer, all the real activity
    // (games being scheduled, officials being lined up) is for the upcoming
    // season, so treat July onward as already "in" that season.
    const seasonStartYear = curMonth >= 7 ? curYear : curYear - 1;
    const seasonEndYear = seasonStartYear + 1;
    return {
      start: seasonStartYear + '-07-01',
      end: seasonEndYear + '-07-01',
    };
  }


  async function loadSubmissionOverview() {
    const cont = document.getElementById('submissionOverviewCont');
    cont.innerHTML = '<div style="padding:20px; text-align:center; color:var(--muted-text); font-size:12px;">Loading...</div>';

    const { data: officials } = await sb.from('officials').select('id, name').order('name');
    const { data: fixedStaff } = await sb.from('role_restrictions').select('official_id').in('position', ['PA ANNOUNCER', 'VIDEO REPLAY']);
    const fixedStaffIds = new Set((fixedStaff || []).map(r => r.official_id));
    const regularOfficials = (officials || []).filter(o => !fixedStaffIds.has(o.id));

    const { data: games } = await sb.from('games').select('id, date').order('date');
    const gamesByMonth = {};
    (games || []).forEach(g => {
      const key = g.date.slice(0, 7);
      if (!gamesByMonth[key]) gamesByMonth[key] = [];
      gamesByMonth[key].push(g.id);
    });
    const months = Object.keys(gamesByMonth).sort();

    if (!regularOfficials.length || !months.length) {
      cont.innerHTML = '<div class="empty-state">No data yet.</div>';
      return;
    }

    const { data: availRows } = await sb.from('availability').select('official_id, game_id');
    const submittedSetByOfficial = {};
    (availRows || []).forEach(a => {
      if (!submittedSetByOfficial[a.official_id]) submittedSetByOfficial[a.official_id] = new Set();
      submittedSetByOfficial[a.official_id].add(a.game_id);
    });

    let html = '<table style="width:100%; border-collapse:collapse; font-size:11px; table-layout:fixed;">';
    html += '<tr style="background:var(--ios-bg);"><th style="padding:8px 4px; text-align:left; position:sticky; left:0; background:var(--ios-bg); white-space:nowrap; font-size:10px; text-transform:uppercase; letter-spacing:0.2px; color:var(--muted-text); width:78px;">Official</th>';
    months.forEach(m => {
      const short = new Date(m + '-01T12:00:00').toLocaleDateString('en-US', { month: 'short' });
      html += '<th style="padding:8px 2px; text-align:center; white-space:nowrap; font-size:10px; text-transform:uppercase; letter-spacing:0.2px; color:var(--muted-text);">' + short + '</th>';
    });
    html += '</tr>';

    regularOfficials.forEach((o, i) => {
      const submitted = submittedSetByOfficial[o.id] || new Set();
      const rowBg = i % 2 === 0 ? 'var(--ios-card)' : 'var(--ios-bg)';
      const shortName = o.name.length > 11 ? o.name.split(' ').map((p, idx, arr) => idx === arr.length - 1 ? p.charAt(0) + '.' : p).join(' ') : o.name;
      html += '<tr style="border-top:1px solid var(--ios-sep); background:' + rowBg + ';"><td title="' + esc(o.name) + '" style="padding:6px 4px; font-weight:700; font-size:11px; position:sticky; left:0; background:' + rowBg + '; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + esc(shortName) + '</td>';
      months.forEach(m => {
        const gameIds = gamesByMonth[m];
        const fullySubmitted = gameIds.every(gid => submitted.has(gid));
        const badge = fullySubmitted
          ? '<span style="display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; border-radius:50%; background:#15803d; color:white; font-size:10px; font-weight:900;">✓</span>'
          : '<span style="display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; border-radius:50%; background:rgba(153,27,27,0.5); color:white; font-size:10px; font-weight:900;">✗</span>';
        html += '<td style="padding:4px 1px; text-align:center;">' + badge + '</td>';
      });
      html += '</tr>';
    });
    html += '</table>';
    html += '<div style="padding:10px 12px; font-size:10px; color:var(--muted-text); border-top:1px solid var(--ios-sep); display:flex; gap:12px; flex-wrap:wrap;">'
      + '<span style="display:flex; align-items:center; gap:4px;"><span style="width:11px; height:11px; border-radius:50%; background:#15803d; display:inline-block;"></span>Submitted</span>'
      + '<span style="display:flex; align-items:center; gap:4px;"><span style="width:11px; height:11px; border-radius:50%; background:rgba(153,27,27,0.5); display:inline-block;"></span>Not submitted</span>'
      + '</div>';

    cont.innerHTML = html;
  }


  async function loadSeasonStats() {
    const cont = document.getElementById('statsLeaderboardCont');
    cont.innerHTML = '<div style="padding:20px; text-align:center; color:var(--muted-text); font-size:12px;">Loading...</div>';
    const { start, end } = getCurrentSeasonRange();

    const { data: officials } = await sb.from('officials').select('id, name').order('name');
    const { data: assignments } = await sb.from('assignments').select('official_id, games(date)');
    const { data: fixedStaff } = await sb.from('role_restrictions').select('official_id').in('position', ['PA ANNOUNCER', 'VIDEO REPLAY']);
    const fixedStaffIds = new Set((fixedStaff || []).map(r => r.official_id));

    const counts = {};
    (officials || []).forEach(o => { counts[o.id] = 0; });
    (assignments || []).forEach(a => {
      if (!a.games || !a.official_id) return;
      if (a.games.date >= start && a.games.date < end) {
        counts[a.official_id] = (counts[a.official_id] || 0) + 1;
      }
    });

    const rows = (officials || [])
      .filter(o => !fixedStaffIds.has(o.id))
      .map(o => ({ name: o.name, count: counts[o.id] || 0 }))
      .sort((a, b) => b.count - a.count);

    cont.innerHTML = rows.map((r, i) => {
      return '<div style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; border-bottom:1px solid var(--ios-sep);">'
        + '<div style="display:flex; align-items:center; gap:10px;"><span style="font-size:11px; color:var(--muted-text); width:20px;">' + (i + 1) + '</span><span style="font-size:13px; font-weight:700;">' + esc(r.name) + '</span></div>'
        + '<span style="font-size:13px; font-weight:900; color:var(--icedogs-red);">' + r.count + '</span></div>';
    }).join('');
  }


  async function loadReasonStats() {
    const cont = document.getElementById('statsReasonsCont');
    cont.innerHTML = '<div style="padding:20px; text-align:center; color:var(--muted-text); font-size:12px;">Loading...</div>';
    const { start, end } = getCurrentSeasonRange();

    const { data: rows } = await sb
      .from('availability')
      .select('reason, officials(name), games(date)')
      .eq('status', 'Not Available');

    const byOfficial = {};
    (rows || []).forEach(r => {
      if (!r.officials || !r.games || !r.reason) return;
      if (!(r.games.date >= start && r.games.date < end)) return;
      const name = r.officials.name;
      if (!byOfficial[name]) byOfficial[name] = {};
      byOfficial[name][r.reason] = (byOfficial[name][r.reason] || 0) + 1;
    });

    const names = Object.keys(byOfficial).sort();
    if (!names.length) { cont.innerHTML = '<div class="empty-state">No unavailability reasons recorded this season.</div>'; return; }

    cont.innerHTML = names.map(name => {
      const reasons = byOfficial[name];
      const reasonList = Object.entries(reasons).map(([r, c]) => esc(r) + ' (' + c + ')').join(', ');
      return '<div style="padding:10px 14px; border-bottom:1px solid var(--ios-sep);">'
        + '<div style="font-size:13px; font-weight:700;">' + esc(name) + '</div>'
        + '<div style="font-size:11px; color:var(--muted-text); margin-top:2px;">' + reasonList + '</div></div>';
    }).join('');
  }


  async function loadAdminAvailOfficials() {
    const sel = document.getElementById('adminAvailOfficial');
    if (sel.options.length > 1) return;
    const { data: officials } = await sb.from('officials').select('id, name').order('name');
    (officials || []).forEach(o => { sel.innerHTML += '<option value="' + o.id + '">' + esc(o.name) + '</option>'; });
  }


  async function adminLoadAvailMonths() {
    const officialId = document.getElementById('adminAvailOfficial').value;
    const monthSel = document.getElementById('adminAvailMonth');
    document.getElementById('adminAvailGameList').innerHTML = '';
    document.getElementById('adminAvailSaveBtn').style.display = 'none';
    if (!officialId) { monthSel.style.display = 'none'; return; }

    const { data: games } = await sb.from('games').select('date').order('date');
    const months = [...new Set((games || []).map(g => g.date.slice(0, 7)))];
    monthSel.innerHTML = '<option value="">-- Select Month --</option>';
    months.forEach(m => {
      const label = new Date(m + "-01T12:00:00").toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      monthSel.innerHTML += '<option value="' + m + '-01">' + label + '</option>';
    });
    monthSel.style.display = 'block';
  }


  let adminAvailCurrentGames = [];


  async function adminLoadAvailGames() {
    const officialId = document.getElementById('adminAvailOfficial').value;
    const month = document.getElementById('adminAvailMonth').value;
    const cont = document.getElementById('adminAvailGameList');
    const saveBtn = document.getElementById('adminAvailSaveBtn');
    if (!month) { cont.innerHTML = ''; saveBtn.style.display = 'none'; return; }

    cont.innerHTML = '<div style="padding:14px; text-align:center; color:var(--muted-text); font-size:12px;">Loading...</div>';

    const nextMonth = new Date(month + "T00:00:00");
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    const nextMonthStr = nextMonth.toISOString().slice(0, 10);

    const { data: games } = await sb.from('games').select('id, game_number, date, time, opponent_name')
      .gte('date', month).lt('date', nextMonthStr).order('date');
    const { data: existing } = await sb.from('availability').select('game_id, status, reason').eq('official_id', officialId);
    const existingMap = {};
    (existing || []).forEach(e => { existingMap[e.game_id] = e; });
    const { data: reasons } = await sb.from('reasons').select('label').order('sort_order');
    const reasonOptions = (reasons || []).map(r => r.label);

    adminAvailCurrentGames = games || [];
    if (!adminAvailCurrentGames.length) { cont.innerHTML = '<div class="empty-state">No games this month.</div>'; saveBtn.style.display = 'none'; return; }

    cont.innerHTML = adminAvailCurrentGames.map(g => {
      const saved = existingMap[g.id];
      const status = saved ? saved.status : 'Available';
      const dateLabel = new Date(g.date + "T12:00:00").toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const reasonOpts = reasonOptions.map(r => '<option value="' + esc(r) + '"' + (saved && saved.reason === r ? ' selected' : '') + '>' + esc(r) + '</option>').join('');
      return '<div class="list-item" style="flex-direction:column; align-items:stretch;" data-game-id="' + g.id + '">'
        + '<div style="display:flex; justify-content:space-between; align-items:center; width:100%;">'
        + '<div><div style="font-weight:700; font-size:13px;">vs ' + esc(g.opponent_name) + '</div><div style="font-size:11px; color:var(--muted-text);">' + dateLabel + ' @ ' + (g.time || 'TBD') + '</div></div>'
        + '<select class="admin-avail-status" style="width:140px; height:38px; margin:0;" onchange="toggleAdminReasonVisibility(this)">'
        + '<option value="Available"' + (status === 'Available' ? ' selected' : '') + '>Available</option>'
        + '<option value="Not Available"' + (status === 'Not Available' ? ' selected' : '') + '>Not Available</option>'
        + '</select></div>'
        + '<select class="admin-avail-reason" style="margin-top:8px; height:38px; display:' + (status === 'Not Available' ? 'block' : 'none') + ';"><option value="">-- Reason --</option>' + reasonOpts + '</select>'
        + '</div>';
    }).join('');

    saveBtn.style.display = 'block';
  }


  function toggleAdminReasonVisibility(sel) {
    const row = sel.closest('.list-item');
    row.querySelector('.admin-avail-reason').style.display = sel.value === 'Not Available' ? 'block' : 'none';
  }


  async function adminSubmitAvailability() {
    const officialId = document.getElementById('adminAvailOfficial').value;
    const month = document.getElementById('adminAvailMonth').value;
    const rows = document.querySelectorAll('#adminAvailGameList .list-item');
    const results = [];
    rows.forEach(row => {
      const gameDbId = row.dataset.gameId;
      const game = adminAvailCurrentGames.find(g => g.id === gameDbId);
      if (!game) return;
      const status = row.querySelector('.admin-avail-status').value;
      const reason = row.querySelector('.admin-avail-reason').value;
      results.push({ gameId: game.game_number, status, reason });
    });

    const msgEl = document.getElementById('adminAvailMsg');
    msgEl.style.display = 'block'; msgEl.style.color = 'var(--muted-text)'; msgEl.textContent = 'Saving...';
    const res = await callAdminAction('admin_save_availability', { officialId, month, results });
    if (res.success) {
      msgEl.style.color = '#166534'; msgEl.textContent = '✓ Saved!';
    } else {
      msgEl.style.color = '#C8102E'; msgEl.textContent = res.msg || 'Save failed';
    }
  }


  async function loadAdmin() {
    const { data: setting } = await sb.from('app_settings').select('value').eq('key', 'pin_required').maybeSingle();
    document.getElementById('pinToggle').checked = setting && setting.value === 'ON';

    await loadMonthToggleList();

    loadActiveBroadcasts();
    loadGamesList();
    loadOfficialsList();
    loadMatrixMonths();
    loadPositionSetupList();

    switchAdminTopTab('usage');
  }


  // Correct display casing per position — acronyms (OHL, PA, SOG/FO) don't
  // survive a simple first-letter-capitalize, so map them explicitly.
  const POSITION_LABELS = {
    'GAME CLOCK': 'Game Clock',
    'OHL GAMESHEET': 'OHL Gamesheet',
    'PENALTY BOX (1)': 'Penalty Box (1)',
    'PENALTY BOX (2)': 'Penalty Box (2)',
    'GOAL JUDGE (1)': 'Goal Judge (1)',
    'GOAL JUDGE (2)': 'Goal Judge (2)',
    'OFFICIAL SCORER': 'Official Scorer',
    'SOG/FO COMPUTER': 'SOG/FO Computer',
    'SOG/FO SHEET': 'SOG/FO Sheet',
    'ONLINE COMPUTER': 'Online Computer',
    'PLUS/MINUS': 'Plus/Minus',
    'VIDEO TECH': 'Video Tech',
    'VIDEO REPLAY': 'Video Replay',
    'PA ANNOUNCER': 'PA Announcer',
  };

  // Display order for the Position Setup grid — paired positions (Game Clock/
  // OHL Gamesheet, both Penalty Boxes, both Goal Judges, etc.) land on the
  // same row since the grid fills left-to-right in this array's order.
  const POSITION_SETUP_ORDER = [
    'GAME CLOCK', 'OHL GAMESHEET',
    'PENALTY BOX (1)', 'PENALTY BOX (2)',
    'GOAL JUDGE (1)', 'GOAL JUDGE (2)',
    'OFFICIAL SCORER', 'ONLINE COMPUTER',
    'PA ANNOUNCER', 'PLUS/MINUS',
    'SOG/FO COMPUTER', 'SOG/FO SHEET',
    'VIDEO REPLAY', 'VIDEO TECH',
  ];

  async function loadPositionSetupList() {
    const cont = document.getElementById('positionSetupList');
    if (!cont) return;
    const { data: positions } = await sb.from('position_settings').select('position, enabled');
    const sorted = (positions || []).slice().sort(
      (a, b) => POSITION_SETUP_ORDER.indexOf(a.position) - POSITION_SETUP_ORDER.indexOf(b.position)
    );
    cont.innerHTML = '<div style="display:grid; grid-template-columns:1fr 1fr; gap:2px 14px;">'
      + sorted.map(p => {
          const label = POSITION_LABELS[p.position] || p.position;
          return '<div style="display:flex; align-items:center; justify-content:space-between; padding:7px 0; border-bottom:1px solid var(--ios-sep);">'
            + '<span style="font-size:12px; font-weight:700;">' + esc(label) + '</span>'
            + '<label class="switch" style="transform:scale(0.72); transform-origin:right center;"><input type="checkbox" ' + (p.enabled ? 'checked' : '') + ' onchange="togglePositionEnabled(\'' + p.position.replace(/'/g, "\\'") + '\', this.checked)"><span class="slider"></span></label>'
            + '</div>';
        }).join('')
      + '</div>';
  }


  async function togglePositionEnabled(position, enabled) {
    showSaving('Updating...');
    const res = await callAdminAction('toggle_position', { position, enabled });
    if (res.success) {
      hideSaving('Updated!');
      _enabledPositionsCache = null; // invalidate so matrix/skills reflect the change
    } else {
      hideSavingError(res.msg || 'Failed to update');
      loadPositionSetupList();
    }
  }

  // Cache of currently-enabled position names (Set), used by the scheduling
  // matrix and skills panel so a disabled position disappears from both.
  // Crew Chief is never in position_settings and is always treated as active.
  let _enabledPositionsCache = null;

  async function getEnabledPositionSet() {
    if (_enabledPositionsCache) return _enabledPositionsCache;
    const { data: positions } = await sb.from('position_settings').select('position').eq('enabled', true);
    _enabledPositionsCache = new Set((positions || []).map(p => p.position));
    _enabledPositionsCache.add('CREW CHIEF');
    return _enabledPositionsCache;
  }


  async function loadMonthToggleList() {
    const { data: months } = await sb.from('month_windows').select('month, status').order('month');
    const monthCont = document.getElementById('monthToggleList');
    monthCont.innerHTML = (months || []).map(m => {
      const label = new Date(m.month + "T12:00:00").toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      const isActive = m.status === 'Active';
      const notifyBtn = isActive
        ? '<button onclick="confirmNotifyAvailability(\'' + m.month.slice(0, 7) + '\', \'' + label + '\')" style="background:#eef2ff; border:none; border-radius:6px; padding:5px 10px; font-size:11px; color:#3730a3; cursor:pointer; margin-right:8px;">Notify</button>'
        : '';
      return '<div style="display:flex; align-items:center; justify-content:space-between; padding:10px 0; border-bottom:1px solid var(--ios-sep);">'
        + '<span style="font-size:13px; font-weight:700;">' + label + '</span>'
        + '<div style="display:flex; align-items:center;">' + notifyBtn + '<label class="switch"><input type="checkbox" ' + (isActive ? 'checked' : '') + ' onchange="toggleMonth(\'' + m.month + '\', this.checked)"><span class="slider"></span></label></div></div>';
    }).join('');
  }


  function confirmNotifyAvailability(month, label) {
    showConfirm('Notify Officials?', 'Sends an "Availability Now Open" email for ' + label + ' to officials who haven\'t fully submitted yet (excluding PA Announcer/Video Replay staff).', async () => {
      showSaving('Sending emails...');
      const res = await callAdminAction('notify_availability_open', { month });
      if (res.success) hideSaving('Sent to ' + res.count + ' officials!');
      else hideSavingError(res.msg || 'Failed to send');
    });
  }


  async function loadMatrixMonths() {
    const { data: games } = await sb.from('games').select('date').order('date');
    const months = [...new Set((games || []).map(g => g.date.slice(0, 7)))];
    const sel = document.getElementById('matrixMonthSelect');
    sel.innerHTML = '<option value="">Select Month...</option>';
    months.forEach(m => {
      const label = new Date(m + "-01T12:00:00").toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      sel.innerHTML += '<option value="' + m + '">' + label + '</option>';
    });
  }


  async function loadMatrix() {
    const month = document.getElementById('matrixMonthSelect').value;
    const cont = document.getElementById('matrixCont');
    if (!month) { cont.innerHTML = ''; return; }
    cont.innerHTML = '<div style="padding:14px; text-align:center; color:var(--muted-text); font-size:12px;">Loading...</div>';

    const nextMonth = new Date(month + "-01T00:00:00");
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    const nextMonthStr = nextMonth.toISOString().slice(0, 10);

    const { data: games } = await sb.from('games').select('id, game_number, date, time, opponent_name, schedule_locked')
      .gte('date', month + '-01').lt('date', nextMonthStr).order('date');
    const gameList = games || [];
    if (!gameList.length) { cont.innerHTML = '<div class="empty-state">No games this month.</div>'; return; }

    const gameIds = gameList.map(g => g.id);
    const { data: assignments } = await sb.from('assignments').select('game_id, position, officials(name)').in('game_id', gameIds);
    const { data: avail } = await sb.from('availability').select('game_id, status, officials(name)').in('game_id', gameIds).eq('status', 'Available');
    const { data: restrictions } = await sb.from('role_restrictions').select('position, officials(name)');
    const { data: skills } = await sb.from('official_skills').select('position, officials(name)');
    const enabledPositions = await getEnabledPositionSet();
    const ACTIVE_POSITIONS = ALL_POSITIONS.filter(pos => enabledPositions.has(pos));

    const restrictionMap = {};
    (restrictions || []).forEach(r => {
      if (!r.officials) return;
      const pos = r.position.toUpperCase();
      if (!restrictionMap[pos]) restrictionMap[pos] = [];
      restrictionMap[pos].push(r.officials.name);
    });

    const skillMap = {};
    (skills || []).forEach(s => {
      if (!s.officials) return;
      const pos = s.position.toUpperCase();
      if (!skillMap[pos]) skillMap[pos] = new Set();
      skillMap[pos].add(s.officials.name);
    });

    const assignByGame = {};
    (assignments || []).forEach(a => {
      if (!assignByGame[a.game_id]) assignByGame[a.game_id] = {};
      assignByGame[a.game_id][a.position] = a.officials ? a.officials.name : '';
    });
    const availByGame = {};
    (avail || []).forEach(a => {
      if (!a.officials) return;
      if (!availByGame[a.game_id]) availByGame[a.game_id] = [];
      availByGame[a.game_id].push(a.officials.name);
    });

    const ALWAYS_AVAILABLE_BACKUP = ["Dave Taylor"];

    cont.innerHTML = gameList.map(g => {
      const dateLabel = new Date(g.date + "T12:00:00").toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const gameAssignments = assignByGame[g.id] || {};
      const pool = (availByGame[g.id] || []).slice().sort();

      const rows = ACTIVE_POSITIONS.map(pos => {
        const current = gameAssignments[pos] || '';
        const isFixed = FIXED_POSITIONS.includes(pos);
        let options;
        if (isFixed) {
          options = (restrictionMap[pos] || []).slice().sort();
        } else {
          const qualified = skillMap[pos] || new Set();
          options = pool.filter(n => qualified.has(n));
          ALWAYS_AVAILABLE_BACKUP.forEach(name => {
            const alreadyBusy = gameAssignments['VIDEO REPLAY'] === name;
            if (qualified.has(name) && !alreadyBusy && !options.includes(name)) options.push(name);
          });
          options.sort();
        }
        if (current && !options.includes(current)) options.push(current);
        const optHtml = '<option value="">-- Vacant --</option>' + options.map(n => '<option value="' + esc(n) + '"' + (n === current ? ' selected' : '') + '>' + esc(n) + '</option>').join('');
        return '<div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid var(--ios-sep);">'
          + '<span style="font-size:10px; font-weight:900; color:var(--muted-text); width:110px; flex-shrink:0;">' + pos + '</span>'
          + '<select data-prev="' + esc(current) + '" style="width:60%; height:34px; margin:0; font-size:12px;" onchange="updateAssignment(\'' + g.id + '\', \'' + pos.replace(/'/g, "\\'") + '\', this.value, this)">' + optHtml + '</select>'
          + '</div>';
      }).join('');

      const matrixId = 'matrix_' + g.id;
      const filledCount = ACTIVE_POSITIONS.filter(pos => gameAssignments[pos]).length;
      const totalPositions = ACTIVE_POSITIONS.length;
      const isComplete = filledCount === totalPositions;
      const badgeColor = isComplete ? '#166534' : (filledCount === 0 ? '#991b1b' : '#92400e');
      const badgeBg = isComplete ? '#dcfce7' : (filledCount === 0 ? '#fff1f2' : '#fff8ed');
      const badgeHtml = '<span id="matrixBadge_' + g.id + '" style="font-size:10px; font-weight:900; padding:3px 8px; border-radius:20px; background:' + badgeBg + '; color:' + badgeColor + '; white-space:nowrap;">' + filledCount + '/' + totalPositions + '</span>';
      const lockIcon = g.schedule_locked ? '<span style="font-size:12px;" title="Schedule locked">🔒</span>' : '';
      const lockRow = '<div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0 4px; margin-top:6px; border-top:1px solid var(--ios-sep);">'
        + '<label style="display:flex; align-items:center; gap:8px; font-size:12px; font-weight:700;"><input type="checkbox" id="lockCheck_' + g.id + '" ' + (g.schedule_locked ? 'checked' : '') + ' onchange="toggleScheduleLock(\'' + g.id + '\', this.checked)"> Lock schedule (staffing finalized)</label>'
        + '</div>';
      return '<div style="border:1px solid var(--ios-sep); border-radius:10px; margin-bottom:8px; overflow:hidden;">'
        + '<div onclick="toggleMatrixGame(\'' + matrixId + '\')" style="padding:10px 12px; background:#fafafa; cursor:pointer; display:flex; justify-content:space-between; align-items:center; gap:8px;">'
        + '<div style="flex:1; min-width:0;"><div style="font-weight:800; font-size:12px;">#' + esc(g.game_number) + ' vs ' + esc(g.opponent_name) + ' ' + lockIcon + '</div><div style="font-size:10px; color:var(--muted-text);">' + dateLabel + '</div></div>'
        + badgeHtml
        + '<span style="font-size:11px; color:var(--muted-text);">▼</span></div>'
        + '<div id="' + matrixId + '" style="display:none; padding:8px 12px;">' + rows + lockRow + '</div></div>';
    }).join('');
  }


  function toggleMatrixGame(id) {
    const el = document.getElementById(id);
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
  }


  async function updateAssignment(gameId, position, officialName, selectEl) {
    const prevVal = selectEl.dataset.prev || '';
    const res = await callAdminAction('update_assignment', { gameId, position, officialName: officialName || null });
    if (!res.success) {
      showToast(res.msg || 'Failed to update assignment');
      selectEl.value = prevVal;
      return;
    }
    selectEl.dataset.prev = officialName || '';
    const delta = (officialName ? 1 : 0) - (prevVal ? 1 : 0);
    if (delta !== 0) {
      const badge = document.getElementById('matrixBadge_' + gameId);
      if (badge) {
        const [filled, total] = badge.textContent.split('/').map(Number);
        const newFilled = filled + delta;
        badge.textContent = newFilled + '/' + total;
        const isComplete = newFilled === total;
        badge.style.background = isComplete ? '#dcfce7' : (newFilled === 0 ? '#fff1f2' : '#fff8ed');
        badge.style.color = isComplete ? '#166534' : (newFilled === 0 ? '#991b1b' : '#92400e');
      }
    }
  }


  async function toggleScheduleLock(gameId, locked) {
    const res = await callAdminAction('toggle_schedule_locked', { gameId, locked });
    if (res.success) {
      showToast(locked ? '🔒 Schedule locked' : 'Schedule unlocked');
    } else {
      showToast(res.msg || 'Failed to update');
      document.getElementById('lockCheck_' + gameId).checked = !locked;
    }
  }

  // ---- Games CRUD (modal-based) ----

  const QUICK_PICK_TIMES = ['19:00', '14:00', '16:00', '18:00'];


  function setGameTime(value) {
    document.getElementById('gfTime').value = value;
    highlightQuickPick(value);
  }


  function highlightQuickPick(value) {
    QUICK_PICK_TIMES.forEach(t => {
      const btn = document.getElementById('qpTime' + t.replace(':', ''));
      if (!btn) return;
      const active = t === value;
      btn.style.background = active ? 'var(--icedogs-red)' : 'var(--ios-card)';
      btn.style.color = active ? 'white' : 'var(--ios-text)';
      btn.style.borderColor = active ? 'var(--icedogs-red)' : 'var(--ios-sep)';
    });
  }


  function timeTo24h(str) {
    if (!str) return '';
    const match = str.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (!match) return '';
    let h = parseInt(match[1], 10);
    const m = match[2];
    const ampm = (match[3] || '').toUpperCase();
    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    return String(h).padStart(2, '0') + ':' + m;
  }


  function timeTo12h(str) {
    if (!str) return '';
    const [hStr, m] = str.split(':');
    let h = parseInt(hStr, 10);
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return h + ':' + m + ' ' + ampm;
  }


  function openGameModal(prefill) {
    document.getElementById('gameModalTitle').textContent = prefill ? 'Edit Game' : 'New Game';
    if (prefill) {
      document.getElementById('gfId').value = prefill.id;
      document.getElementById('gfNumber').value = prefill.game_number;
      document.getElementById('gfDate').value = prefill.date;
      const time24 = timeTo24h(prefill.time || '');
      document.getElementById('gfTime').value = time24;
      highlightQuickPick(time24);
      document.getElementById('gfOpponent').value = prefill.opponent_name || '';
      document.getElementById('gfType').value = prefill.type || '(R)';
      document.getElementById('gfPromo').value = prefill.promo || '';
    } else {
      ['gfId','gfNumber','gfDate','gfTime','gfOpponent','gfPromo'].forEach(id => document.getElementById(id).value = '');
      document.getElementById('gfType').value = '(R)';
      highlightQuickPick('');
    }
    document.getElementById('gameModal').classList.add('open');
  }

  function closeGameModal() { document.getElementById('gameModal').classList.remove('open'); }


  async function saveGame() {
    const id = document.getElementById('gfId').value || null;
    const gameNumber = document.getElementById('gfNumber').value.trim();
    const date = document.getElementById('gfDate').value;
    const time = timeTo12h(document.getElementById('gfTime').value);
    const opponentName = document.getElementById('gfOpponent').value.trim();
    const type = document.getElementById('gfType').value;
    const promo = document.getElementById('gfPromo').value.trim();
    if (!gameNumber || !date || !opponentName) { showToast('Game #, date, and opponent are required'); return; }
    showSaving('Saving game...');
    const res = await callAdminAction('save_game', { id, gameNumber, date, time, opponentName, type, promo });
    if (res.success) {
      hideSaving('Game saved!');
      closeGameModal();
      loadGamesList();
    } else {
      hideSavingError(res.msg || 'Failed to save game');
    }
  }


  async function loadGamesList() {
    const { data: games } = await sb.from('games').select('*').order('date');
    const cont = document.getElementById('gamesListCont');
    if (!games || !games.length) { cont.innerHTML = '<div class="empty-state">No games yet.</div>'; return; }
    window._gamesCache = games;
    cont.innerHTML = games.map(g => {
      const dateLabel = new Date(g.date + "T12:00:00").toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      return '<div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid var(--ios-sep);">'
        + '<div><div style="font-weight:700; font-size:13px;">#' + esc(g.game_number) + ' vs ' + esc(g.opponent_name) + '</div>'
        + '<div style="font-size:11px; color:var(--muted-text);">' + dateLabel + ' @ ' + (g.time || 'TBD') + '</div></div>'
        + '<div style="display:flex; gap:6px;">'
        + '<button onclick="openGameModal(window._gamesCache.find(x => x.id === \'' + g.id + '\'))" style="background:#f1f5f9; border:none; border-radius:6px; padding:6px 10px; font-size:11px; cursor:pointer;">Edit</button>'
        + '<button onclick="confirmDeleteGame(\'' + g.id + '\')" style="background:#fff1f2; border:none; border-radius:6px; padding:6px 10px; font-size:11px; color:#991b1b; cursor:pointer;">Delete</button>'
        + '</div></div>';
    }).join('');
  }


  function confirmDeleteGame(id) {
    showConfirm('Delete Game?', 'This also removes its assignments and availability records.', async () => {
      showSaving('Deleting...');
      const res = await callAdminAction('delete_game', { id });
      if (res.success) { hideSaving('Deleted!'); loadGamesList(); }
      else hideSavingError(res.msg || 'Failed to delete');
    });
  }

  // ---- Teams CRUD ----

  let _teamsAccordionOpen = false;


  function toggleTeamsAccordion() {
    _teamsAccordionOpen = !_teamsAccordionOpen;
    document.getElementById('teamsAccordionBody').style.display = _teamsAccordionOpen ? 'block' : 'none';
    document.getElementById('teamsAccordionChevron').textContent = _teamsAccordionOpen ? '▲' : '▼';
    if (_teamsAccordionOpen) loadTeamsList();
  }


  async function loadTeamsList() {
    const { data: teams } = await sb.from('teams').select('*').order('name');
    const cont = document.getElementById('teamsListCont');
    window._teamsCache = teams || [];
    if (!teams || !teams.length) { cont.innerHTML = '<div class="empty-state">No teams yet.</div>'; return; }
    cont.innerHTML = teams.map(t => {
      const logoImg = t.logo_url
        ? '<img src="' + esc(t.logo_url) + '" style="width:28px; height:28px; object-fit:contain;" onerror="this.style.display=\'none\'">'
        : '<div style="width:28px; height:28px; border-radius:50%; background:var(--ios-sep);"></div>';
      return '<div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid var(--ios-sep);">'
        + '<div style="display:flex; align-items:center; gap:10px;">' + logoImg + '<span style="font-size:13px; font-weight:700;">' + esc(t.name) + '</span></div>'
        + '<div style="display:flex; gap:6px;">'
        + '<button onclick="openTeamModal(window._teamsCache.find(x => x.id === \'' + t.id + '\'))" style="background:#f1f5f9; border:none; border-radius:6px; padding:6px 10px; font-size:11px; cursor:pointer;">Edit</button>'
        + '<button onclick="confirmDeleteTeam(\'' + t.id + '\')" style="background:#fff1f2; border:none; border-radius:6px; padding:6px 10px; font-size:11px; color:#991b1b; cursor:pointer;">Delete</button>'
        + '</div></div>';
    }).join('');
  }


  function openTeamModal(prefill) {
    document.getElementById('teamModalTitle').textContent = prefill ? 'Edit Team' : 'Add Team';
    if (prefill) {
      document.getElementById('tmId').value = prefill.id;
      document.getElementById('tmName').value = prefill.name;
      document.getElementById('tmLogoUrl').value = prefill.logo_url || '';
    } else {
      document.getElementById('tmId').value = '';
      document.getElementById('tmName').value = '';
      document.getElementById('tmLogoUrl').value = '';
    }
    document.getElementById('teamModal').classList.add('open');
  }

  function closeTeamModal() { document.getElementById('teamModal').classList.remove('open'); }


  async function saveTeam() {
    const id = document.getElementById('tmId').value || null;
    const name = document.getElementById('tmName').value.trim();
    const logoUrl = document.getElementById('tmLogoUrl').value.trim();
    if (!name) { showToast('Team name is required'); return; }
    showSaving('Saving team...');
    const res = await callAdminAction('save_team', { id, name, logoUrl });
    if (res.success) {
      hideSaving('Saved!');
      closeTeamModal();
      loadTeamsList();
    } else {
      hideSavingError(res.msg || 'Failed to save team');
    }
  }


  function confirmDeleteTeam(id) {
    showConfirm('Delete Team?', 'This does not affect existing games — their opponent name stays as text.', async () => {
      showSaving('Deleting...');
      const res = await callAdminAction('delete_team', { id });
      if (res.success) { hideSaving('Deleted!'); loadTeamsList(); }
      else hideSavingError(res.msg || 'Failed to delete');
    });
  }

  // ---- Officials CRUD (modal-based) ----

  function openOfficialModal(prefill) {
    document.getElementById('officialModalTitle').textContent = prefill ? 'Edit Official' : 'Add Official';
    document.getElementById('ofPin').value = '';
    if (prefill) {
      document.getElementById('ofId').value = prefill.id;
      document.getElementById('ofName').value = prefill.name;
      document.getElementById('ofEmail').value = prefill.email || '';
      document.getElementById('ofPhone').value = prefill.phone || '';
      document.getElementById('ofRole').value = prefill.role || 'Official';
      document.getElementById('ofPinWrap').style.display = 'block';
    } else {
      ['ofId','ofName','ofEmail','ofPhone'].forEach(id => document.getElementById(id).value = '');
      document.getElementById('ofRole').value = 'Official';
      document.getElementById('ofPinWrap').style.display = 'none';
    }
    document.getElementById('officialModal').classList.add('open');
  }

  function closeOfficialModal() { document.getElementById('officialModal').classList.remove('open'); }


  async function saveOfficial() {
    const id = document.getElementById('ofId').value || null;
    const name = document.getElementById('ofName').value.trim();
    const email = document.getElementById('ofEmail').value.trim();
    const phone = document.getElementById('ofPhone').value.trim();
    const role = document.getElementById('ofRole').value;
    const pin = document.getElementById('ofPin').value.trim();
    if (!name) { showToast('Name is required'); return; }
    if (pin && !/^\d{4,6}$/.test(pin)) { showToast('PIN must be 4-6 digits'); return; }
    showSaving('Saving official...');
    const res = await callAdminAction('save_official', { id, name, email, phone, role, pin: pin || undefined });
    if (res.success) {
      hideSaving('Saved!');
      closeOfficialModal();
      loadOfficialsList();
    } else {
      hideSavingError(res.msg || 'Failed to save official');
    }
  }


  async function loadMailingList() {
    const { data: officials } = await sb.from('officials').select('name, address, pass_pref').eq('pass_pref', 'Physical').order('name');
    const cont = document.getElementById('mailingListCont');
    const recipients = (officials || []).filter(o => o.address);
    window._mailingListCache = recipients;

    if (!recipients.length) {
      cont.innerHTML = '<div class="empty-state">No one has selected a physical pass yet.</div>';
      return;
    }

    cont.innerHTML = recipients.map(o => {
      return '<div style="padding:10px 0; border-bottom:1px solid var(--ios-sep);">'
        + '<div style="font-weight:700; font-size:13px;">' + esc(o.name) + '</div>'
        + '<div style="font-size:12px; color:var(--muted-text); margin-top:2px;">' + esc(o.address) + '</div>'
        + '</div>';
    }).join('');
  }


  async function copyMailingList() {
    const recipients = window._mailingListCache || [];
    if (!recipients.length) { showToast('No addresses to copy'); return; }
    const text = recipients.map(o => o.name + '\n' + o.address).join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      showToast('✓ Copied ' + recipients.length + ' address' + (recipients.length !== 1 ? 'es' : '') + ' to clipboard');
    } catch (e) {
      showToast('Could not copy — select and copy the list manually');
    }
  }


  async function loadOfficialsList() {
    loadMailingList();
    const { data: officials } = await sb.from('officials').select('*').order('name');
    const { data: restrictions } = await sb.from('role_restrictions').select('official_id, position, officials(id, name, email, phone, role, profile_complete)').in('position', ['PA ANNOUNCER', 'VIDEO REPLAY']);
    const cont = document.getElementById('officialsListCont');
    const fixedCont = document.getElementById('fixedStaffListCont');

    const fixedIds = new Set((restrictions || []).map(r => r.official_id));
    const fixedByOfficial = {};
    (restrictions || []).forEach(r => {
      if (!r.officials) return;
      if (!fixedByOfficial[r.official_id]) fixedByOfficial[r.official_id] = { info: r.officials, positions: [] };
      fixedByOfficial[r.official_id].positions.push(r.position);
    });
    window._fixedByOfficial = fixedByOfficial;

    const regularOfficials = (officials || []).filter(o => !fixedIds.has(o.id));
    if (!regularOfficials.length) { cont.innerHTML = '<div class="empty-state">No officials yet.</div>'; }
    window._officialsCache = officials || [];

    const { data: skills } = await sb.from('official_skills').select('official_id, position');
    const skillsByOfficial = {};
    (skills || []).forEach(s => {
      if (!skillsByOfficial[s.official_id]) skillsByOfficial[s.official_id] = new Set();
      skillsByOfficial[s.official_id].add(s.position.toUpperCase());
    });
    window._skillsByOfficial = skillsByOfficial;

    const enabledPositionsForCount = await getEnabledPositionSet();
    const activeSkillPositionCount = SKILL_POSITIONS.filter(pos => enabledPositionsForCount.has(pos)).length;

    cont.innerHTML = regularOfficials.map(o => {
      const inviteBtn = o.email
        ? '<button onclick="sendInviteFor(\'' + o.id + '\')" style="flex:1; background:rgba(59,73,223,0.12); border:1px solid rgba(59,73,223,0.3); border-radius:6px; padding:8px 6px; font-size:11px; font-weight:700; color:#5b6cff; cursor:pointer;">Invite</button>'
        : '';
      const skillCount = (skillsByOfficial[o.id] || new Set()).size;
      return '<div style="border-bottom:1px solid var(--ios-sep); padding:12px 0;">'
        + '<div style="font-weight:700; font-size:13px; margin-bottom:2px;">' + esc(o.name) + '</div>'
        + '<div style="font-size:11px; color:var(--muted-text); margin-bottom:10px;">' + esc(o.role) + (o.email ? ' · ' + esc(o.email) : '') + (o.profile_complete ? '' : ' · <span style="color:#f59e0b;">Incomplete</span>') + ' · <span id="skillCount_' + o.id + '">' + skillCount + '/' + activeSkillPositionCount + '</span> skills</div>'
        + '<div style="display:flex; gap:6px;">'
        + inviteBtn
        + '<button onclick="toggleSkillsPanel(\'' + o.id + '\')" style="flex:1; background:rgba(59,73,223,0.12); border:1px solid rgba(59,73,223,0.3); border-radius:6px; padding:8px 6px; font-size:11px; font-weight:700; color:#5b6cff; cursor:pointer;">Skills</button>'
        + '<button onclick="openOfficialModal(window._officialsCache.find(x => x.id === \'' + o.id + '\'))" style="flex:1; background:var(--ios-card); border:1px solid var(--ios-sep); border-radius:6px; padding:8px 6px; font-size:11px; font-weight:700; color:var(--ios-text); cursor:pointer;">Edit</button>'
        + '<button onclick="confirmDeleteOfficial(\'' + o.id + '\')" style="flex:1; background:#fff1f2; border:none; border-radius:6px; padding:8px 6px; font-size:11px; font-weight:700; color:#991b1b; cursor:pointer;">Delete</button>'
        + '</div>'
        + '<div id="skillsPanel_' + o.id + '" style="display:none; padding-top:12px;"></div>'
        + '</div>';
    }).join('');

    const fixedIds2 = Object.keys(fixedByOfficial);
    if (!fixedIds2.length) {
      fixedCont.innerHTML = '<div class="empty-state">No fixed staff assigned yet.</div>';
    } else {
      fixedCont.innerHTML = fixedIds2.map(id => {
        const entry = fixedByOfficial[id];
        const positionBadges = entry.positions.map(p => '<span style="font-size:10px; font-weight:900; background:rgba(59,73,223,0.15); color:#5b6cff; padding:2px 8px; border-radius:20px; margin-right:4px;">' + esc(p) + '</span>').join('');
        const skillCount = (skillsByOfficial[id] || new Set()).size;
        return '<div style="border-bottom:1px solid var(--ios-sep); padding:12px 0;">'
          + '<div style="font-weight:700; font-size:13px; margin-bottom:4px;">' + esc(entry.info.name) + '</div>'
          + '<div style="margin-bottom:4px;">' + positionBadges + '</div>'
          + '<div style="font-size:11px; color:var(--muted-text); margin-bottom:10px;">Backup skills: <span id="skillCount_' + id + '">' + skillCount + '/' + activeSkillPositionCount + '</span></div>'
          + '<div style="display:flex; gap:6px;">'
          + '<button onclick="toggleSkillsPanel(\'' + id + '\')" style="flex:1; background:rgba(59,73,223,0.12); border:1px solid rgba(59,73,223,0.3); border-radius:6px; padding:8px 6px; font-size:11px; font-weight:700; color:#5b6cff; cursor:pointer;">Skills</button>'
          + '<button onclick="openFixedStaffModal(window._fixedByOfficial[\'' + id + '\'])" style="flex:1; background:var(--ios-card); border:1px solid var(--ios-sep); border-radius:6px; padding:8px 6px; font-size:11px; font-weight:700; color:var(--ios-text); cursor:pointer;">Edit</button>'
          + '<button onclick="confirmDeleteOfficial(\'' + id + '\')" style="flex:1; background:#fff1f2; border:none; border-radius:6px; padding:8px 6px; font-size:11px; font-weight:700; color:#991b1b; cursor:pointer;">Delete</button>'
          + '</div>'
          + '<div id="skillsPanel_' + id + '" style="display:none; padding-top:12px;"></div>'
          + '</div>';
      }).join('');
    }
  }

  // ---- Fixed Staff (PA Announcer / Video Replay) modal ----

  function openFixedStaffModal(existingEntry) {
    document.getElementById('fixedStaffModalTitle').textContent = existingEntry ? 'Edit Fixed Staff' : 'Add Fixed Staff';
    document.getElementById('fsUseExisting').checked = false;
    document.getElementById('fsUseExisting').style.display = existingEntry ? 'none' : 'flex';
    document.getElementById('fsExistingSelect').style.display = 'none';
    document.getElementById('fsName').style.display = 'block';
    document.getElementById('fsEmail').style.display = 'block';
    document.getElementById('fsPhone').style.display = 'block';

    if (existingEntry) {
      document.getElementById('fsOfficialId').value = existingEntry.info.id;
      document.getElementById('fsName').value = existingEntry.info.name;
      document.getElementById('fsEmail').value = existingEntry.info.email || '';
      document.getElementById('fsPhone').value = existingEntry.info.phone || '';
      document.getElementById('fsPaAnnouncer').checked = existingEntry.positions.includes('PA ANNOUNCER');
      document.getElementById('fsVideoReplay').checked = existingEntry.positions.includes('VIDEO REPLAY');
    } else {
      document.getElementById('fsOfficialId').value = '';
      document.getElementById('fsName').value = '';
      document.getElementById('fsEmail').value = '';
      document.getElementById('fsPhone').value = '';
      document.getElementById('fsPaAnnouncer').checked = false;
      document.getElementById('fsVideoReplay').checked = false;
      populateFsExistingDropdown();
    }
    document.getElementById('fixedStaffModal').classList.add('open');
  }


  function closeFixedStaffModal() { document.getElementById('fixedStaffModal').classList.remove('open'); }


  function populateFsExistingDropdown() {
    const sel = document.getElementById('fsExistingSelect');
    sel.innerHTML = '<option value="">-- Select Official --</option>';
    (window._officialsCache || []).forEach(o => { sel.innerHTML += '<option value="' + o.id + '">' + esc(o.name) + '</option>'; });
  }


  function toggleFsSource(useExisting) {
    document.getElementById('fsExistingSelect').style.display = useExisting ? 'block' : 'none';
    document.getElementById('fsName').style.display = useExisting ? 'none' : 'block';
    document.getElementById('fsEmail').style.display = useExisting ? 'none' : 'block';
    document.getElementById('fsPhone').style.display = useExisting ? 'none' : 'block';
    document.getElementById('fsOfficialId').value = '';
  }


  function fsExistingChanged() {
    const id = document.getElementById('fsExistingSelect').value;
    document.getElementById('fsOfficialId').value = id;
  }


  async function saveFixedStaff() {
    const useExisting = document.getElementById('fsUseExisting').checked;
    let officialId = document.getElementById('fsOfficialId').value;
    const paAnnouncer = document.getElementById('fsPaAnnouncer').checked;
    const videoReplay = document.getElementById('fsVideoReplay').checked;

    if (!paAnnouncer && !videoReplay) { showToast('Select at least one position'); return; }

    showSaving('Saving...');

    if (!useExisting && !officialId) {
      const name = document.getElementById('fsName').value.trim();
      const email = document.getElementById('fsEmail').value.trim();
      const phone = document.getElementById('fsPhone').value.trim();
      if (!name) { hideSavingError('Name is required'); return; }
      const res = await callAdminAction('save_official', { id: null, name, email, phone, role: 'Official' });
      if (!res.success) { hideSavingError(res.msg || 'Failed to save official'); return; }
      const { data: created } = await sb.from('officials').select('id').eq('name', name).maybeSingle();
      officialId = created?.id;
    } else if (useExisting && !officialId) {
      hideSavingError('Select an official first');
      return;
    }

    if (!officialId) { hideSavingError('Could not determine official'); return; }

    // Reconcile role_restrictions: remove both, re-add only checked ones
    const paRes = await callAdminAction('toggle_fixed_role', { officialId, position: 'PA ANNOUNCER', assigned: paAnnouncer });
    const vrRes = await callAdminAction('toggle_fixed_role', { officialId, position: 'VIDEO REPLAY', assigned: videoReplay });

    if (paRes.success && vrRes.success) {
      hideSaving('Saved!');
      closeFixedStaffModal();
      loadOfficialsList();
    } else {
      hideSavingError(paRes.msg || vrRes.msg || 'Failed to save');
    }
  }


  async function toggleSkillsPanel(officialId) {
    const panel = document.getElementById('skillsPanel_' + officialId);
    const open = panel.style.display !== 'none';
    if (open) { panel.style.display = 'none'; return; }
    const qualified = window._skillsByOfficial[officialId] || new Set();
    const enabledPositions = await getEnabledPositionSet();
    const ACTIVE_SKILL_POSITIONS = SKILL_POSITIONS.filter(pos => enabledPositions.has(pos));
    panel.innerHTML = '<div style="font-size:12px; color:var(--muted-text); margin:8px 0 10px;">Positions this official is qualified for. Unchecked positions won\'t appear as options in the Scheduling Matrix.</div>'
      + '<div style="display:grid; grid-template-columns:1fr 1fr; gap:8px 16px;">'
      + ACTIVE_SKILL_POSITIONS.map(pos => {
          const checked = qualified.has(pos);
          return '<label style="display:flex; align-items:center; gap:8px; font-size:12px;"><input type="checkbox" ' + (checked ? 'checked' : '') + ' onchange="toggleSkill(\'' + officialId + '\', \'' + pos.replace(/'/g, "\\'") + '\', this.checked)">' + esc(POSITION_LABELS[pos] || pos) + '</label>';
        }).join('')
      + '</div>'
      + '<div style="margin-top:10px; font-size:11px; color:var(--muted-text);">PA Announcer and Video Replay are managed separately under fixed roles.</div>';
    panel.style.display = 'block';
  }


  async function toggleSkill(officialId, position, qualified) {
    const res = await callAdminAction('toggle_skill', { officialId, position, qualified });
    if (res.success) {
      if (!window._skillsByOfficial[officialId]) window._skillsByOfficial[officialId] = new Set();
      if (qualified) window._skillsByOfficial[officialId].add(position.toUpperCase());
      else window._skillsByOfficial[officialId].delete(position.toUpperCase());
      const countEl = document.getElementById('skillCount_' + officialId);
      if (countEl) {
        const enabledPositions = await getEnabledPositionSet();
        const activeCount = SKILL_POSITIONS.filter(pos => enabledPositions.has(pos)).length;
        countEl.textContent = window._skillsByOfficial[officialId].size + '/' + activeCount;
      }
      showToast('✓ Saved');
    } else {
      showToast(res.msg || 'Failed to update skill');
    }
  }


  const SEND_INVITE_URL = "https://fcehtovermlilpvwcksl.supabase.co/functions/v1/send-invite";


  async function sendInviteFor(id) {
    const official = window._officialsCache.find(x => x.id === id);
    if (!official || !official.email) { showToast('This official needs an email on file first'); return; }
    showSaving('Sending invite...');
    try {
      const res = await fetch(SEND_INVITE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
        body: JSON.stringify({ token: sessionToken, officialName: official.name, email: official.email })
      });
      const data = await res.json();
      if (data.success) hideSaving('Invite sent!');
      else hideSavingError(data.msg || 'Failed to send invite');
    } catch (e) {
      hideSavingError('Network error — try again');
    }
  }


  function confirmDeleteOfficial(id) {
    showConfirm('Delete Official?', 'This cannot be undone.', async () => {
      showSaving('Deleting...');
      const res = await callAdminAction('delete_official', { id });
      if (res.success) { hideSaving('Deleted!'); loadOfficialsList(); }
      else hideSavingError(res.msg || 'Failed to delete');
    });
  }


  async function updatePinRequirement(checked) {
    showSaving('Updating...');
    const res = await callAdminAction('toggle_pin', { value: checked ? 'ON' : 'OFF' });
    if (res.success) hideSaving('Updated!');
    else { hideSavingError(res.msg || 'Failed to update'); loadAdmin(); }
  }


  async function toggleMonth(month, checked) {
    showSaving('Updating...');
    const res = await callAdminAction('toggle_month', { month, status: checked ? 'Active' : 'Hidden' });
    if (res.success) { hideSaving('Updated!'); loadMonthToggleList(); }
    else { hideSavingError(res.msg || 'Failed to update'); loadMonthToggleList(); }
  }


  function setBroadcastType(type) {
    broadcastType = type;
    ['reminder', 'info', 'urgent'].forEach(t => {
      document.getElementById('bType' + t.charAt(0).toUpperCase() + t.slice(1)).style.opacity = t === type ? '1' : '0.45';
    });
  }


  async function sendBroadcastMsg() {
    const message = document.getElementById('broadcastText').value.trim();
    const expiresAt = document.getElementById('broadcastExpiry').value || null;
    if (!message) { showToast('Enter a message first'); return; }
    showSaving('Sending...');
    const res = await callAdminAction('send_broadcast', { message, type: broadcastType, expiresAt });
    if (res.success) {
      hideSaving('Broadcast sent!');
      document.getElementById('broadcastText').value = '';
      document.getElementById('broadcastExpiry').value = '';
      loadActiveBroadcasts();
    } else {
      hideSavingError(res.msg || 'Failed to send');
    }
  }


  async function loadActiveBroadcasts() {
    const { data: broadcasts } = await sb.from('broadcasts').select('id, message, type, sent_at').eq('active', true).order('sent_at', { ascending: false });
    const cont = document.getElementById('activeBroadcastList');
    if (!broadcasts || !broadcasts.length) {
      cont.innerHTML = '<div style="padding:14px; text-align:center; font-size:12px; color:var(--muted-text);">No active broadcasts</div>';
      return;
    }
    cont.innerHTML = broadcasts.map(b => {
      const dateLabel = new Date(b.sent_at).toLocaleDateString();
      return '<div style="display:flex; justify-content:space-between; align-items:center; padding:11px 14px; border-bottom:1px solid var(--ios-sep);">'
        + '<div style="flex:1; min-width:0;"><div style="font-size:11px; font-weight:900; color:var(--icedogs-red); text-transform:uppercase;">' + esc(b.type) + '</div>'
        + '<div style="font-size:12px; margin-top:2px;">' + esc(b.message) + '</div>'
        + '<div style="font-size:10px; color:var(--muted-text); margin-top:2px;">' + dateLabel + '</div></div>'
        + '<button onclick="confirmDeactivateBroadcast(\'' + b.id + '\')" style="background:#f1f5f9; border:none; border-radius:6px; padding:6px 10px; font-size:11px; font-weight:700; color:#475569; cursor:pointer; white-space:nowrap; margin-left:8px;">Remove</button></div>';
    }).join('');
  }


  function confirmDeactivateBroadcast(id) {
    showConfirm('Remove Broadcast?', 'Officials will no longer see this message.', async () => {
      showSaving('Removing...');
      const res = await callAdminAction('deactivate_broadcast', { id });
      if (res.success) { hideSaving('Removed!'); loadActiveBroadcasts(); }
      else hideSavingError(res.msg || 'Failed to remove');
    });
  }


  function confirmWipeGames() {
    showConfirm('Wipe Games?', 'This also removes every assignment and availability record tied to those games. A backup snapshot is saved first. This cannot be undone from the app.', async () => {
      showSaving('Wiping games...');
      const res = await callAdminAction('wipe_games', {});
      if (res.success) { hideSaving('Wiped!'); loadGamesList(); loadMatrixMonths(); document.getElementById('matrixCont').innerHTML = ''; }
      else hideSavingError(res.msg || 'Failed to wipe');
    });
  }


  function confirmWipeAssignments() {
    showConfirm('Wipe Assignments?', 'Every official will be unassigned from every game. Games and availability are untouched. A backup snapshot is saved first.', async () => {
      showSaving('Wiping assignments...');
      const res = await callAdminAction('wipe_assignments', {});
      if (res.success) { hideSaving('Wiped!'); document.getElementById('matrixCont').innerHTML = ''; }
      else hideSavingError(res.msg || 'Failed to wipe');
    });
  }


  function confirmWipeAvailability() {
    showConfirm('Wipe Availability?', 'Every official\'s submitted availability will be cleared. Games and assignments are untouched. A backup snapshot is saved first.', async () => {
      showSaving('Wiping availability...');
      const res = await callAdminAction('wipe_availability', {});
      if (res.success) hideSaving('Wiped!');
      else hideSavingError(res.msg || 'Failed to wipe');
    });
  }

  // ---- Shared UI helpers: toast, saving overlay, confirm dialog ----
