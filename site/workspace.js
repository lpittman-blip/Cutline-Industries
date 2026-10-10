// Same-origin authenticated chat. Browser storage contains drafts, not conversation logs or credentials.
(() => {
  const { node, button, renderText, renderTools, codeBlock } = ArtemisUI;
  const root = document.getElementById('view-chat'), box = document.getElementById('msgs');
  const composer = root.querySelector('.composer'), form = document.getElementById('composer'), input = document.getElementById('prompt');
  const sidebar = root.querySelector('aside'), convo = root.querySelector('.convo'), send = form.querySelector('.send');
  const sendIcon = send.innerHTML;
  let user = null, active = null, conversations = [], head = null, selected = 'chat', flight = null, archived = false, drafts = {}, pending = {}, searchVersion = 0;
  let speech = null, speechMessage = null;
  const notice = node('p', 'workspace-notice'); notice.setAttribute('role', 'status'); composer.prepend(notice);
  const hint = composer.querySelector('.hint'); hint.textContent = 'Saved securely to your account. Check important answers.';
  const status = node('span', 'model-status', 'Checking connection…'), model = node('span', 'workspace-name', 'Artemis');
  status.setAttribute('role', 'status');
  const authButton = button('Sign in', () => user ? accountDialog.showModal() : openAuth());
  authButton.className = 'workspace-account';
  const top = node('div', 'workspace-top'); top.append(model, status, authButton);
  const header = node('div', 'workspace-header'); header.append(top); convo.prepend(header);
  const mobile = node('div', 'session-mobile'), picker = node('select'); picker.setAttribute('aria-label', 'Conversation');
  picker.addEventListener('change', () => openConversation(picker.value));
  const mobileNew = button('＋ New', newConversation, 'mobile-new'); mobile.append(picker, mobileNew); header.append(mobile);
  const tabs = node('div', 'workspace-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Workspace views');
  const panels = { chat: box, activity: node('div', 'workspace-panel'), code: node('div', 'workspace-panel') }, tabButtons = {};
  for (const [name, label] of [['chat', 'Chat'], ['activity', 'Activity'], ['code', 'Code']]) {
    const tab = button(label, () => selectPanel(name)); tab.id = 'workspace-tab-' + name;
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', 'workspace-panel-' + name);
    panels[name].id = 'workspace-panel-' + name; panels[name].setAttribute('role', 'tabpanel'); panels[name].setAttribute('aria-labelledby', tab.id); panels[name].tabIndex = 0;
    if (name !== 'chat') convo.insertBefore(panels[name], composer);
    tabButtons[name] = tab; tabs.append(tab);
  }
  tabs.addEventListener('keydown', event => {
    const names = Object.keys(panels), i = names.indexOf(selected);
    const next = event.key === 'ArrowRight' ? (i + 1) % 3 : event.key === 'ArrowLeft' ? (i + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : -1;
    if (next >= 0) { event.preventDefault(); selectPanel(names[next]); tabButtons[names[next]].focus(); }
  }); header.append(tabs);
  const branchRow = node('div', 'workspace-branches'), branchPicker = node('select'); branchPicker.setAttribute('aria-label', 'Conversation branch');
  branchRow.append(node('span', '', 'Branch'), branchPicker); header.append(branchRow);
  branchPicker.addEventListener('change', () => action(async () => { await api('/api/conversations/' + active.id, { method: 'PATCH', body: { head_id: branchPicker.value } }); head = branchPicker.value; render(); }));

  // Model picker. Artemis is our own model and always the default; a plan may also
  // include a third-party model as an added service. A request sent to one of those
  // leaves our infrastructure, so the option says so and the notice repeats it while
  // it is selected - a customer should never have to guess who answered.
  const modelRow = node('div', 'workspace-models'), modelPicker = node('select');
  const modelNote = node('span', 'workspace-model-note');
  modelPicker.setAttribute('aria-label', 'Model'); modelRow.hidden = true;
  modelRow.append(node('span', '', 'Model'), modelPicker, modelNote); header.append(modelRow);
  let models = [{ id: 'artemis', display: 'Artemis', external: false, available: true }];
  let chosenModel = 'artemis';
  try { chosenModel = localStorage.getItem('artemis.model') || 'artemis'; } catch {}

  function describeModel() {
    const current = models.find(m => m.id === chosenModel);
    modelNote.textContent = current && current.external
      ? 'Third-party model. This request leaves Artemis.' : '';
  }
  function renderModels() {
    modelPicker.replaceChildren();
    for (const m of models) {
      const option = node('option', '', m.display + (m.external ? ' · third party' : '') + (m.available ? '' : ' (unavailable)'));
      option.value = m.id; option.disabled = !m.available; modelPicker.append(option);
    }
    if (!models.some(m => m.id === chosenModel && m.available)) chosenModel = 'artemis';
    modelPicker.value = chosenModel;
    modelRow.hidden = models.length < 2;
    describeModel();
  }
  modelPicker.addEventListener('change', () => {
    chosenModel = modelPicker.value;
    try { localStorage.setItem('artemis.model', chosenModel); } catch {}
    describeModel();
  });
  async function loadModels() {
    try {
      const response = await api('/api/models');
      if (Array.isArray(response.models) && response.models.length) models = response.models;
    } catch { /* keep Artemis only; the picker stays hidden */ }
    renderModels();
  }
  renderModels();
  sidebar.replaceChildren();
  const newButton = button('＋ New chat', newConversation, 'btn new'), search = node('input', 'session-search');
  search.type = 'search'; search.placeholder = 'Search conversations'; search.setAttribute('aria-label', 'Search conversations');
  const archiveToggle = button('Show archived', () => { archived = !archived; archiveToggle.textContent = archived ? 'Show active' : 'Show archived'; refreshList(); }, 'session-archive-toggle');
  const list = node('div', 'session-list'), listNote = node('p', 'session-note', 'Sign in for private, saved conversations across devices.');
  const sessionActions = node('div', 'session-actions');
  sessionActions.append(button('Rename', () => action(async () => {
    if (!active) return; const value = prompt('Conversation title', active.title); if (!value?.trim()) return;
    await api('/api/conversations/' + active.id, { method: 'PATCH', body: { title: value } }); await refreshList(); await openConversation(active.id);
  })), button('Archive', () => action(async () => {
    if (!active) return; await api('/api/conversations/' + active.id, { method: 'PATCH', body: { archived: !active.archived } }); active = null; await refreshList(); render();
  })), button('Delete', () => action(async () => {
    if (!active || !confirm('Delete this conversation and its live database records? Export first if needed. Hosting backups follow a separate expiry policy.')) return;
    await api('/api/conversations/' + active.id, { method: 'DELETE', body: {} }); delete drafts[active.id]; delete pending[active.id]; active = null; saveDrafts(); await refreshList(); render();
  })));
  sidebar.append(newButton, search, archiveToggle, list, listNote, sessionActions);
  let searchTimer; search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(refreshList, 200); });
  const waitlist = node('details', 'workspace-waitlist'); waitlist.append(node('summary', '', 'Get notified when Artemis is ready'));
  const oldWaitlist = document.getElementById('waitlist'), waitlistResult = document.getElementById('wlDone');
  if (oldWaitlist) waitlist.append(oldWaitlist); if (waitlistResult) waitlist.append(waitlistResult);

  async function api(path, options = {}) { return ArtemisAPI.request(path, options, user); }
  async function action(fn) { try { await fn(); } catch (error) { showNotice(error.message); } }
  function showNotice(text, extra) { notice.replaceChildren(document.createTextNode(text || '')); if (extra) notice.append(document.createTextNode(' '), extra); }
  function selectPanel(name) {
    selected = name;
    for (const key of Object.keys(panels)) { panels[key].hidden = key !== name; tabButtons[key].setAttribute('aria-selected', String(key === name)); tabButtons[key].tabIndex = key === name ? 0 : -1; }
  }
  function saveDrafts() {
    if (!user) return;
    try { localStorage.setItem('artemis.drafts.' + user.id, JSON.stringify({ drafts, pending, active: active?.id })); }
    catch { showNotice('Draft recovery is unavailable in this browser. Conversations are still saved on the server.'); }
  }
  input.addEventListener('input', () => { if (active) { drafts[active.id] = input.value.slice(0, 8000); saveDrafts(); } input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 180) + 'px'; });
  function controls() {
    const busy = !!flight; input.disabled = !user || busy; send.disabled = !user; send.type = busy ? 'button' : 'submit';
    send.setAttribute('aria-label', busy ? 'Stop' : 'Send'); form.setAttribute('aria-busy', String(busy));
    if (busy) send.replaceChildren(node('span', '', '■')); else send.innerHTML = sendIcon;
    for (const element of [newButton, mobileNew, picker, branchPicker, search, archiveToggle]) element.disabled = busy || !user;
    sessionActions.querySelectorAll('button').forEach(element => element.disabled = busy || !active);
    list.querySelectorAll('button').forEach(element => element.disabled = busy);
    authButton.textContent = user ? 'Account' : 'Sign in';
  }
  async function refreshList() {
    if (!user) { conversations = []; renderList(); return; }
    const version = ++searchVersion;
    try {
      const result = await api('/api/conversations?q=' + encodeURIComponent(search.value) + '&archived=' + Number(archived));
      if (version !== searchVersion) return; conversations = result.conversations; renderList();
    } catch (error) { showNotice(error.message); }
  }
  function renderList() {
    list.replaceChildren(); picker.replaceChildren();
    for (const conversation of conversations) {
      const item = button(conversation.title, () => openConversation(conversation.id), 'c'); if (conversation.id === active?.id) item.setAttribute('aria-current', 'true'); list.append(item);
      const option = node('option', '', conversation.title); option.value = conversation.id; option.selected = conversation.id === active?.id; picker.append(option);
    }
    listNote.textContent = user ? (conversations.length ? 'Conversations are saved to your account.' : 'No matching conversations.') : 'Sign in for private conversations across devices.'; controls();
  }
  async function newConversation() {
    if (!user) { openAuth(); return; } if (flight) return;
    if (active && !active.messages.length) { input.focus(); return; }
    await action(async () => { const conversation = await api('/api/conversations', { method: 'POST', body: {} }); showNotice(''); await refreshList(); await openConversation(conversation.id); });
  }
  function normalize(data) {
    for (const message of data.messages) {
      message.text = message.content; message.status = message.state === 'completed' ? 'ok' : ['queued', 'generating'].includes(message.state) ? 'pending' : 'error'; message.events = [];
      const request = data.requests.find(r => r.assistant_id === message.id);
      if (request) for (const event of data.tool_events.filter(e => e.request_id === request.id)) {
        let result = {}; try { result = JSON.parse(event.result || '{}'); } catch {}
        message.events.push({ name: event.name, pending: event.state === 'running', ok: event.state === 'completed', summary: result.summary || event.name + ' · ' + event.state, sources: result.sources, code: result.code, output: result.output });
      }
    } return data;
  }
  async function openConversation(cid, resume = true, desiredHead = null) {
    if (flight) return;
    stopSpeech();
    await action(async () => {
      active = normalize(await api('/api/conversations/' + cid)); head = desiredHead || active.head_id;
      input.value = drafts[cid] || ''; saveDrafts(); render();
      const ongoing = active.requests.find(r => r.assistant_id === head && ['queued', 'generating'].includes(r.state));
      if (ongoing && resume) await watch(ongoing.id, ongoing.assistant_id);
      else if (pending[cid]) {
        try {
          const request = await api('/api/requests?key=' + encodeURIComponent(pending[cid].idempotency_key));
          delete pending[cid]; saveDrafts();
          if (['queued', 'generating'].includes(request.state)) await watch(request.id, request.assistant_id);
          else { active = normalize(await api('/api/conversations/' + cid)); head = active.head_id; render(); }
        } catch (error) { if (error.code !== 404) showNotice(error.message); else showNotice('Your unsent request is recovered. Send it again to retry delivery.'); }
      }
    });
  }
  function branchMessages() {
    if (!active) return []; const lookup = new Map(active.messages.map(m => [m.id, m])); let current = head; const seen = new Set(), result = [];
    while (current && lookup.has(current) && !seen.has(current)) { seen.add(current); const message = lookup.get(current); result.push(message); current = message.parent_id; }
    return result.reverse();
  }
  function renderBranches() {
    branchPicker.replaceChildren();
    if (active) {
      const parents = new Set(active.messages.map(m => m.parent_id));
      const leaves = active.messages.filter(m => m.role === 'assistant' && (!parents.has(m.id) || m.id === head));
      leaves.forEach((message, index) => { const option = node('option', '', 'Branch ' + (index + 1) + ' · ' + new Date(message.created * 1000).toLocaleString()); option.value = message.id; option.selected = message.id === head; branchPicker.append(option); });
      branchRow.hidden = leaves.length < 2;
    } else branchRow.hidden = true;
  }
  function messageElement(message) {
    const el = node('div', 'msg ' + (message.role === 'user' ? 'user' : 'sys')), body = node('div', 'body'), log = node('ul', 'tool-log');
    el.dataset.messageId = message.id; el.append(node('span', 'who', message.role === 'user' ? 'You' : 'Artemis'), log, body);
    renderText(body, message.text); renderTools(log, message.events);
    if (message.status !== 'ok') {
      const state = node('p', 'message-state', message.error || (message.state === 'queued' ? 'Queued' : message.state === 'generating' ? 'Generating…' : message.state));
      if (message.status === 'error') state.classList.add('message-error'); el.append(state);
    }
    const actions = node('div', 'message-actions');
    if (message.text) actions.append(button('Copy', async () => { try { await navigator.clipboard.writeText(message.text); showNotice('Copied.'); } catch { showNotice('Clipboard unavailable. Select the text to copy it.'); } }));
    if (message.role === 'user') actions.append(button('Edit', () => {
      if (flight) return; const text = prompt('Edit this message. The original branch will be preserved.', message.text); if (text?.trim()) submit({ text, edit_message_id: message.id });
    }));
    if (message.role === 'assistant' && message.status !== 'pending') {
      actions.append(button(message.status === 'ok' ? 'Regenerate' : 'Retry', () => submit({ regenerate_message_id: message.id })));
      if (message.status === 'ok') {
        for (const [label, rating] of [['Helpful', 1], ['Not helpful', -1]]) actions.append(button(label, () => action(async () => { await api('/api/feedback', { method: 'POST', body: { message_id: message.id, rating } }); showNotice('Feedback saved.'); })));
        if ('speechSynthesis' in window) actions.append(button('Read aloud', () => readAloud(message)));
      }
    }
    actions.querySelectorAll('button').forEach(b => b.disabled = !!flight); el.append(actions); return el;
  }
  function renderExtras(messages) {
    panels.activity.replaceChildren(); panels.code.replaceChildren(); let activityCount = 0, codeCount = 0;
    for (const message of messages.filter(m => m.role === 'assistant')) {
      if (message.events.length) {
        const log = node('ul', 'tool-log'), group = node('section', 'activity-group'); group.append(node('h3', '', 'Tool activity')); renderTools(log, message.events); group.append(log); panels.activity.append(group); activityCount += message.events.length;
        for (const event of message.events) if (typeof event.code === 'string') { const group = node('section', 'activity-group'); group.append(node('h3', '', event.ok ? 'Executed Python' : 'Python attempt'), codeBlock(event.code, 'python')); if (event.output) group.append(codeBlock(String(event.output), 'output')); panels.code.append(group); codeCount++; }
      }
      for (const match of message.text.matchAll(/```([^\n`]*)\n([\s\S]*?)```/g)) { const group = node('section', 'activity-group'); group.append(node('h3', '', message.status === 'ok' ? 'Code from answer' : 'Code from partial answer'), codeBlock(match[2], match[1])); panels.code.append(group); codeCount++; }
    }
    if (!activityCount) panels.activity.append(node('p', 'workspace-empty', 'Tool steps and sources appear here when Artemis uses a permitted tool.'));
    if (!codeCount) panels.code.append(node('p', 'workspace-empty', 'Code from answers and Python output appear here.'));
  }
  function render() {
    box.replaceChildren(); const messages = branchMessages();
    if (!messages.length) {
      const welcome = node('div', 'workspace-welcome'), prompts = node('div', 'workspace-prompts');
      welcome.append(node('span', 'eyebrow', 'YOUR ARTEMIS WORKSPACE'), node('h2', '', 'What would you like to work on?'), node('p', '', user ? 'Start a conversation. Your messages, branches, and results stay in your account.' : 'Sign in to start a private conversation and continue it on another device.'));
      for (const [label, text] of [['Write & explain code', 'Help me write and explain a Python function.'], ['Research a question', 'Search for current Python documentation and cite your sources.'], ['Work through a problem', 'Help me break down a problem into clear steps.'], ['Run a calculation', 'Use Python to calculate the sum of squares from 1 to 20.']]) prompts.append(button(label, () => { if (!user) { openAuth(); return; } input.value = text; input.focus(); }));
      welcome.append(prompts); if (!user) welcome.append(button('Sign in / create account', openAuth, 'btn btn-primary')); welcome.append(waitlist); box.append(welcome);
    } else for (const message of messages) box.append(messageElement(message));
    renderExtras(messages); renderBranches(); renderList(); selectPanel(selected); controls();
  }
  async function submit(fields) {
    if (!user) { openAuth(); return; } if (flight) return;
    if (!active) {
      flight = { delivering: true }; controls();
      try { const conversation = await api('/api/conversations', { method: 'POST', body: {} }); active = normalize(await api('/api/conversations/' + conversation.id)); head = null; }
      finally { flight = null; controls(); }
    }
    const cid = active.id, saved = pending[cid];
    if (saved && JSON.stringify(saved.text) !== JSON.stringify(fields.text)) { showNotice('An earlier request has uncertain delivery. Retry that request before sending different input.', button('Retry delivery', () => submit(saved))); return; }
    const payload = saved || { ...fields, model: chosenModel, head_id: head, idempotency_key: crypto.randomUUID() };
    pending[cid] = payload; saveDrafts(); flight = { delivering: true }; controls(); showNotice('Connecting…');
    try {
      let result;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { result = await api('/api/conversations/' + cid + '/messages', { method: 'POST', body: payload }); break; }
        catch (error) { if (error.code || attempt) throw error; }
      }
      delete pending[cid]; drafts[cid] = ''; input.value = ''; saveDrafts();
      flight = null; active = normalize(await api('/api/conversations/' + cid)); head = result.assistant_message_id; await refreshList(); render();
      await watch(result.request_id, result.assistant_message_id);
    } catch (error) {
      if (error.code) delete pending[cid];
      showNotice(error.message + (!error.code ? ' Delivery is uncertain; retry uses the same request ID.' : ''));
      flight = null; controls(); saveDrafts();
    }
  }
  async function watch(rid, mid) {
    if (flight || !active) return;
    const cid = active.id, account = user.id, ctrl = new AbortController(); flight = { id: rid, ctrl }; controls();
    const message = active.messages.find(m => m.id === mid); if (!message) { flight = null; controls(); return; }
    head = mid; message.events = []; let cursor = 0, text = '', terminal = false, retries = 0;
    const onEvent = event => {
      if (event.seq <= cursor || terminal) return; cursor = event.seq || cursor;
      if (event.type === 'token') { text += event.text; message.text = text; }
      else if (event.type === 'replace') { text = event.text; message.text = text; }
      else if (event.type === 'tool_call') message.events.push({ name: event.name, pending: true, summary: event.name + ' · running' });
      else if (event.type === 'tool_result') { const i = message.events.findLastIndex(e => e.pending && e.name === event.name); const result = { ...event, pending: false }; if (i >= 0) message.events[i] = result; else message.events.push(result); }
      else if (event.type === 'state') { message.state = event.state; showNotice(event.state === 'queued' ? 'Queued — your message is saved.' : event.state === 'stopping' ? 'Stopping generation…' : 'Generating…'); }
      else if (event.type === 'done' || event.type === 'error') { terminal = true; message.text = event.answer || text; message.state = event.state; message.status = event.type === 'done' ? 'ok' : 'error'; message.error = event.message; showNotice(event.type === 'done' ? 'Saved.' : event.message); }
      render(); box.scrollTop = box.scrollHeight;
    };
    try {
      while (!terminal && !ctrl.signal.aborted && retries < 8) {
        try {
          const response = await fetch('/api/requests/' + rid + '/events?after=' + cursor, { credentials: 'same-origin', headers: { Accept: 'text/event-stream' }, signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(35000)]) });
          if (!response.ok) { const result = await response.json(); const error = new Error(result.error || 'Unable to reconnect.'); error.code = response.status; throw error; }
          await ArtemisStream.readEvents(response.body, onEvent);
          retries = 0;
        } catch (error) {
          if (error.code === 401 || error.code === 404 || ctrl.signal.aborted) throw error;
          retries++; showNotice('Reconnecting… Partial output is saved on the server.');
          await new Promise(resolve => setTimeout(resolve, Math.min(250 * 2 ** retries, 3000)));
        }
      }
      if (!terminal && !ctrl.signal.aborted) showNotice('Connection lost. Your request and partial reply are saved.', button('Reconnect', () => watch(rid, mid)));
    } catch (error) { if (!ctrl.signal.aborted) showNotice(error.message); }
    finally {
      flight = null;
      if (user?.id === account && active?.id === cid) {
        try { active = normalize(await api('/api/conversations/' + cid)); head = mid; } catch {}
        render(); saveDrafts();
      }
    }
  }
  async function stop() {
    if (!flight?.id) return; const rid = flight.id; send.disabled = true;
    await action(async () => { await api('/api/requests/' + rid + '/cancel', { method: 'POST', body: {} }); showNotice('Stopping… Partial output will be retained.'); });
  }
  form.addEventListener('submit', event => { event.preventDefault(); const text = input.value.trim(); if (text) action(() => submit({ text })); });
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } });
  send.addEventListener('click', () => { if (flight) stop(); });

  // Account credentials are sent only to same-origin login endpoints and cleared from the form.
  const accountPage = document.getElementById('account-page-content'), accountNav = document.getElementById('accountNav'), authForm = node('form', 'auth-card'), authTitle = node('h2', '', 'Sign in to Artemis'); authTitle.id = 'auth-title';
  authForm.setAttribute('aria-labelledby', authTitle.id); let signup = false, authReady = false;
  const email = node('input'), password = node('input'), authError = node('p', 'message-error'); authError.setAttribute('role', 'alert');
  email.type = 'email'; email.required = true; email.autocomplete = 'username'; email.id = 'account-email';
  password.type = 'password'; password.required = true; password.minLength = 12; password.maxLength = 256; password.autocomplete = 'current-password'; password.id = 'account-password';
  const emailLabel = node('label', '', 'Email'); emailLabel.htmlFor = email.id; const passwordLabel = node('label', '', 'Password (12+ characters)'); passwordLabel.htmlFor = password.id;
  const authSubmit = node('button', 'btn btn-primary', 'Sign in'); authSubmit.type = 'submit'; authSubmit.disabled = true; authForm.setAttribute('aria-busy', 'true'); authError.textContent = 'Checking sign-in availability…';
  const authSwitch = button('Create an account', () => { signup = !signup; authTitle.textContent = signup ? 'Create your Artemis account' : 'Sign in to Artemis'; authSubmit.textContent = signup ? 'Create account' : 'Sign in'; authSwitch.textContent = signup ? 'Already have an account? Sign in' : 'Create an account'; password.autocomplete = signup ? 'new-password' : 'current-password'; if (authReady) authError.textContent = ''; });
  authForm.append(authTitle, emailLabel, email, passwordLabel, password, authError, authSubmit, authSwitch, button('Back to Chat', () => document.querySelector('#navLinks [data-go=chat]').click())); accountPage.append(authForm);
  const accountSummary = node('div', 'auth-card'), accountEmail = node('p'); accountSummary.append(node('h2', '', 'Welcome back'), accountEmail, button('Open Chat', () => document.querySelector('#navLinks [data-go=chat]').click(), 'btn btn-primary'), button('Account settings', () => authButton.click())); accountSummary.hidden = true; accountPage.append(accountSummary);
  function accountState() { authForm.hidden = !!user; accountSummary.hidden = !user; accountNav.textContent = user ? 'Account' : 'Sign in'; accountEmail.textContent = user ? 'Signed in as ' + user.email : ''; }
  function openAuth() { accountNav.click(); email.focus(); }
  authForm.addEventListener('submit', async event => {
    event.preventDefault(); if (!authReady) return; authSubmit.disabled = true;
    try { const response = await api('/api/auth/' + (signup ? 'signup' : 'login'), { method: 'POST', body: { email: email.value, password: password.value } }); if (!response.user?.id || !response.user?.csrf) throw new Error('Sign-in could not be verified. Please try again later.'); user = response.user; accountState(); await signedIn(); document.querySelector('#navLinks [data-go=chat]').click(); }
    catch (error) { authError.textContent = error.message; }
    finally { password.value = ''; authSubmit.disabled = false; }
  });
  async function signedIn() {
    accountState();
    drafts = {}; pending = {};
    try { const cache = JSON.parse(localStorage.getItem('artemis.drafts.' + user.id) || '{}'); drafts = cache.drafts || {}; pending = cache.pending || {}; } catch {}
    await refreshList();
    if (conversations.length) await openConversation(conversations[0].id); else { active = null; render(); }
    authButton.textContent = 'Account'; showNotice('Signed in. Conversations are saved to your account.');
  }
  // Settings. Sectioned the way a customer expects to find things: who they are and
  // what they pay for, what today has spent against the plan, what the plan includes,
  // what we keep, and how the app looks. Every number is a real meter reading from
  // /api/usage - a settings screen that guesses is worse than none.
  const accountDialog = node('dialog', 'workspace-dialog workspace-settings'), accountTitle = node('h2', '', 'Settings'); accountTitle.id = 'account-title'; accountDialog.setAttribute('aria-labelledby', accountTitle.id);
  const retention = node('select'); retention.setAttribute('aria-label', 'Conversation retention');
  for (const [value, label] of [[0, 'Keep until I delete'], [30, 'Delete after 30 inactive days'], [90, 'Delete after 90 inactive days'], [365, 'Delete after one inactive year']]) { const option = node('option', '', label); option.value = value; retention.append(option); }

  function settingsSection(title) { const s = node('section', 'settings-section'); s.append(node('h3', '', title)); return s; }
  function settingsRow(label, value) {
    const row = node('div', 'settings-row');
    row.append(node('span', '', label), typeof value === 'string' ? node('span', 'settings-value', value) : value);
    return row;
  }
  function meter(used, limit) {
    // An unlimited allowance has no bar to fill: say so rather than draw a full one.
    if (limit === null || limit === undefined) return node('span', 'settings-value', used + ' used · unlimited');
    const wrap = node('div', 'settings-meter'), bar = node('div', 'settings-meter-fill');
    const share = limit > 0 ? Math.min(1, used / limit) : 0;
    bar.style.width = (share * 100).toFixed(1) + '%';
    if (share >= 1) bar.dataset.state = 'full';
    wrap.append(bar); wrap.title = used + ' of ' + limit;
    const box = node('div', 'settings-meter-box');
    box.append(node('span', 'settings-value', used + ' / ' + limit), wrap);
    return box;
  }

  const accountSection = settingsSection('Account'), usageSection = settingsSection('Usage');
  const capabilitySection = settingsSection("What your plan includes");
  async function loadSettings() {
    const [settings, entitlements] = await Promise.all([
      api('/api/settings'),
      api('/api/usage').catch(() => null),
    ]);
    retention.value = settings.retention_days;

    accountSection.replaceChildren(node('h3', '', 'Account'));
    accountSection.append(settingsRow('Signed in as', (user && user.email) || '—'));
    usageSection.replaceChildren(node('h3', '', 'Usage'));
    capabilitySection.replaceChildren(node('h3', '', "What your plan includes"));
    if (!entitlements) {
      usageSection.append(node('p', 'session-note', 'Usage is unavailable right now.'));
      return;
    }
    const plan = entitlements.plan;
    const price = plan.price_usd_month != null ? '$' + plan.price_usd_month + ' a month'
      : plan.price_usd_seat_month != null ? '$' + plan.price_usd_seat_month + ' per seat a month' : '';
    accountSection.append(settingsRow('Plan', plan.id + (price ? ' · ' + price : '')));
    const comparePlans = node('a', 'settings-link', 'Compare plans'); comparePlans.href = '../#pricing';
    accountSection.append(comparePlans);

    for (const item of entitlements.usage) {
      usageSection.append(settingsRow(item.label + ' ' + item.period, meter(item.used, item.limit)));
    }
    usageSection.append(node('p', 'session-note', 'Daily allowances reset at 00:00 UTC.'));

    const models = node('ul', 'settings-list');
    for (const m of entitlements.capabilities.models) {
      const li = node('li', '', m.display + (m.external ? ' · third party' : '') + (m.available ? '' : ' · unavailable'));
      models.append(li);
    }
    capabilitySection.append(settingsRow('Models', ''), models);
    capabilitySection.append(settingsRow('Tools', entitlements.capabilities.tools.join(', ') || 'None on this plan'));
    capabilitySection.append(settingsRow('Specialist brains', String(entitlements.capabilities.brains.length)));
    capabilitySection.append(settingsRow('API access', entitlements.capabilities.api_access ? 'Included' : 'Not on this plan'));
  }

  // Appearance. The stylesheet already defines both themes and honours data-theme, so
  // this only has to record the choice; "System" removes it and follows the device.
  const appearance = node('div', 'settings-appearance');
  function applyTheme(value) {
    if (value === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = value;
    try { localStorage.setItem('artemis.theme', value); } catch {}
    for (const b of appearance.children) b.setAttribute('aria-pressed', String(b.dataset.theme === value));
  }
  for (const [value, label] of [['light', 'Light'], ['dark', 'Dark'], ['system', 'System']]) {
    const b = button(label, () => applyTheme(value), 'settings-theme'); b.dataset.theme = value; appearance.append(b);
  }
  let startTheme = 'system';
  try { startTheme = localStorage.getItem('artemis.theme') || 'system'; } catch {}
  applyTheme(startTheme);

  const privacySection = settingsSection('Privacy and data');
  privacySection.append(node('p', '', 'Conversations are not automatically used to train Artemis. Raw audio recording and file uploads are not enabled.'),
    node('label', '', 'Conversation retention'), retention,
    button('Save retention', () => action(async () => { await api('/api/settings', { method: 'PATCH', body: { retention_days: Number(retention.value) } }); showNotice('Retention setting saved.'); })),
    node('p', 'session-note', 'Deletion removes live database records. Hosting backups require a separate expiry policy.'),
    button('Export this conversation (JSON)', () => exportConversation('json')), button('Export this conversation (Markdown)', () => exportConversation('markdown')),
    button('Export my account', () => action(async () => download(await api('/api/account/export'), 'artemis-account.json'))));

  const appearanceSection = settingsSection('Appearance'); appearanceSection.append(appearance);

  accountDialog.append(accountTitle, accountSection, usageSection, capabilitySection, privacySection, appearanceSection,
    button('Sign out', () => action(async () => { if (flight?.id) await api('/api/requests/' + flight.id + '/cancel', { method: 'POST', body: {} }); flight?.ctrl?.abort(); saveDrafts(); stopSpeech(); await api('/api/auth/logout', { method: 'POST', body: {} }); user = active = flight = null; conversations = []; drafts = pending = {}; input.value = ''; accountDialog.close(); signup = false; authTitle.textContent = 'Sign in to Artemis'; authSubmit.textContent = 'Sign in'; authSwitch.textContent = 'Create an account'; password.autocomplete = 'current-password'; authError.textContent = ''; accountState(); showNotice('Signed out.'); render(); })),
    button('Close', () => accountDialog.close())); document.body.append(accountDialog);
  authButton.addEventListener('click', () => { if (user) action(loadSettings); });
  function download(value, name, type = 'application/json') { const blob = new Blob([typeof value === 'string' ? value : JSON.stringify(value, null, 2)], { type }), url = URL.createObjectURL(blob), a = node('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  function exportConversation(format) { action(async () => { if (!active) throw new Error('Open a conversation first.'); const value = await api('/api/conversations/' + active.id + '/export?format=' + format); if (format === 'markdown') download(value.content, value.filename, 'text/markdown'); else download(value, 'artemis-conversation.json'); }); }

  // Browser read-aloud is separate from the Artemis text model. No audio recording or transcription is implied.
  const voiceBar = node('div', 'workspace-voice'), voiceSelect = node('select'); voiceSelect.setAttribute('aria-label', 'Read-aloud voice');
  function voiceEvent(kind, message, voice) { if (user && message) api('/api/conversations/' + message.conversation_id + '/voice', { method: 'POST', body: { kind, message_id: message.id, voice: voice || '' } }).catch(() => {}); }
  function stopSpeech() { if ('speechSynthesis' in window) { if (speechMessage) voiceEvent('stop', speechMessage, voiceSelect.value); speechSynthesis.cancel(); } speech = speechMessage = null; }
  function readAloud(message) {
    stopSpeech(); speechMessage = message; speech = new SpeechSynthesisUtterance(message.text); speech.voice = speechSynthesis.getVoices().find(v => v.name === voiceSelect.value) || null;
    speech.onend = () => { voiceEvent('end', message, voiceSelect.value); speech = speechMessage = null; };
    speech.onerror = () => { voiceEvent('error', message, voiceSelect.value); showNotice('Read-aloud is unavailable. Text chat is still available.'); speech = speechMessage = null; };
    voiceEvent('play', message, voiceSelect.value); speechSynthesis.speak(speech);
  }
  if ('speechSynthesis' in window) {
    const voices = () => { const previous = voiceSelect.value; voiceSelect.replaceChildren(node('option', '', 'Default voice')); for (const voice of speechSynthesis.getVoices()) { const option = node('option', '', voice.name + ' · ' + voice.lang); option.value = voice.name; voiceSelect.append(option); } if (previous) voiceSelect.value = previous; };
    voices(); speechSynthesis.addEventListener('voiceschanged', voices);
    voiceBar.append(voiceSelect, button('Pause', () => { speechSynthesis.pause(); voiceEvent('pause', speechMessage, voiceSelect.value); }), button('Resume', () => { speechSynthesis.resume(); voiceEvent('resume', speechMessage, voiceSelect.value); }), button('Stop / mute', stopSpeech)); composer.append(voiceBar);
  }
  document.querySelectorAll('[data-workspace-panel]').forEach(element => element.addEventListener('click', () => selectPanel(element.dataset.workspacePanel)));
  selectPanel('chat');
  const requestedPanel = new URLSearchParams(location.search).get('panel');
  if (requestedPanel && Object.prototype.hasOwnProperty.call(panels, requestedPanel)) selectPanel(requestedPanel);
  render();
  loadModels();
  api('/api/status').then(info => { model.textContent = info.model || 'Artemis'; status.textContent = info.serving ? 'Model connected' : info.status === 'unavailable' ? 'Model unavailable' : 'Model not ready'; status.dataset.state = info.serving ? 'available' : 'unavailable'; status.title = 'Availability does not certify answer quality.'; }).catch(() => { status.textContent = 'Connection unavailable'; });
  const retrySignIn = button('Check connection again', () => checkAccountService()); retrySignIn.hidden = true; authForm.append(retrySignIn);
  async function checkAccountService() {
    authReady = false; authSubmit.disabled = true; retrySignIn.disabled = true; authForm.setAttribute('aria-busy', 'true'); authError.textContent = 'Checking sign-in availability…';
    try {
      const response = await api('/api/me');
      if (!Object.hasOwn(response, 'user') || (response.user && (!response.user.id || !response.user.csrf))) throw new Error('Invalid session response.');
      user = response.user; authReady = true; authError.textContent = ''; retrySignIn.hidden = true;
      loadModels();   // the plan, and so the models offered, depend on who is signed in
      if (user) await signedIn(); else { accountState(); render(); }
    } catch {
      authError.textContent = 'Sign-in is temporarily unavailable. Please try again later.'; retrySignIn.hidden = false;
      showNotice('Sign-in is temporarily unavailable. Please try again later.');
    } finally { authSubmit.disabled = !authReady; retrySignIn.disabled = false; authForm.setAttribute('aria-busy', 'false'); }
  }
  checkAccountService();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();

