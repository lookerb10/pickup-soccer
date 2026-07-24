(function(){
  const AVAILABILITY_LABELS = {
    'wd-morning':'Weekday AM','wd-afternoon':'Weekday PM','wd-evening':'Weekday eve',
    'we-morning':'Weekend AM','we-afternoon':'Weekend PM','we-evening':'Weekend eve'
  };

  const POLL_TIME_RANGES = [
    {key:'8-10', startHour:8, endHour:10, label:'8 – 10am'},
    {key:'10-12', startHour:10, endHour:12, label:'10am – 12pm'},
    {key:'12-14', startHour:12, endHour:14, label:'12 – 2pm'},
    {key:'14-16', startHour:14, endHour:16, label:'2 – 4pm'},
    {key:'16-18', startHour:16, endHour:18, label:'4 – 6pm'},
    {key:'18-20', startHour:18, endHour:20, label:'6 – 8pm'},
  ];

  function toISODate(d){
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const day = String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${day}`;
  }
  function formatDateLabel(dateStr){
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString(undefined, {weekday:'long', month:'short', day:'numeric'});
  }
  function matchSlots(matchDate){
    return POLL_TIME_RANGES.map(t=>({
      key: t.key,
      label: t.label,
      closesAt: new Date(`${matchDate}T${String(t.endHour).padStart(2,'0')}:00:00`)
    }));
  }
  function isMatchClosed(matchDate){
    const now = new Date();
    return matchSlots(matchDate).every(s=> s.closesAt < now);
  }

  let roster = null; // cached array
  let organizerUnlocked = false;

  // ---------- Supabase config ----------
  const SUPABASE_URL = 'https://qcxwuajdclgxfbvvtbsg.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFjeHd1YWpkY2xneGZidnZ0YnNnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM3MTE3NTMsImV4cCI6MjA5OTI4Nzc1M30.a3fOQEnPsGkrNPBEohjSBTNAal2bvPQhypAlYlU9yVk';

  // ---------- EmailJS config ----------
  // To enable emailing updates to the roster:
  //   1. Create a free account at https://www.emailjs.com
  //   2. Add an Email Service (Gmail, Outlook, etc.) — copy its Service ID below
  //   3. Create an Email Template with variables {{to_name}}, {{subject}}, {{message}}
  //      set the template's "To Email" field to {{to_email}} and "Reply To" to {{reply_to}}
  //   4. Copy your Public Key from Account > General and paste all three below
  const EMAILJS_PUBLIC_KEY = 'q36etxSyX3W9Jprf6';
  const EMAILJS_SERVICE_ID = 'service_783tbol';
  const EMAILJS_TEMPLATE_ID = 'template_p8auu7g';
  const emailEnabled = ()=> typeof emailjs !== 'undefined' && EMAILJS_PUBLIC_KEY !== 'YOUR_PUBLIC_KEY';
  if(emailEnabled()) emailjs.init({ publicKey: EMAILJS_PUBLIC_KEY });

  function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

  async function sendUpdateEmails(subject, body, recipients, onProgress, replyTo){
    let sent = 0, failed = 0;
    for(let i=0; i<recipients.length; i++){
      const p = recipients[i];
      try{
        await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
          to_email: p.email, to_name: p.name, subject: subject || 'Update', message: body, reply_to: replyTo || ''
        });
        sent++;
      }catch(e){
        failed++;
      }
      if(onProgress) onProgress(i+1, recipients.length);
      await sleep(300);
    }
    return { sent, failed };
  }

  async function sb(path, options={}){
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...options,
      headers:{
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type':'application/json',
        ...(options.headers||{})
      }
    });
    if(!res.ok){
      const body = await res.text().catch(()=> '');
      throw new Error(`Supabase ${res.status}: ${body}`);
    }
    return res;
  }

  function rowToEntry(row){
    return {
      id: row.id,
      jerseyNumber: row.jersey_number,
      name: row.name,
      phone: row.phone,
      email: row.email,
      frequency: row.frequency,
      experience: row.experience,
      intensity: row.intensity,
      position: row.position,
      age: row.age,
      notes: row.notes,
      availability: row.availability || [],
      visibility: row.visibility,
      submittedAt: row.submitted_at
    };
  }

  // ---------- storage helpers (Supabase-backed) ----------
  async function getRoster(){
    try{
      const res = await sb('entries?select=*&order=jersey_number.asc');
      const rows = await res.json();
      return rows.map(rowToEntry);
    }catch(e){
      return [];
    }
  }
  async function insertEntry(entry){
    const res = await sb('entries', {
      method:'POST',
      headers:{ 'Prefer':'return=representation' },
      body: JSON.stringify({
        name: entry.name, phone: entry.phone, email: entry.email,
        frequency: entry.frequency, experience: entry.experience, intensity: entry.intensity,
        position: entry.position, age: entry.age, notes: entry.notes,
        availability: entry.availability, visibility: entry.visibility
      })
    });
    const rows = await res.json();
    return rowToEntry(rows[0]);
  }
  async function deleteEntry(id){
    return sb(`entries?id=eq.${id}`, { method:'DELETE' });
  }
  async function getPin(){
    try{
      const res = await sb('settings?key=eq.organizer_pin&select=value');
      const rows = await res.json();
      return rows.length ? rows[0].value : null;
    }catch(e){
      return null;
    }
  }
  async function setPin(val){
    return sb('settings', {
      method:'POST',
      headers:{ 'Prefer':'resolution=merge-duplicates' },
      body: JSON.stringify({ key:'organizer_pin', value: val })
    });
  }
  async function getMatches(){
    try{
      const res = await sb('matches?select=*&order=match_date.asc');
      return await res.json();
    }catch(e){
      return [];
    }
  }
  async function insertMatch(creatorName, matchDate, note){
    const res = await sb('matches', {
      method:'POST',
      headers:{ 'Prefer':'return=representation' },
      body: JSON.stringify({ creator_name: creatorName, match_date: matchDate, note: note || null })
    });
    const rows = await res.json();
    return rows[0];
  }
  async function deleteMatch(id){
    await sb(`poll_votes?match_id=eq.${id}`, { method:'DELETE' });
    return sb(`matches?id=eq.${id}`, { method:'DELETE' });
  }
  async function getMessages(){
    try{
      const res = await sb('messages?select=*&order=created_at.desc');
      return await res.json();
    }catch(e){
      return [];
    }
  }
  async function insertMessage(author, message){
    const res = await sb('messages', {
      method:'POST',
      headers:{ 'Prefer':'return=representation' },
      body: JSON.stringify({ author, message })
    });
    const rows = await res.json();
    return rows[0];
  }
  async function deleteMessage(id){
    return sb(`messages?id=eq.${id}`, { method:'DELETE' });
  }
  function formatMsgTime(iso){
    return new Date(iso).toLocaleString([], {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'});
  }
  async function getSuggestions(){
    try{
      const res = await sb('suggestions?select=*&order=created_at.desc');
      return await res.json();
    }catch(e){
      return [];
    }
  }
  async function insertSuggestion(author, category, text){
    const res = await sb('suggestions', {
      method:'POST',
      headers:{ 'Prefer':'return=representation' },
      body: JSON.stringify({ author: author || null, category, suggestion: text })
    });
    const rows = await res.json();
    return rows[0];
  }
  async function deleteSuggestion(id){
    return sb(`suggestions?id=eq.${id}`, { method:'DELETE' });
  }
  async function getComments(){
    try{
      const res = await sb('comments?select=*&order=created_at.asc');
      return await res.json();
    }catch(e){
      return [];
    }
  }
  async function insertComment(suggestionId, author, comment){
    const res = await sb('comments', {
      method:'POST',
      headers:{ 'Prefer':'return=representation' },
      body: JSON.stringify({ suggestion_id: suggestionId, author: author || null, comment })
    });
    const rows = await res.json();
    return rows[0];
  }
  async function deleteComment(id){
    return sb(`comments?id=eq.${id}`, { method:'DELETE' });
  }
  async function getAllVotes(){
    try{
      const res = await sb('poll_votes?select=*&order=created_at.desc');
      return await res.json();
    }catch(e){
      return [];
    }
  }
  async function getVotesForMatch(matchId){
    try{
      const res = await sb(`poll_votes?match_id=eq.${matchId}&select=*`);
      return await res.json();
    }catch(e){
      return [];
    }
  }
  async function replaceMatchVotes(matchId, name, slots, location){
    await sb(`poll_votes?match_id=eq.${matchId}&name=ilike.${encodeURIComponent(name)}`, { method:'DELETE' });
    if(slots.length){
      await sb('poll_votes', {
        method:'POST',
        headers:{ 'Prefer':'return=representation' },
        body: JSON.stringify(slots.map(slot=>({ match_id: matchId, name, slot, location: location || null })))
      });
    }
  }
  function groupCommentsBySuggestion(comments){
    const map = {};
    comments.forEach(c=>{
      if(!map[c.suggestion_id]) map[c.suggestion_id] = [];
      map[c.suggestion_id].push(c);
    });
    return map;
  }

  // ---------- tabs ----------
  const tabBtns = document.querySelectorAll('.tab-btn');
  const panels = {
    join: document.getElementById('tab-join'),
    roster: document.getElementById('tab-roster'),
    vote: document.getElementById('tab-vote'),
    board: document.getElementById('tab-board'),
    ideas: document.getElementById('tab-ideas'),
    organizer: document.getElementById('tab-organizer'),
  };
  function activateTab(tab){
    if(!panels[tab]) return;
    tabBtns.forEach(b=>b.classList.toggle('active', b.dataset.tab===tab));
    Object.keys(panels).forEach(k=>panels[k].style.display='none');
    panels[tab].style.display='block';
    if(location.hash !== '#'+tab) history.replaceState(null, '', '#'+tab);
    if(tab==='roster') renderRosterTab();
    if(tab==='vote'){ renderVoteTab(); markSeen('lastSeenVote'); document.getElementById('voteRibbon').style.display='none'; }
    if(tab==='board'){ renderBoardTab(); markSeen('lastSeenBoard'); document.getElementById('boardRibbon').style.display='none'; }
    if(tab==='ideas'){ renderIdeasTab(); markSeen('lastSeenIdeas'); document.getElementById('ideasRibbon').style.display='none'; }
    if(tab==='organizer') renderOrganizerTab();
  }
  tabBtns.forEach(btn=>{
    btn.addEventListener('click', ()=> activateTab(btn.dataset.tab));
  });

  // deep-link support: e.g. a link ending in #vote opens straight to that tab
  const initialTab = location.hash.replace('#','');
  if(initialTab && initialTab !== 'join' && panels[initialTab]){
    activateTab(initialTab);
  }

  // ---------- checkbox / radio visual state ----------
  document.querySelectorAll('#f-availability .check-item').forEach(item=>{
    const input = item.querySelector('input');
    input.addEventListener('change', ()=>{
      item.classList.toggle('checked', input.checked);
    });
  });
  document.querySelectorAll('#f-visibility .radio-card').forEach(card=>{
    card.addEventListener('click', ()=>{
      document.querySelectorAll('#f-visibility .radio-card').forEach(c=>c.classList.remove('selected'));
      card.classList.add('selected');
      card.querySelector('input').checked = true;
    });
  });

  // ---------- scoreboard stat ----------
  async function updateScoreStat(){
    const arr = await getRoster();
    roster = arr;
    const pub = arr.filter(p=>p.visibility==='public').length;
    const priv = arr.length - pub;
    const el = document.getElementById('scoreStat');
    el.textContent = arr.length===0
      ? 'No one signed up yet — be the first!'
      : `${arr.length} PLAYER${arr.length===1?'':'S'} SIGNED UP · ${pub} PUBLIC${priv?` · ${priv} PRIVATE`:''}`;
  }
  updateScoreStat();

  // ---------- new-content ribbons ----------
  function getLastSeen(key){
    return localStorage.getItem(key);
  }
  function markSeen(key){
    localStorage.setItem(key, new Date().toISOString());
  }
  async function updateRibbons(){
    try{
      const [msgs, ideas, votes, matches] = await Promise.all([getMessages(), getSuggestions(), getAllVotes(), getMatches()]);
      const latestMsg = msgs[0];
      const latestIdea = ideas[0];
      const latestActivity = [...votes, ...matches].sort((a,b)=> new Date(b.created_at)-new Date(a.created_at))[0];
      const boardSeen = getLastSeen('lastSeenBoard');
      const ideasSeen = getLastSeen('lastSeenIdeas');
      const voteSeen = getLastSeen('lastSeenVote');
      document.getElementById('boardRibbon').style.display =
        (latestMsg && (!boardSeen || new Date(latestMsg.created_at) > new Date(boardSeen))) ? 'inline-block' : 'none';
      document.getElementById('ideasRibbon').style.display =
        (latestIdea && (!ideasSeen || new Date(latestIdea.created_at) > new Date(ideasSeen))) ? 'inline-block' : 'none';
      document.getElementById('voteRibbon').style.display =
        (latestActivity && (!voteSeen || new Date(latestActivity.created_at) > new Date(voteSeen))) ? 'inline-block' : 'none';
    }catch(e){
      // leave ribbons as-is
    }
  }
  updateRibbons();

  // ---------- submit ----------
  document.getElementById('submitBtn').addEventListener('click', async ()=>{
    const msgEl = document.getElementById('joinMsg');
    msgEl.innerHTML = '';

    const name = document.getElementById('f-name').value.trim();
    const phone = document.getElementById('f-phone').value.trim();
    const email = document.getElementById('f-email').value.trim();
    const frequency = document.getElementById('f-frequency').value;
    const experience = document.getElementById('f-experience').value;
    const intensity = document.getElementById('f-intensity').value;
    const position = document.getElementById('f-position').value;
    const age = document.getElementById('f-age').value;
    const notes = document.getElementById('f-notes').value.trim();
    const visibility = document.querySelector('#f-visibility input:checked').value;
    const availability = Array.from(document.querySelectorAll('#f-availability input:checked'))
      .map(i=>i.closest('.check-item').dataset.slot);

    if(!name || !frequency || !experience || !intensity || (!phone && !email)){
      msgEl.innerHTML = '<div class="msg msg-error">Please fill in your name, at least one contact method, frequency, experience, and intensity.</div>';
      return;
    }

    const currentRoster = await getRoster();
    if(currentRoster.some(p=>p.name.trim().toLowerCase() === name.toLowerCase())){
      msgEl.innerHTML = `<div class="msg msg-error">Someone's already on the roster as "${escapeHtml(name)}". Please use a more specific name (e.g. add a last initial) so we can tell you apart.</div>`;
      return;
    }

    const btn = document.getElementById('submitBtn');
    btn.disabled = true;
    btn.textContent = 'Adding you…';

    try{
      const entry = await insertEntry({
        name, phone, email, frequency, experience, intensity, position, age, notes,
        availability, visibility
      });

      roster = [...(roster||[]), entry];
      await updateScoreStat();

      // success panel
      document.getElementById('joinFormCard').innerHTML = `
        <div class="success-panel">
          <div class="jersey-big">#${roster.length}</div>
          <div class="display" style="font-size:24px;">You're on the roster, ${escapeHtml(name)}!</div>
          <p style="color:var(--ink-soft);font-size:13.5px;max-width:400px;margin:10px auto 20px;">
            ${visibility==='public' ? "Your info is visible to the group on the Roster tab." : "Your details are private — only the organizer can see them."}
          </p>
          <button class="btn btn-ghost" id="viewRosterBtn">View the roster →</button>
        </div>`;
      document.getElementById('viewRosterBtn').addEventListener('click', ()=>{
        document.querySelector('[data-tab="roster"]').click();
      });
    }catch(e){
      msgEl.innerHTML = '<div class="msg msg-error">Something went wrong saving your sign-up. Please try again.</div>';
      btn.disabled = false;
      btn.textContent = 'Add me to the roster';
    }
  });

  function escapeHtml(str){
    return String(str).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }

  function tagList(entry){
    const tags = [entry.frequency, entry.experience, entry.intensity];
    if(entry.position && entry.position!=='No preference') tags.push(entry.position);
    if(entry.age && entry.age!=='Prefer not to say') tags.push(entry.age);
    (entry.availability||[]).forEach(slot=> tags.push(AVAILABILITY_LABELS[slot] || slot));
    return tags;
  }

  // ---------- roster tab ----------
  async function renderRosterTab(){
    const listEl = document.getElementById('rosterList');
    const countEl = document.getElementById('rosterCount');
    listEl.innerHTML = '<div class="spinner-row">Loading roster…</div>';
    const arr = await getRoster();
    roster = arr;
    const sorted = [...arr].sort((a,b)=>new Date(a.submittedAt)-new Date(b.submittedAt));
    sorted.forEach((p,i)=>{ p.displayNumber = i+1; });
    const pubCount = arr.filter(p=>p.visibility==='public').length;
    countEl.textContent = `${arr.length} signed up · ${pubCount} public`;

    if(sorted.length===0){
      listEl.innerHTML = `<div class="empty-state"><div class="display">No players yet</div><p>Share this page's link — sign-ups will show up here.</p></div>`;
      return;
    }

    listEl.innerHTML = sorted.map(p=>{
      const isPrivate = p.visibility==='private';
      const contactLine = isPrivate
        ? `<span class="lock-icon">🔒</span> Private — contact via organizer`
        : [p.phone, p.email].filter(Boolean).map(escapeHtml).join(' · ');
      const tags = isPrivate ? [] : tagList(p);
      return `
        <div class="player-card ${isPrivate?'private':''}">
          <div class="jersey">${p.displayNumber}</div>
          <div style="flex:1;">
            <div class="player-name">${escapeHtml(p.name)}</div>
            <div class="player-contact">${contactLine}</div>
            <div class="tag-row">
              ${tags.map(t=>`<span class="tag">${escapeHtml(t)}</span>`).join('')}
            </div>
            ${(!isPrivate && p.notes) ? `<div class="notes">"${escapeHtml(p.notes)}"</div>` : ''}
          </div>
        </div>`;
    }).join('');
  }
  document.getElementById('refreshRosterBtn').addEventListener('click', renderRosterTab);

  // ---------- vote tab (multiple proposed matches) ----------
  document.getElementById('m-date').min = toISODate(new Date());

  function renderMatchCard(match, votes, interactive){
    const slots = matchSlots(match.match_date);
    const now = new Date();
    const counts = {};
    slots.forEach(s=>{ counts[s.key] = 0; });
    votes.forEach(v=>{ if(counts[v.slot]!==undefined) counts[v.slot]++; });
    const max = Math.max(1, ...Object.values(counts));
    const voterCount = new Set(votes.map(v=> v.name.toLowerCase())).size;

    // one location preference per distinct voter, grouped by normalized text
    const seenVoters = new Set();
    const locationCounts = {};
    const locationDisplay = {};
    votes.forEach(v=>{
      const voterKey = v.name.toLowerCase();
      if(seenVoters.has(voterKey)) return;
      seenVoters.add(voterKey);
      const norm = (v.location||'').trim().toLowerCase();
      if(!norm) return;
      locationCounts[norm] = (locationCounts[norm]||0) + 1;
      if(!locationDisplay[norm]) locationDisplay[norm] = v.location.trim();
    });
    const locationEntries = Object.keys(locationCounts)
      .map(k=>({ label: locationDisplay[k], count: locationCounts[k] }))
      .sort((a,b)=> b.count-a.count);
    const locationMax = locationEntries.length ? locationEntries[0].count : 0;

    const resultsHtml = slots.map(s=>{
      const c = counts[s.key];
      const pct = Math.round((c/max)*100);
      const isTop = c>0 && c===max;
      return `
        <div style="margin-bottom:9px;">
          <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:3px;">
            <span>${s.label}${isTop?' 🏆':''}</span>
            <span class="mono" style="color:var(--ink-soft);">${c} vote${c===1?'':'s'}</span>
          </div>
          <div style="background:var(--line);border-radius:6px;height:8px;overflow:hidden;">
            <div style="width:${pct}%;height:100%;background:${isTop?'var(--cone)':'var(--turf)'};border-radius:6px;"></div>
          </div>
        </div>`;
    }).join('');

    const locationHtml = locationEntries.length ? `
      <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--line);">
        <div class="lbl" style="margin-bottom:6px;">Preferred location</div>
        ${locationEntries.map(l=>{
          const pct = Math.round((l.count/locationMax)*100);
          const isTop = l.count===locationMax;
          return `
            <div style="margin-bottom:8px;">
              <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:3px;">
                <span>${escapeHtml(l.label)}${isTop?' 🏆':''}</span>
                <span class="mono" style="color:var(--ink-soft);">${l.count} vote${l.count===1?'':'s'}</span>
              </div>
              <div style="background:var(--line);border-radius:6px;height:8px;overflow:hidden;">
                <div style="width:${pct}%;height:100%;background:${isTop?'var(--cone)':'var(--turf)'};border-radius:6px;"></div>
              </div>
            </div>`;
        }).join('')}
      </div>` : '';

    const formHtml = interactive ? `
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line);">
        <label class="field">
          <span class="lbl">Your name *</span>
          <input type="text" class="match-vote-name" placeholder="Your name">
        </label>
        <label class="field">
          <span class="lbl">Preferred location</span>
          <input type="text" class="match-vote-location" placeholder="Optional — e.g. Riverside Park">
        </label>
        <div class="check-grid">
          ${slots.map(s=>{
            const closed = s.closesAt < now;
            return `<label class="check-item${closed?' closed':''}" data-slot="${s.key}" ${closed?'style="opacity:0.5;cursor:not-allowed;"':''}>
              <input type="checkbox" ${closed?'disabled':''}>${s.label}${closed?' <span class="tag lock" style="margin-left:4px;">closed</span>':''}
            </label>`;
          }).join('')}
        </div>
        <div class="match-vote-msg"></div>
        <div style="margin-top:14px;">
          <button class="btn btn-primary btn-block match-vote-submit">Save my availability</button>
        </div>
        <div class="divider-note">Can't make it? Leave every box unchecked and save to clear your vote.</div>
      </div>` : '';

    return `
      <div class="card" data-match-id="${match.id}" style="margin-bottom:16px;">
        <div class="eyebrow" style="margin-top:0;display:flex;justify-content:space-between;align-items:baseline;gap:10px;">
          <span>${escapeHtml(formatDateLabel(match.match_date))}</span>
          <span class="pill-count">${voterCount} voted</span>
        </div>
        <div style="font-size:13px;color:var(--ink-soft);margin-bottom:10px;">Proposed by ${escapeHtml(match.creator_name)}${match.note ? ` · ${escapeHtml(match.note)}` : ''}</div>
        ${resultsHtml}
        ${locationHtml}
        ${formHtml}
      </div>`;
  }

  async function renderVoteTab(){
    const countEl = document.getElementById('matchCount');
    const upcomingEl = document.getElementById('upcomingMatches');
    const pastWrapEl = document.getElementById('pastMatchesWrap');
    const pastEl = document.getElementById('pastMatches');
    upcomingEl.innerHTML = '<div class="spinner-row">Loading matches…</div>';

    const [matches, votes] = await Promise.all([getMatches(), getAllVotes()]);
    const votesByMatch = {};
    votes.forEach(v=>{
      if(!votesByMatch[v.match_id]) votesByMatch[v.match_id] = [];
      votesByMatch[v.match_id].push(v);
    });

    const upcoming = matches.filter(m=> !isMatchClosed(m.match_date)).sort((a,b)=> new Date(a.match_date)-new Date(b.match_date));
    const past = matches.filter(m=> isMatchClosed(m.match_date)).sort((a,b)=> new Date(b.match_date)-new Date(a.match_date));

    countEl.textContent = `${upcoming.length} open match${upcoming.length===1?'':'es'}`;
    upcomingEl.innerHTML = upcoming.length
      ? upcoming.map(m=> renderMatchCard(m, votesByMatch[m.id]||[], true)).join('')
      : `<div class="empty-state"><div class="display">No matches proposed yet</div><p>Propose one above to get people voting.</p></div>`;

    if(past.length){
      pastWrapEl.style.display = 'block';
      pastEl.innerHTML = past.map(m=> renderMatchCard(m, votesByMatch[m.id]||[], false)).join('');
    }else{
      pastWrapEl.style.display = 'none';
      pastEl.innerHTML = '';
    }
  }
  document.getElementById('refreshMatchesBtn').addEventListener('click', renderVoteTab);

  document.getElementById('upcomingMatches').addEventListener('change', (e)=>{
    const item = e.target.closest('.check-item');
    if(item) item.classList.toggle('checked', e.target.checked);
  });

  document.getElementById('upcomingMatches').addEventListener('focusout', async (e)=>{
    if(!e.target.classList.contains('match-vote-name')) return;
    const card = e.target.closest('[data-match-id]');
    const name = e.target.value.trim();
    if(!name) return;
    const votes = await getVotesForMatch(card.dataset.matchId);
    const mine = votes.filter(v=>v.name.toLowerCase()===name.toLowerCase());
    if(!mine.length) return;
    const mySlots = mine.map(v=>v.slot);
    const myLocation = (mine.find(v=>v.location) || {}).location || '';
    const locationInput = card.querySelector('.match-vote-location');
    if(locationInput && !locationInput.value) locationInput.value = myLocation;
    card.querySelectorAll('.check-item:not(.closed)').forEach(item=>{
      const input = item.querySelector('input');
      const checked = mySlots.includes(item.dataset.slot);
      input.checked = checked;
      item.classList.toggle('checked', checked);
    });
  });

  document.getElementById('upcomingMatches').addEventListener('click', async (e)=>{
    const btn = e.target.closest('.match-vote-submit');
    if(!btn) return;
    const card = btn.closest('[data-match-id]');
    const matchId = card.dataset.matchId;
    const nameInput = card.querySelector('.match-vote-name');
    const msgEl = card.querySelector('.match-vote-msg');
    const locationInput = card.querySelector('.match-vote-location');
    const name = nameInput.value.trim();
    const location = locationInput ? locationInput.value.trim() : '';
    const selected = Array.from(card.querySelectorAll('input[type=checkbox]:checked'))
      .map(i=>i.closest('.check-item').dataset.slot);
    msgEl.innerHTML = '';

    if(!name){
      msgEl.innerHTML = '<div class="msg msg-error">Enter your name first.</div>';
      return;
    }

    const existingVotes = await getVotesForMatch(matchId);
    const alreadyVoted = existingVotes.some(v=>v.name.toLowerCase()===name.toLowerCase());
    if(alreadyVoted){
      const ok = confirm(`There's already a vote for "${name}" on this match. Continue and replace it?`);
      if(!ok) return;
    }

    btn.disabled = true;
    btn.textContent = 'Saving…';
    try{
      await replaceMatchVotes(matchId, name, selected, location);
      markSeen('lastSeenVote');
      await renderVoteTab();
      await updateRibbons();
    }catch(err){
      msgEl.innerHTML = '<div class="msg msg-error">Something went wrong saving your vote. Please try again.</div>';
      btn.disabled = false;
      btn.textContent = 'Save my availability';
    }
  });

  document.getElementById('proposeMatchBtn').addEventListener('click', async ()=>{
    const msgEl = document.getElementById('proposeMsg');
    msgEl.innerHTML = '';
    const name = document.getElementById('m-name').value.trim();
    const date = document.getElementById('m-date').value;
    const note = document.getElementById('m-note').value.trim();

    if(!name || !date){
      msgEl.innerHTML = '<div class="msg msg-error">Enter your name and pick a date.</div>';
      return;
    }

    const btn = document.getElementById('proposeMatchBtn');
    btn.disabled = true;
    btn.textContent = 'Proposing…';
    try{
      await insertMatch(name, date, note);
      document.getElementById('m-date').value = '';
      document.getElementById('m-note').value = '';
      msgEl.innerHTML = '<div class="msg msg-success">Match proposed — people can vote on it below!</div>';
      markSeen('lastSeenVote');
      await renderVoteTab();
      await updateRibbons();
    }catch(e){
      msgEl.innerHTML = '<div class="msg msg-error">Something went wrong proposing this match. Please try again.</div>';
    }finally{
      btn.disabled = false;
      btn.textContent = 'Propose this match';
    }
  });

  // ---------- board tab ----------
  async function renderBoardTab(){
    const listEl = document.getElementById('boardList');
    const countEl = document.getElementById('boardCount');
    listEl.innerHTML = '<div class="spinner-row">Loading messages…</div>';
    const msgs = await getMessages();
    countEl.textContent = `${msgs.length} message${msgs.length===1?'':'s'}`;

    if(msgs.length===0){
      listEl.innerHTML = `<div class="empty-state"><div class="display">No messages yet</div><p>Be the first to say something to the group.</p></div>`;
      return;
    }

    listEl.innerHTML = msgs.map(m=>`
      <div class="board-msg">
        <div class="board-msg-header">
          <span class="board-msg-author">${escapeHtml(m.author)}</span>
          <span class="board-msg-time">${formatMsgTime(m.created_at)}</span>
        </div>
        <div class="board-msg-text">${escapeHtml(m.message)}</div>
      </div>`).join('');
  }
  document.getElementById('refreshBoardBtn').addEventListener('click', renderBoardTab);

  document.getElementById('postBtn').addEventListener('click', async ()=>{
    const msgEl = document.getElementById('boardMsg');
    msgEl.innerHTML = '';
    const author = document.getElementById('b-name').value.trim();
    const message = document.getElementById('b-message').value.trim();
    if(!author || !message){
      msgEl.innerHTML = '<div class="msg msg-error">Enter your name and a message.</div>';
      return;
    }
    const btn = document.getElementById('postBtn');
    btn.disabled = true;
    btn.textContent = 'Posting…';
    try{
      await insertMessage(author, message);
      document.getElementById('b-message').value = '';
      msgEl.innerHTML = '<div class="msg msg-success">Posted!</div>';
      markSeen('lastSeenBoard');
      await renderBoardTab();
      await updateRibbons();
    }catch(e){
      msgEl.innerHTML = '<div class="msg msg-error">Something went wrong posting your message. Please try again.</div>';
    }finally{
      btn.disabled = false;
      btn.textContent = 'Post';
    }
  });

  // ---------- ideas tab ----------
  async function renderIdeasTab(){
    const listEl = document.getElementById('ideaList');
    const countEl = document.getElementById('ideaCount');
    listEl.innerHTML = '<div class="spinner-row">Loading suggestions…</div>';
    const [ideas, comments] = await Promise.all([getSuggestions(), getComments()]);
    const commentsBySuggestion = groupCommentsBySuggestion(comments);
    countEl.textContent = `${ideas.length} suggestion${ideas.length===1?'':'s'}`;

    if(ideas.length===0){
      listEl.innerHTML = `<div class="empty-state"><div class="display">No suggestions yet</div><p>Got an idea for the games or the site? Add it above.</p></div>`;
      return;
    }

    listEl.innerHTML = ideas.map(s=>{
      const suggestionComments = commentsBySuggestion[s.id] || [];
      const commentRows = suggestionComments.map(c=>`
        <div class="comment">
          <span class="comment-author">${escapeHtml(c.author || 'Anonymous')}</span>
          <span class="comment-time">${formatMsgTime(c.created_at)}</span>
          <div class="comment-text">${escapeHtml(c.comment)}</div>
        </div>`).join('');
      return `
      <div class="board-msg">
        <div class="board-msg-header">
          <span class="board-msg-author">${escapeHtml(s.author || 'Anonymous')}</span>
          <span class="board-msg-time">${formatMsgTime(s.created_at)}</span>
        </div>
        <div class="tag-row" style="margin-bottom:8px;"><span class="tag">${escapeHtml(s.category)}</span></div>
        <div class="board-msg-text">${escapeHtml(s.suggestion)}</div>
        ${commentRows ? `<div class="comment-list">${commentRows}</div>` : ''}
        <div class="reply-row">
          <input type="text" class="reply-name" placeholder="Name" data-reply-name="${s.id}">
          <input type="text" class="reply-text" placeholder="Add a comment…" data-reply-text="${s.id}">
          <button class="btn btn-ghost" data-reply-btn="${s.id}">Reply</button>
        </div>
        <div data-reply-msg="${s.id}"></div>
      </div>`;
    }).join('');

    listEl.querySelectorAll('[data-reply-btn]').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const sid = btn.dataset.replyBtn;
        const nameInput = listEl.querySelector(`[data-reply-name="${sid}"]`);
        const textInput = listEl.querySelector(`[data-reply-text="${sid}"]`);
        const msgEl = listEl.querySelector(`[data-reply-msg="${sid}"]`);
        const text = textInput.value.trim();
        if(!text){ msgEl.innerHTML = '<div class="msg msg-error">Write a comment first.</div>'; return; }
        btn.disabled = true;
        btn.textContent = 'Posting…';
        try{
          await insertComment(sid, nameInput.value.trim(), text);
          await renderIdeasTab();
        }catch(e){
          msgEl.innerHTML = '<div class="msg msg-error">Something went wrong. Please try again.</div>';
          btn.disabled = false;
          btn.textContent = 'Reply';
        }
      });
    });
  }
  document.getElementById('refreshIdeasBtn').addEventListener('click', renderIdeasTab);

  document.getElementById('ideaSubmitBtn').addEventListener('click', async ()=>{
    const msgEl = document.getElementById('ideaMsg');
    msgEl.innerHTML = '';
    const author = document.getElementById('s-name').value.trim();
    const category = document.getElementById('s-category').value;
    const text = document.getElementById('s-text').value.trim();
    if(!text){
      msgEl.innerHTML = '<div class="msg msg-error">Enter a suggestion first.</div>';
      return;
    }
    const btn = document.getElementById('ideaSubmitBtn');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try{
      await insertSuggestion(author, category, text);
      document.getElementById('s-text').value = '';
      msgEl.innerHTML = '<div class="msg msg-success">Thanks — sent!</div>';
      markSeen('lastSeenIdeas');
      await renderIdeasTab();
    }catch(e){
      msgEl.innerHTML = '<div class="msg msg-error">Something went wrong sending your suggestion. Please try again.</div>';
    }finally{
      btn.disabled = false;
      btn.textContent = 'Send suggestion';
    }
  });

  // ---------- organizer tab ----------
  async function getOrganizerContact(){
    try{
      const res = await sb('settings?key=eq.organizer_contact&select=value');
      const rows = await res.json();
      return rows.length ? JSON.parse(rows[0].value) : null;
    }catch(e){
      return null;
    }
  }
  async function setOrganizerContact(contact){
    return sb('settings', {
      method:'POST',
      headers:{ 'Prefer':'resolution=merge-duplicates' },
      body: JSON.stringify({ key:'organizer_contact', value: JSON.stringify(contact) })
    });
  }

  async function renderOrganizerTab(){
    const gate = document.getElementById('organizerGate');
    if(organizerUnlocked){
      return renderOrganizerFull();
    }
    gate.innerHTML = '<div class="spinner-row">Loading…</div>';
    const pin = await getPin();
    const contact = await getOrganizerContact();

    const contactBlock = (contact && (contact.name || contact.phone || contact.email))
      ? `
        <div class="eyebrow" style="margin-top:0;">Organizer contact</div>
        <p style="font-size:13.5px;color:var(--ink-soft);margin-bottom:10px;">Questions, or need to reach the organizer directly?</p>
        <div style="font-weight:700;font-size:15px;">${escapeHtml(contact.name || 'Organizer')}</div>
        <div class="mono" style="font-size:12.5px;color:var(--ink-soft);margin-top:3px;">
          ${[contact.phone, contact.email].filter(Boolean).map(escapeHtml).join(' · ') || 'No contact details on file'}
        </div>`
      : `
        <div class="eyebrow" style="margin-top:0;">Organizer contact</div>
        <p style="font-size:13.5px;color:var(--ink-soft);">No organizer contact info has been added yet.</p>`;

    gate.innerHTML = `${contactBlock}<div id="orgLoginArea" style="margin-top:24px;"></div>`;

    const loginArea = document.getElementById('orgLoginArea');

    const showLoginToggle = ()=>{
      loginArea.innerHTML = `<div style="text-align:right;"><button class="btn btn-ghost" id="orgLoginToggleBtn" style="font-size:11px;padding:5px 10px;opacity:0.65;">Organizer login</button></div>`;
      document.getElementById('orgLoginToggleBtn').addEventListener('click', showLoginForm);
    };

    const showLoginForm = ()=>{
      if(!pin){
        loginArea.innerHTML = `
          <div class="eyebrow">Set up organizer access</div>
          <p style="font-size:13.5px;color:var(--ink-soft);">Add your contact info (shown publicly above so players can reach you) and choose a passphrase for managing sign-ups.</p>
          <label class="field"><span class="lbl">Your name</span><input type="text" id="orgName"></label>
          <div class="grid2">
            <label class="field"><span class="lbl">Phone</span><input type="tel" id="orgPhone"></label>
            <label class="field"><span class="lbl">Email</span><input type="email" id="orgEmail"></label>
          </div>
          <label class="field"><span class="lbl">Choose a passphrase</span><input type="text" id="pinSetup"></label>
          <div id="pinMsg"></div>
          <button class="btn btn-primary btn-block" id="setPinBtn">Save &amp; unlock</button>`;
        document.getElementById('setPinBtn').addEventListener('click', async ()=>{
          const val = document.getElementById('pinSetup').value.trim();
          const msgEl = document.getElementById('pinMsg');
          if(!val){ msgEl.innerHTML = '<div class="msg msg-error">Enter a passphrase first.</div>'; return; }
          try{
            await setPin(val);
            await setOrganizerContact({
              name: document.getElementById('orgName').value.trim(),
              phone: document.getElementById('orgPhone').value.trim(),
              email: document.getElementById('orgEmail').value.trim()
            });
            organizerUnlocked = true;
            renderOrganizerFull();
          }catch(e){
            msgEl.innerHTML = '<div class="msg msg-error">Could not save. Try again.</div>';
          }
        });
        return;
      }

      loginArea.innerHTML = `
        <div class="eyebrow">Organizer login</div>
        <label class="field"><span class="lbl">Passphrase</span><input type="text" id="pinEntry"></label>
        <div id="pinMsg"></div>
        <button class="btn btn-primary btn-block" id="unlockBtn">Unlock</button>`;
      document.getElementById('unlockBtn').addEventListener('click', async ()=>{
        const val = document.getElementById('pinEntry').value.trim();
        const msgEl = document.getElementById('pinMsg');
        if(val===pin){
          organizerUnlocked = true;
          renderOrganizerFull();
        }else{
          msgEl.innerHTML = '<div class="msg msg-error">Incorrect passphrase.</div>';
        }
      });
    };

    showLoginToggle();
  }

  async function renderOrganizerFull(){
    const gate = document.getElementById('organizerGate');
    gate.innerHTML = '<div class="spinner-row">Loading full roster…</div>';
    const arr = await getRoster();
    roster = arr;
    const sorted = [...arr].sort((a,b)=>new Date(a.submittedAt)-new Date(b.submittedAt));
    sorted.forEach((p,i)=>{ p.displayNumber = i+1; });
    const msgs = await getMessages();
    const ideas = await getSuggestions();
    const comments = await getComments();
    const commentsBySuggestion = groupCommentsBySuggestion(comments);
    const emailCount = sorted.filter(p=>p.email).length;

    const rows = sorted.map(p=>{
      const contactLine = [p.phone, p.email].filter(Boolean).map(escapeHtml).join(' · ') || '—';
      const tags = tagList(p);
      return `
        <div class="player-card">
          <div class="jersey">${p.displayNumber}</div>
          <div style="flex:1;">
            <div class="player-name">${escapeHtml(p.name)} ${p.visibility==='private' ? '<span class="tag lock">private</span>' : ''}</div>
            <div class="player-contact">${contactLine}</div>
            <div class="tag-row">${tags.map(t=>`<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
            ${p.notes ? `<div class="notes">"${escapeHtml(p.notes)}"</div>` : ''}
            <div class="organizer-actions"><button class="btn btn-danger" data-remove="${p.id}">Remove</button></div>
          </div>
        </div>`;
    }).join('') || `<div class="empty-state"><div class="display">No sign-ups yet</div></div>`;

    const msgRows = msgs.map(m=>`
      <div class="board-msg">
        <div class="board-msg-header">
          <span class="board-msg-author">${escapeHtml(m.author)}</span>
          <span class="board-msg-time">${formatMsgTime(m.created_at)}</span>
        </div>
        <div class="board-msg-text">${escapeHtml(m.message)}</div>
        <div class="organizer-actions"><button class="btn btn-danger" data-remove-msg="${m.id}">Delete</button></div>
      </div>`).join('') || `<div class="empty-state"><div class="display">No messages</div></div>`;

    const ideaRows = ideas.map(s=>{
      const suggestionComments = commentsBySuggestion[s.id] || [];
      const commentRows = suggestionComments.map(c=>`
        <div class="comment">
          <span class="comment-author">${escapeHtml(c.author || 'Anonymous')}</span>
          <span class="comment-time">${formatMsgTime(c.created_at)}</span>
          <div class="comment-text">${escapeHtml(c.comment)}</div>
          <div class="organizer-actions"><button class="btn btn-danger" data-remove-comment="${c.id}" style="padding:4px 8px;font-size:11px;">Delete</button></div>
        </div>`).join('');
      return `
      <div class="board-msg">
        <div class="board-msg-header">
          <span class="board-msg-author">${escapeHtml(s.author || 'Anonymous')}</span>
          <span class="board-msg-time">${formatMsgTime(s.created_at)}</span>
        </div>
        <div class="tag-row" style="margin-bottom:8px;"><span class="tag">${escapeHtml(s.category)}</span></div>
        <div class="board-msg-text">${escapeHtml(s.suggestion)}</div>
        <div class="organizer-actions"><button class="btn btn-danger" data-remove-idea="${s.id}">Delete</button></div>
        ${commentRows ? `<div class="comment-list">${commentRows}</div>` : ''}
      </div>`;
    }).join('') || `<div class="empty-state"><div class="display">No suggestions</div></div>`;

    const matches = await getMatches();
    const allVotes = await getAllVotes();
    const votesByMatch = {};
    allVotes.forEach(v=>{
      if(!votesByMatch[v.match_id]) votesByMatch[v.match_id] = [];
      votesByMatch[v.match_id].push(v);
    });
    const slotLabelByKey = {};
    POLL_TIME_RANGES.forEach(t=>{ slotLabelByKey[t.key] = t.label; });

    const matchRows = matches.map(m=>{
      const mVotes = votesByMatch[m.id] || [];
      const votersByName = {};
      mVotes.forEach(v=>{
        const key = v.name.trim();
        if(!votersByName[key]) votersByName[key] = { slots: [], location: null };
        votersByName[key].slots.push(v.slot);
        if(v.location) votersByName[key].location = v.location;
      });
      const voterRows = Object.keys(votersByName).map(name=>{
        const { slots, location } = votersByName[name];
        return `
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-top:8px;padding-top:8px;border-top:1px solid var(--line);">
            <div style="flex:1;">
              <div style="font-weight:600;font-size:13px;">${escapeHtml(name)}</div>
              <div class="tag-row">${slots.map(sk=>`<span class="tag">${escapeHtml(slotLabelByKey[sk] || sk)}</span>`).join('')}</div>
              ${location ? `<div class="notes" style="margin-top:4px;">📍 ${escapeHtml(location)}</div>` : ''}
            </div>
            <button class="btn btn-danger" data-remove-voter-match="${m.id}" data-remove-voter-name="${escapeHtml(name)}" style="padding:4px 8px;font-size:11px;flex-shrink:0;">Delete</button>
          </div>`;
      }).join('') || `<div class="notes" style="margin-top:8px;">No votes yet</div>`;

      return `
        <div class="board-msg">
          <div class="board-msg-header">
            <span class="board-msg-author">${escapeHtml(formatDateLabel(m.match_date))}</span>
            <span class="board-msg-time">${isMatchClosed(m.match_date) ? 'closed' : 'open'}</span>
          </div>
          <div style="font-size:12.5px;color:var(--ink-soft);margin-bottom:4px;">Proposed by ${escapeHtml(m.creator_name)}${m.note ? ` · ${escapeHtml(m.note)}` : ''}</div>
          ${voterRows}
          <div class="organizer-actions"><button class="btn btn-danger" data-remove-match="${m.id}">Delete match</button></div>
        </div>`;
    }).join('') || `<div class="empty-state"><div class="display">No matches proposed yet</div></div>`;

    gate.innerHTML = `
      <div class="eyebrow" style="display:flex;justify-content:space-between;align-items:center;margin-top:0;">
        <span>Full roster (${sorted.length})</span>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-ghost" id="editContactBtn" style="padding:6px 12px;font-size:12px;">Edit my contact info</button>
          <button class="btn btn-ghost" id="lockBtn" style="padding:6px 12px;font-size:12px;">Lock</button>
        </div>
      </div>

      <div class="eyebrow">Send an update</div>
      <p style="font-size:13.5px;color:var(--ink-soft);margin-bottom:12px;">Posts to the Board (everyone sees it there) and emails whoever you select below.</p>
      <label class="field"><span class="lbl">Subject</span><input type="text" id="updateSubject" placeholder="e.g. Sunday's game moved to 4pm"></label>
      <label class="field" style="margin-bottom:8px;"><span class="lbl">Message</span><textarea id="updateBody" placeholder="What's the update?"></textarea></label>

      ${emailEnabled() ? `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <span class="lbl" style="margin-bottom:0;">Email recipients</span>
          <span class="pill-count" id="recipientCountLabel">${emailCount} of ${emailCount} selected</span>
        </div>
        <div class="check-grid" id="updateRecipients">
          ${sorted.filter(p=>p.email).map(p=>`
            <label class="check-item checked" data-id="${p.id}">
              <input type="checkbox" checked value="${p.id}">${escapeHtml(p.name)}
            </label>`).join('') || '<div class="empty-state" style="padding:14px;grid-column:1/-1;"><p>No one has an email on file yet.</p></div>'}
        </div>
        ${emailCount ? `
          <div style="display:flex;gap:8px;margin-top:8px;">
            <button class="btn btn-ghost" id="selectAllBtn" style="padding:5px 10px;font-size:11.5px;">Select all</button>
            <button class="btn btn-ghost" id="selectNoneBtn" style="padding:5px 10px;font-size:11.5px;">Select none</button>
          </div>` : ''}
      ` : ''}

      <div id="updateMsg"></div>
      <button class="btn btn-primary btn-block" id="sendUpdateBtn" style="margin-top:16px;">${emailEnabled() ? `Post &amp; email ${emailCount} player${emailCount===1?'':'s'}` : 'Post update'}</button>
      ${!emailEnabled() ? '<div class="divider-note">Email sending isn\'t configured yet — this will just post to the Board. Add your EmailJS keys near the top of the script to enable email.</div>' : ''}

      ${rows}
      <div class="eyebrow">Board messages (${msgs.length})</div>
      ${msgRows}
      <div class="eyebrow">Suggestions (${ideas.length})</div>
      ${ideaRows}
      <div class="eyebrow">Matches (${matches.length})</div>
      ${matchRows}`;

    function updateRecipientCountLabel(){
      const boxes = document.querySelectorAll('#updateRecipients input[type=checkbox]');
      const checked = document.querySelectorAll('#updateRecipients input[type=checkbox]:checked').length;
      const label = document.getElementById('recipientCountLabel');
      if(label) label.textContent = `${checked} of ${boxes.length} selected`;
      const sendBtn = document.getElementById('sendUpdateBtn');
      if(sendBtn && emailEnabled()){
        sendBtn.textContent = checked>0 ? `Post & email ${checked} player${checked===1?'':'s'}` : 'Post update (no email)';
      }
    }
    document.querySelectorAll('#updateRecipients .check-item').forEach(item=>{
      const input = item.querySelector('input');
      input.addEventListener('change', ()=>{
        item.classList.toggle('checked', input.checked);
        updateRecipientCountLabel();
      });
    });
    document.getElementById('selectAllBtn')?.addEventListener('click', ()=>{
      document.querySelectorAll('#updateRecipients .check-item').forEach(item=>{
        item.querySelector('input').checked = true;
        item.classList.add('checked');
      });
      updateRecipientCountLabel();
    });
    document.getElementById('selectNoneBtn')?.addEventListener('click', ()=>{
      document.querySelectorAll('#updateRecipients .check-item').forEach(item=>{
        item.querySelector('input').checked = false;
        item.classList.remove('checked');
      });
      updateRecipientCountLabel();
    });

    document.getElementById('sendUpdateBtn').addEventListener('click', async ()=>{
      const msgEl = document.getElementById('updateMsg');
      const subject = document.getElementById('updateSubject').value.trim();
      const body = document.getElementById('updateBody').value.trim();
      if(!body){ msgEl.innerHTML = '<div class="msg msg-error">Write a message first.</div>'; return; }

      const btn = document.getElementById('sendUpdateBtn');
      btn.disabled = true;
      btn.textContent = 'Posting…';

      let recipientCount = emailCount;
      try{
        const contact = (await getOrganizerContact()) || {};
        const boardText = subject ? `📣 ${subject}\n\n${body}` : body;
        await insertMessage(contact.name || 'Organizer', boardText);
        markSeen('lastSeenBoard');
        await updateRibbons();

        if(emailEnabled()){
          const selectedIds = Array.from(document.querySelectorAll('#updateRecipients input[type=checkbox]:checked')).map(i=>i.value);
          const recipients = sorted.filter(p=>p.email && selectedIds.includes(String(p.id)));
          recipientCount = recipients.length;
          if(recipients.length){
            const { sent, failed } = await sendUpdateEmails(subject, body, recipients, (done, total)=>{
              btn.textContent = `Emailing ${done}/${total}…`;
            }, contact.email);
            msgEl.innerHTML = `<div class="msg msg-success">Posted to board and emailed ${sent} player${sent===1?'':'s'}.${failed ? ` ${failed} failed to send.` : ''}</div>`;
          }else{
            msgEl.innerHTML = emailCount===0
              ? '<div class="msg msg-success">Posted to board. No one has an email on file yet.</div>'
              : '<div class="msg msg-success">Posted to board. No recipients were selected, so no emails were sent.</div>';
          }
        }else{
          msgEl.innerHTML = '<div class="msg msg-success">Posted to board.</div>';
        }
        document.getElementById('updateSubject').value = '';
        document.getElementById('updateBody').value = '';
      }catch(e){
        msgEl.innerHTML = '<div class="msg msg-error">Something went wrong. Please try again.</div>';
      }finally{
        btn.disabled = false;
        btn.textContent = emailEnabled() ? `Post & email ${recipientCount} player${recipientCount===1?'':'s'}` : 'Post update';
      }
    });

    document.getElementById('editContactBtn').addEventListener('click', async ()=>{
      const contact = (await getOrganizerContact()) || {};
      const formHtml = `
        <div class="card" style="margin-bottom:16px;">
          <div class="eyebrow" style="margin-top:0;">Edit organizer contact info</div>
          <label class="field"><span class="lbl">Name</span><input type="text" id="editOrgName" value="${escapeHtml(contact.name||'')}"></label>
          <div class="grid2">
            <label class="field"><span class="lbl">Phone</span><input type="tel" id="editOrgPhone" value="${escapeHtml(contact.phone||'')}"></label>
            <label class="field"><span class="lbl">Email</span><input type="email" id="editOrgEmail" value="${escapeHtml(contact.email||'')}"></label>
          </div>
          <div id="editContactMsg"></div>
          <div style="display:flex;gap:10px;margin-top:12px;">
            <button class="btn btn-primary" id="saveContactBtn" style="flex:1;">Save</button>
            <button class="btn btn-ghost" id="cancelContactBtn" style="flex:1;">Cancel</button>
          </div>
        </div>`;
      gate.insertAdjacentHTML('afterbegin', formHtml);
      document.getElementById('cancelContactBtn').addEventListener('click', renderOrganizerFull);
      document.getElementById('saveContactBtn').addEventListener('click', async ()=>{
        const msgEl = document.getElementById('editContactMsg');
        try{
          await setOrganizerContact({
            name: document.getElementById('editOrgName').value.trim(),
            phone: document.getElementById('editOrgPhone').value.trim(),
            email: document.getElementById('editOrgEmail').value.trim()
          });
          renderOrganizerFull();
        }catch(e){
          msgEl.innerHTML = '<div class="msg msg-error">Could not save. Try again.</div>';
        }
      });
    });

    document.getElementById('lockBtn').addEventListener('click', ()=>{
      organizerUnlocked = false;
      renderOrganizerTab();
    });
    gate.querySelectorAll('[data-remove]').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        btn.disabled = true; btn.textContent='Removing…';
        const id = btn.dataset.remove;
        await deleteEntry(id);
        await updateScoreStat();
        renderOrganizerFull();
      });
    });
    gate.querySelectorAll('[data-remove-msg]').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        btn.disabled = true; btn.textContent='Removing…';
        await deleteMessage(btn.dataset.removeMsg);
        renderOrganizerFull();
      });
    });
    gate.querySelectorAll('[data-remove-idea]').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        btn.disabled = true; btn.textContent='Removing…';
        await deleteSuggestion(btn.dataset.removeIdea);
        renderOrganizerFull();
      });
    });
    gate.querySelectorAll('[data-remove-comment]').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        btn.disabled = true; btn.textContent='Removing…';
        await deleteComment(btn.dataset.removeComment);
        renderOrganizerFull();
      });
    });
    gate.querySelectorAll('[data-remove-voter-match]').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        btn.disabled = true; btn.textContent='Removing…';
        await replaceMatchVotes(btn.dataset.removeVoterMatch, btn.dataset.removeVoterName, []);
        renderOrganizerFull();
      });
    });
    gate.querySelectorAll('[data-remove-match]').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        btn.disabled = true; btn.textContent='Removing…';
        await deleteMatch(btn.dataset.removeMatch);
        renderOrganizerFull();
      });
    });
  }

})();
