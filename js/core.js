// js/core.js — Supabase config, session state, login flow, profile-completion modal,
// shared utilities (esc, toast, saving overlay, confirm dialog, callAdminAction),
// dark mode, sign out, invite-token check. Loaded first — other files depend on its globals.

  const SUPABASE_URL = "https://fcehtovermlilpvwcksl.supabase.co";

  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZjZWh0b3Zlcm1saWxwdndja3NsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4NTQzMDQsImV4cCI6MjEwMTQzMDMwNH0.Gllg9p2j3Bxrv1bpyNFBQMQtYQfWXDcxF9H7njyBksU";

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);


  const LOGIN_FUNCTION_URL = "https://fcehtovermlilpvwcksl.supabase.co/functions/v1/login";

  const COMPLETE_PROFILE_URL = "https://fcehtovermlilpvwcksl.supabase.co/functions/v1/complete-profile";

  let pinRequired = false;

  let sessionToken = null;

  let sessionOfficial = null;


  function showLoginError(msg) {
    const el = document.getElementById('loginError');
    el.textContent = msg;
    el.style.display = 'block';
  }

  function clearLoginError() {
    document.getElementById('loginError').style.display = 'none';
  }


  let pendingUser = null;


  async function handleUserSelect() {
    clearLoginError();
    const user = document.getElementById("userPicker").value;
    document.getElementById("pinArea").style.display = "none";
    if (!user) return;

    const { data: official } = await sb.from('officials').select('email, phone, address, pass_pref, profile_complete').eq('name', user).maybeSingle();
    const isComplete = official && official.profile_complete && official.email && official.phone && official.address && official.pass_pref;

    if (!isComplete) {
      pendingUser = user;
      document.getElementById('mpEmail').value = (official && official.email) || '';
      document.getElementById('mpPhone').value = (official && official.phone) ? formatPhoneDisplay(official.phone) : '';
      document.getElementById('mpAddress').value = (official && official.address) || '';
      document.getElementById('mpPass').value = (official && official.pass_pref) || '';
      document.getElementById('profileFormStep').style.display = 'block';
      document.getElementById('profileConfirmStep').style.display = 'none';
      document.getElementById('profileFormError').style.display = 'none';
      document.getElementById('profileModal').classList.add('open');
      return;
    }

    proceedAfterProfile(user);
  }


  async function proceedAfterProfile(user) {
    const { data } = await sb.from('app_settings').select('value').eq('key', 'pin_required').maybeSingle();
    pinRequired = data && data.value === 'ON';
    if (pinRequired) {
      document.getElementById("pinArea").style.display = "block";
    } else {
      performLogin(user, null);
    }
  }


  function formatPhoneDisplay(val) {
    const digits = val.toString().replace(/\D/g, '').substring(0, 10);
    let fmt = '';
    if (digits.length > 0) fmt = '(' + digits.substring(0, 3);
    if (digits.length >= 4) fmt += ') ' + digits.substring(3, 6);
    if (digits.length >= 7) fmt += '-' + digits.substring(6, 10);
    return fmt;
  }


  function formatModalPhone(input) {
    let digits = input.value.replace(/\D/g, '').substring(0, 10);
    let fmt = '';
    if (digits.length > 0) fmt = '(' + digits.substring(0, 3);
    if (digits.length >= 4) fmt += ') ' + digits.substring(3, 6);
    if (digits.length >= 7) fmt += '-' + digits.substring(6, 10);
    input.value = fmt;
  }


  const CA_POSTAL_REGEX = /([A-Za-z]\d[A-Za-z])\s?(\d[A-Za-z]\d)\s*$/;


  function toTitleCase(str) {
    return str.toLowerCase().replace(/(^|\s|-)([a-z])/g, (m, sep, ch) => sep + ch.toUpperCase());
  }


  function cleanAddress(raw) {
    let address = raw.trim().replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ');
    const match = address.match(CA_POSTAL_REGEX);
    let postal = '';
    if (match) {
      postal = (match[1] + ' ' + match[2]).toUpperCase();
      address = address.slice(0, match.index).trim().replace(/,\s*$/, '');
    }
    const parts = address.split(',').map(p => {
      const trimmed = p.trim();
      // Keep 2-letter province codes uppercase (ON, BC, etc.) rather than title-casing them
      if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
      return toTitleCase(trimmed);
    });
    address = parts.join(', ');
    return postal ? address + ', ' + postal : address;
  }


  function formatModalAddress(input) {
    const match = input.value.match(CA_POSTAL_REGEX);
    if (match) {
      const formatted = (match[1] + ' ' + match[2]).toUpperCase();
      input.value = input.value.slice(0, match.index) + formatted;
    }
  }


  function validateAddress(address) {
    return CA_POSTAL_REGEX.test(address);
  }


  function validateProfileModal() {
    const email = document.getElementById('mpEmail').value.trim();
    const phone = document.getElementById('mpPhone').value.replace(/\D/g, '');
    let address = document.getElementById('mpAddress').value.trim();
    const pass = document.getElementById('mpPass').value;
    const errEl = document.getElementById('profileFormError');
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!email || !emailRegex.test(email)) { errEl.textContent = 'Please enter a valid email address.'; errEl.style.display = 'block'; return; }
    if (phone.length !== 10) { errEl.textContent = 'Please enter a valid 10-digit phone number.'; errEl.style.display = 'block'; return; }
    if (!address) { errEl.textContent = 'Please enter your mailing address.'; errEl.style.display = 'block'; return; }
    if (!validateAddress(address)) { errEl.textContent = 'Please include a valid postal code, e.g. 123 Main St, City, ON A1A 1A1'; errEl.style.display = 'block'; return; }
    address = cleanAddress(address);
    document.getElementById('mpAddress').value = address;
    if (!pass) { errEl.textContent = 'Please select a pass preference.'; errEl.style.display = 'block'; return; }
    errEl.style.display = 'none';

    document.getElementById('confEmail').textContent = email;
    document.getElementById('confPhone').textContent = document.getElementById('mpPhone').value;
    document.getElementById('confAddress').textContent = address;
    document.getElementById('confPass').textContent = pass;
    document.getElementById('profileFormStep').style.display = 'none';
    document.getElementById('profileConfirmStep').style.display = 'block';
  }


  function backToProfileForm() {
    document.getElementById('profileConfirmStep').style.display = 'none';
    document.getElementById('profileFormStep').style.display = 'block';
  }


  async function submitProfileModal() {
    const email = document.getElementById('mpEmail').value.trim();
    const phone = document.getElementById('mpPhone').value.trim();
    const address = document.getElementById('mpAddress').value.trim();
    const passPref = document.getElementById('mpPass').value;

    showSaving('Saving your profile...');
    try {
      const res = await fetch(COMPLETE_PROFILE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
        body: JSON.stringify({ name: pendingUser, email, phone, address, passPref, inviteToken: pendingInviteToken })
      });
      const data = await res.json();
      if (data.success) {
        hideSaving('Profile saved!');
        document.getElementById('profileModal').classList.remove('open');
        proceedAfterProfile(pendingUser);
      } else {
        hideSavingError(data.msg || 'Save failed — try again');
      }
    } catch (e) {
      hideSavingError('Network error — try again');
    }
  }


  function attemptLogin() {
    const user = document.getElementById("userPicker").value;
    const pin = document.getElementById("userPin").value;
    performLogin(user, pin);
  }


  async function performLogin(name, pin) {
    clearLoginError();
    try {
      const res = await fetch(LOGIN_FUNCTION_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + SUPABASE_ANON_KEY
        },
        body: JSON.stringify({ name, pin })
      });
      const data = await res.json();
      if (!data.success) {
        showLoginError(data.msg || "Login failed");
        return;
      }
      sessionToken = data.token;
      sessionOfficial = data.official;
      loginSuccess();
    } catch (e) {
      showLoginError("Network error — try again");
    }
  }


  const EDITOR_POSITIONS_CLIENT = { "VIDEO REPLAY": ["Dave Taylor"] };

  let sessionEditorPosition = null;


  function loginSuccess() {
    document.getElementById("loginSection").style.display = "none";
    document.getElementById("appSection").style.display = "block";
    document.getElementById("userStatusBar").style.display = "block";
    document.getElementById("bottomNav").style.display = "flex";
    document.getElementById("barUserName").textContent = sessionOfficial.name;
    document.getElementById("appUserName").textContent = sessionOfficial.name;
    document.getElementById("appUserRole").textContent = sessionOfficial.role;
    if (sessionOfficial.role === 'Admin') {
      document.getElementById('navBtnAdmin').style.display = 'flex';
    }
    sessionEditorPosition = Object.keys(EDITOR_POSITIONS_CLIENT).find(pos => EDITOR_POSITIONS_CLIENT[pos].includes(sessionOfficial.name)) || null;
    if (sessionEditorPosition) {
      document.getElementById('navBtnEditor').style.display = 'flex';
      document.getElementById('editorPositionLabel').textContent = sessionEditorPosition + ' SCHEDULING';
    }
    switchAppTab('avail');
    loadAvailMonths();
  }


  function switchAppTab(tab) {
    document.getElementById('appTabAvail').style.display = tab === 'avail' ? 'block' : 'none';
    document.getElementById('appTabMyGames').style.display = tab === 'myGames' ? 'block' : 'none';
    document.getElementById('appTabCrew').style.display = tab === 'crew' ? 'block' : 'none';
    document.getElementById('appTabSeason').style.display = tab === 'season' ? 'block' : 'none';
    document.getElementById('appTabProfile').style.display = tab === 'profile' ? 'block' : 'none';
    document.getElementById('appTabAdmin').style.display = tab === 'admin' ? 'block' : 'none';
    document.getElementById('appTabEditor').style.display = tab === 'editor' ? 'block' : 'none';
    ['Avail', 'MyGames', 'Crew', 'Season', 'Admin', 'Editor'].forEach(t => {
      const btn = document.getElementById('navBtn' + t);
      if (!btn) return;
      const key = t.charAt(0).toLowerCase() + t.slice(1);
      const active = key === tab;
      btn.classList.toggle('active', active);
      const svg = btn.querySelector('svg');
      if (svg) {
        svg.querySelectorAll('[stroke]').forEach(el => {
          if (el.getAttribute('stroke') !== 'none') el.setAttribute('stroke', active ? 'white' : '#888');
        });
      }
    });
    if (tab === 'myGames') loadMyGames();
    if (tab === 'crew') loadCrew();
    if (tab === 'season') loadSeason();
    if (tab === 'editor') loadEditorMonths();
    if (tab === 'profile') loadProfile();
    if (tab === 'admin') loadAdmin();
  }


  const ADMIN_ACTION_URL = "https://fcehtovermlilpvwcksl.supabase.co/functions/v1/admin-action";

  async function callAdminAction(action, payload) {
    const res = await fetch(ADMIN_ACTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
      body: JSON.stringify({ token: sessionToken, action, payload })
    });
    return res.json();
  }


  const ALL_POSITIONS = ["CREW CHIEF", "GAME CLOCK", "OHL GAMESHEET", "PENALTY BOX (1)", "PENALTY BOX (2)",
    "GOAL JUDGE (1)", "GOAL JUDGE (2)", "OFFICIAL SCORER", "SOG/FO COMPUTER", "SOG/FO SHEET",
    "ONLINE COMPUTER", "PLUS/MINUS", "VIDEO TECH", "VIDEO REPLAY", "PA ANNOUNCER"];

  const FIXED_POSITIONS = ["PA ANNOUNCER", "VIDEO REPLAY"];

  const SKILL_POSITIONS = ALL_POSITIONS.filter(p => !FIXED_POSITIONS.includes(p));


  let toastTimer = null;

  function showToast(m) {
    if (toastTimer) clearTimeout(toastTimer);
    document.getElementById('toastMsg').innerText = m;
    document.getElementById('iosToast').classList.add('show');
    toastTimer = setTimeout(() => document.getElementById('iosToast').classList.remove('show'), 3000);
  }


  let savingTimer = null;

  function showSaving(msg) {
    if (savingTimer) clearTimeout(savingTimer);
    document.getElementById('savingRing').style.display = 'block';
    document.getElementById('savingCheck').style.display = 'none';
    document.getElementById('savingText').textContent = msg || 'Saving...';
    document.getElementById('savingOverlay').classList.add('visible');
  }

  function hideSaving(successMsg) {
    document.getElementById('savingRing').style.display = 'none';
    document.getElementById('savingCheck').style.display = 'block';
    document.getElementById('savingText').textContent = successMsg || 'Saved!';
    savingTimer = setTimeout(() => document.getElementById('savingOverlay').classList.remove('visible'), 1400);
  }

  function hideSavingError(errMsg) {
    document.getElementById('savingRing').style.display = 'none';
    document.getElementById('savingText').textContent = errMsg || 'Error';
    savingTimer = setTimeout(() => document.getElementById('savingOverlay').classList.remove('visible'), 2200);
  }


  let _confirmCallback = null;

  function showConfirm(title, msg, onConfirm, okLabel, showCancel) {
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmMsg').textContent = msg;
    const okBtn = document.getElementById('confirmOkBtn');
    const cancelBtn = document.getElementById('confirmCancelBtn');
    okBtn.textContent = okLabel || 'Delete';
    // Non-destructive labels (e.g. "Got It") get the neutral dark styling
    // instead of the red danger button, since nothing is being deleted.
    okBtn.style.background = (okLabel && okLabel !== 'Delete') ? '#333' : '';
    cancelBtn.style.display = showCancel === false ? 'none' : '';
    _confirmCallback = onConfirm;
    document.getElementById('confirmModal').classList.add('open');
  }

  function closeConfirm() {
    document.getElementById('confirmModal').classList.remove('open');
    _confirmCallback = null;
  }

  document.addEventListener('DOMContentLoaded', function() {
    document.getElementById('confirmOkBtn').addEventListener('click', function() {
      const cb = _confirmCallback;
      closeConfirm();
      if (cb) cb();
    });
  });


  function toggleDarkMode(on) {
    document.body.classList.toggle('dark-mode', on);
    try { document.cookie = 'darkMode=' + (on ? '1' : '0') + '; path=/; max-age=31536000'; } catch (e) {}
  }


  function initDarkMode() {
    const match = document.cookie.match(/darkMode=1/);
    if (match) document.body.classList.add('dark-mode');
  }


  function signOut() {
    sessionToken = null;
    sessionOfficial = null;
    sessionEditorPosition = null;
    document.getElementById("loginSection").style.display = "block";
    document.getElementById("appSection").style.display = "none";
    document.getElementById("userStatusBar").style.display = "none";
    document.getElementById("bottomNav").style.display = "none";
    document.getElementById("navBtnAdmin").style.display = "none";
    document.getElementById("navBtnEditor").style.display = "none";
    document.getElementById("userPicker").value = "";
    document.getElementById("pinArea").style.display = "none";
    document.getElementById("userPin").value = "";
  }


  async function loadPinRequired() {
    const { data } = await sb.from('app_settings').select('value').eq('key', 'pin_required').maybeSingle();
    pinRequired = data && data.value === 'ON';
  }


  function skeletonRows(count) {
    return Array.from({ length: count || 3 }).map(() => '<div class="skeleton-row"></div>').join('');
  }


  function esc(str) {
    return (str || '').toString()
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }


  function getLogoForTeam(teamName, logoMap) {
    if (!teamName || !logoMap) return "";
    const parts = teamName.toString().trim().split(' ');
    return logoMap[parts.slice(0,3).join(' ').toLowerCase()]
        || logoMap[parts.slice(0,2).join(' ').toLowerCase()]
        || logoMap[parts[0].toLowerCase()]
        || logoMap[parts[parts.length - 1].toLowerCase()]
        || logoMap[teamName.toString().trim().toLowerCase()]
        || "";
  }


  function fmtDateLabel(dateStr) {
    const d = new Date(dateStr + "T12:00:00");
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }


  const CHECK_INVITE_URL = "https://fcehtovermlilpvwcksl.supabase.co/functions/v1/check-invite";


  let pendingInviteToken = null;


  async function checkForInviteLink() {
    const params = new URLSearchParams(window.location.search);
    const invite = params.get('invite');
    if (!invite) return;

    let data;
    try {
      const res = await fetch(CHECK_INVITE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
        body: JSON.stringify({ token: invite })
      });
      data = await res.json();
    } catch (e) {
      showToast('Network error checking invite link.');
      return;
    }

    if (!data.success) {
      showToast(data.msg || 'This invite link is invalid.');
      return;
    }

    pendingInviteToken = invite;
    pendingUser = data.officialName;

    document.getElementById('mpEmail').value = data.email || '';
    document.getElementById('mpPhone').value = data.phone ? formatPhoneDisplay(data.phone) : '';
    document.getElementById('mpAddress').value = data.address || '';
    document.getElementById('mpPass').value = data.passPref || '';
    document.getElementById('profileFormStep').style.display = 'block';
    document.getElementById('profileConfirmStep').style.display = 'none';
    document.getElementById('profileFormError').style.display = 'none';
    document.getElementById('profileModal').classList.add('open');
  }


  window.onload = function() {
    initDarkMode();
    loadPinRequired();
    checkForInviteLink();
    loadLoginPageDataFromSupabase()
      .then(function(d) {
        renderPublicDashboard(d.dashboard);
        var p = document.getElementById("userPicker");
        (d.officials || []).forEach(function(name) { p.innerHTML += '<option value="' + name + '">' + name + '</option>'; });
        renderLoginBroadcastNotice(d.broadcasts || []);
      })
      .catch(function(e) {
        var cont = document.getElementById("publicGamesList");
        if (cont) cont.innerHTML = '<div style="padding:14px; font-size:12px; color:#C8102E; font-weight:700;">Error loading games: ' + (e.message || e) + '</div>';
      });
  };
