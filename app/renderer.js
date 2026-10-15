/* Onyx app. The same page runs in the desktop window (Electron, with
 * window.onyx) and on your phone (served by the core over Wi-Fi). */

;(() => {
  const isDesktop = typeof window.onyx !== 'undefined'
  const params = new URLSearchParams(location.search)
  // The desktop runs this page twice: as the corner widget and as the full app.
  const isWidget = isDesktop && params.get('mode') === 'widget'
  if (!isDesktop) document.body.classList.add('web')
  if (isWidget) document.body.classList.add('widget', 'collapsed')

  const $ = (sel, root = document) => root.querySelector(sel)
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]
  const feed = $('#feed')
  const input = $('#input')

  let ws = null
  let clientId = null
  let connected = false
  let retry = 0
  let settings = null
  let page = 'chat'
  const turns = new Map()
  const cards = new Map()

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const icon = (name) => `<svg><use href="#i-${name}"/></svg>`
  const el = (tag, cls, html) => {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (html != null) e.innerHTML = html
    return e
  }

  /** A small, safe subset of markdown: everything is escaped first. */
  function md(text) {
    let html = ''
    let list = false
    for (const raw of esc(String(text).trim()).split('\n')) {
      const line = raw
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
        .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>')
      const b = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/)
      if (b) {
        if (!list) (html += '<ul>'), (list = true)
        html += `<li>${b[1]}</li>`
        continue
      }
      if (list) (html += '</ul>'), (list = false)
      if (line.trim()) html += `<p>${line.replace(/^#{1,6}\s+/, '')}</p>`
    }
    return html + (list ? '</ul>' : '')
  }

  // ---------------------------------------------------------------- connection

  async function connectionInfo() {
    if (isDesktop) {
      const c = await window.onyx.connection()
      return { url: `ws://127.0.0.1:${c.port}/ws`, token: c.token, hotkey: c.hotkey }
    }
    // The pairing link carries the key in the #fragment, which the browser
    // never sends to a server. Remember it on this phone.
    const m = location.hash.match(/t=([0-9a-f]+)/)
    let token = m ? m[1] : null
    try {
      if (token) localStorage.setItem('onyx-token', token)
      else token = localStorage.getItem('onyx-token')
    } catch {}
    if (m) history.replaceState(null, '', location.pathname)
    return { url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`, token }
  }

  async function connect() {
    let info
    try {
      info = await connectionInfo()
    } catch {
      return setBrain('bad', 'Onyx is not running')
    }
    if (!info.token) return setBrain('bad', 'Pair from the Onyx app on your PC')
    if (info.hotkey) $('#hotkeys').textContent = `Open Onyx: ${info.hotkey} · Stop everything: Ctrl+Alt+Esc`
    ws = new WebSocket(info.url)
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token: info.token, role: isDesktop ? 'app' : 'mobile' }))
    ws.onmessage = (e) => handle(JSON.parse(e.data))
    ws.onclose = (e) => {
      connected = false
      if (e.code === 4003) return setBrain('bad', 'Wrong key: pair again')
      setBrain('bad', 'Reconnecting…')
      setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++))
    }
  }

  const send = (m) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m))
  }

  // ---------------------------------------------------------------- status

  function setBrain(kind, text) {
    const p = $('#pill-brain')
    p.className = `pill ${kind}`
    $('span', p).textContent = text
    p.title = text
  }

  function setBusy(busy, queued = 0) {
    document.body.classList.toggle('busy', busy)
    $('#wstatus').textContent = busy ? 'Working…' : ''
    const t = $('#title-status')
    t.className = `title-status${busy ? ' busy' : ''}`
    t.textContent = busy ? (queued ? `Working… ${queued} queued` : 'Working…') : ''
    for (const tr of turns.values()) if (!busy) tr.box?.classList.remove('running')
  }

  function setVoice(v) {
    const p = $('#pill-voice')
    if (!v) return
    p.className = `pill ${v.running ? 'live' : ''}`
    $('span', p).textContent = v.running ? `"hey onyx" · ${v.pushToTalk}` : v.enabled ? 'voice starting…' : 'voice off'
  }

  function toast(title, body) {
    const t = el('div', 'toast', `<b>${esc(title)}</b><span>${esc(body)}</span>`)
    $('#toasts').appendChild(t)
    setTimeout(() => t.remove(), 6000)
  }

  // ---------------------------------------------------------------- navigation

  function go(name) {
    page = name
    $$('.nav').forEach((n) => n.classList.toggle('on', n.dataset.page === name))
    $$('.page').forEach((p) => p.classList.toggle('on', p.id === `page-${name}`))
    if (name === 'activity') send({ type: 'log', limit: 300 })
    if (name === 'tasks') send({ type: 'tasks' })
    if (name === 'phone' || name === 'settings') send({ type: 'settings' })
    if (name === 'phone') loadPair()
    if (name === 'chat') input.focus()
  }
  $$('.nav').forEach((n) => n.addEventListener('click', () => go(n.dataset.page)))

  const pendingCount = () => [...cards.values()].filter((c) => !c.classList.contains('done')).length

  function pendingBadge() {
    const n = pendingCount()
    $('.orb-badge').textContent = n || ''
    const chat = $('.nav[data-page=chat]')
    let b = $('.badge', chat)
    if (!n) return b?.remove()
    if (!b) chat.appendChild((b = el('span', 'badge')))
    b.textContent = n
  }

  // ---------------------------------------------------------------- chat

  function append(node) {
    $('#empty')?.remove()
    const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120
    feed.appendChild(node)
    if (atBottom) feed.scrollTop = feed.scrollHeight
  }
  const follow = () => {
    if (feed.scrollHeight - feed.scrollTop - feed.clientHeight < 200) feed.scrollTop = feed.scrollHeight
  }

  function userBubble(text, source) {
    const u = el('div', 'msg user')
    if (source) u.appendChild(el('span', 'src', esc(source === 'voice' ? '🎙 voice' : source)))
    u.appendChild(el('div', 'bubble', esc(text)))
    append(u)
  }

  function startTurn(m) {
    if (!m.background && m.clientId !== clientId && m.text) userBubble(m.text, m.source)
    const msg = el('div', 'msg onyx')
    msg.innerHTML = `<div class="avatar"><img src="icon.png" alt=""></div><div class="body"></div>`
    const body = $('.body', msg)
    if (m.background) body.appendChild(el('div', 'task-label', esc(m.text)))
    const text = el('div', 'text thinking')
    body.appendChild(text)
    append(msg)
    const t = { msg, body, text, raw: '', box: null, list: null, toggle: null, steps: new Map(), count: 0 }
    turns.set(m.turn, t)
    return t
  }
  const turnOf = (id) => turns.get(id) ?? startTurn({ turn: id, clientId, text: '' })

  function addStep(m) {
    const t = turnOf(m.turn)
    if (!t.box) {
      t.box = el('div', 'steps-box running')
      t.toggle = el('button', 'steps-toggle')
      t.toggle.type = 'button'
      t.toggle.addEventListener('click', () => {
        t.box.classList.toggle('open')
        updateToggle(t)
      })
      t.list = el('ol', 'steps')
      t.box.append(t.toggle, t.list)
      t.body.insertBefore(t.box, t.text)
    }
    const li = el('li', 'step run', `<span class="st"></span><span class="lbl">${esc(m.label)}</span><span class="out"></span>`)
    li.title = m.name
    $('.lbl', li).addEventListener('click', () => li.classList.toggle('expanded'))
    t.list.appendChild(li)
    t.steps.set(m.id, li)
    t.count++
    t.box.classList.add('running')
    updateToggle(t)
    follow()
  }

  function updateToggle(t) {
    const open = t.box.classList.contains('open')
    const done = [...t.steps.values()].filter((s) => !s.classList.contains('run')).length
    t.toggle.innerHTML = `${icon('chevron')}<span>${t.count} step${t.count > 1 ? 's' : ''}${done < t.count ? ` · ${done} done` : ''}${open ? '' : t.count > 1 ? ' · show all' : ''}</span>`
  }

  function stepDone(m) {
    const t = turns.get(m.turn)
    const li = t?.steps.get(m.id)
    if (!li) return
    li.classList.remove('run')
    li.classList.add(m.ok ? 'ok' : 'fail')
    $('.st', li).innerHTML = icon(m.ok ? 'check' : 'x')
    if (m.summary) $('.out', li).textContent = m.summary
    updateToggle(t)
  }

  function addText(m) {
    const t = turnOf(m.turn)
    t.raw += m.delta
    t.text.innerHTML = md(t.raw)
    t.text.classList.add('thinking')
    follow()
  }

  function finish(m) {
    const t = turns.get(m.turn)
    if (!t) return
    if (!t.raw.trim() && m.text) t.text.innerHTML = md(m.text)
    t.text.classList.remove('thinking')
    t.box?.classList.remove('running')
    if (!t.raw.trim() && !m.text && !t.count) t.text.innerHTML = '<p class="muted">Done.</p>'
  }

  function addError(m) {
    if (m.turn) {
      const t = turnOf(m.turn)
      t.text.classList.remove('thinking')
      t.box?.classList.remove('running')
      t.body.appendChild(el('div', 'error', esc(m.message)))
    } else {
      toast('Onyx', m.message)
    }
  }

  const sys = (text) => append(el('div', 'sys', esc(text)))

  function mustStay() {
    pendingBadge()
    if (isDesktop) window.onyx.mustStay([...cards.values()].some((c) => !c.classList.contains('done')))
  }

  function approvalCard(m) {
    if (cards.has(m.id)) return
    const danger = m.risk === 'danger'
    const c = el('div', `card${danger ? ' danger' : ''}`)
    c.innerHTML = `
      <div class="head">${danger ? '⚠ Needs your OK: hard to undo' : 'Onyx wants to'}${m.background ? ' · scheduled task' : ''}</div>
      <div class="what">${esc(m.label)}</div>
      <div class="actions">
        <button class="primary${danger ? ' danger-btn' : ''}" data-a="allow">Allow</button>
        ${danger ? '' : '<button class="ghost" data-a="allow_turn">Allow for this task</button>'}
        ${m.canAlways ? '<button class="ghost" data-a="always">Always allow</button>' : ''}
        <button class="ghost" data-a="deny">Deny</button>
      </div>
      <div class="answer"></div>`
    $$('button', c).forEach((b) => b.addEventListener('click', () => send({ type: 'approve', id: m.id, answer: b.dataset.a })))
    cards.set(m.id, c)
    append(c)
    mustStay()
    if (isDesktop) window.onyx.notify('Onyx needs your OK', m.label)
    if (page !== 'chat') toast('Onyx needs your OK', m.label)
  }

  function questionCard(m) {
    if (cards.has(m.id)) return
    const c = el('div', 'card')
    c.innerHTML = `
      <div class="head">Onyx asks</div>
      <div class="what">${esc(m.question)}</div>
      <div class="actions">
        ${(m.choices || []).map((ch, i) => `<button class="ghost" data-i="${i}">${esc(ch)}</button>`).join('')}
        <input placeholder="Type an answer…" />
        <button class="primary" data-send="1">Send</button>
      </div>
      <div class="answer"></div>`
    const field = $('input', c)
    const answer = (text) => text && send({ type: 'answer', id: m.id, text })
    $$('button[data-i]', c).forEach((b) => b.addEventListener('click', () => answer(m.choices[Number(b.dataset.i)])))
    $('button[data-send]', c).addEventListener('click', () => answer(field.value.trim()))
    field.addEventListener('keydown', (e) => e.key === 'Enter' && answer(field.value.trim()))
    cards.set(m.id, c)
    append(c)
    mustStay()
    if (isDesktop) window.onyx.notify('Onyx has a question', m.question)
  }

  function closeCard(id, answer) {
    const c = cards.get(id)
    if (!c) return
    c.classList.add('done')
    const labels = { allow: 'Allowed', allow_turn: 'Allowed for this task', always: 'Always allowed', deny: 'Denied' }
    $('.answer', c).textContent = labels[answer] ?? 'Answered'
    mustStay()
  }

  // ---------------------------------------------------------------- composer

  function submit(text) {
    text = (text ?? input.value).trim()
    if (!text) return
    if (!connected) return toast('Onyx', 'Not connected yet.')
    userBubble(text)
    feed.scrollTop = feed.scrollHeight
    send({ type: 'ask', text })
    input.value = ''
    autosize()
  }
  function autosize() {
    input.style.height = 'auto'
    input.style.height = Math.min(180, input.scrollHeight) + 'px'
  }
  input.addEventListener('input', autosize)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      submit()
    }
  })
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault()
    submit()
  })
  $$('.chips button').forEach((b) => b.addEventListener('click', () => submit(b.textContent)))
  $('#mic').addEventListener('click', () => {
    send({ type: 'listen' })
    const mic = $('#mic')
    mic.classList.add('listening')
    $('#pill-voice').classList.add('listening')
    setTimeout(() => {
      mic.classList.remove('listening')
      $('#pill-voice').classList.remove('listening')
    }, 6000)
  })
  $('#stop').addEventListener('click', () => send({ type: 'stop' }))
  $('#new-chat').addEventListener('click', () => send({ type: 'reset' }))
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isDesktop && page === 'chat' && document.activeElement === input && !input.value) window.onyx.hide()
  })

  // On the phone there is no sidebar footer: put Stop in the top bar.
  if (!isDesktop) {
    const b = el('button', 'web-stop', 'Stop')
    b.addEventListener('click', () => send({ type: 'stop' }))
    $('#titlebar').appendChild(b)
  }

  // ---------------------------------------------------------------- activity

  const KIND_ICON = { turn: 'chat', tool: 'chevron', result: 'check', turn_end: 'check', stop: 'stop', 'sms-sync': 'phone' }

  function renderLog(entries) {
    const box = $('#log')
    box.innerHTML = ''
    const rows = entries.filter((e) => e.kind !== 'result').reverse()
    if (!rows.length) return (box.innerHTML = '<div class="empty-note">Nothing yet today. Ask Onyx to do something.</div>')
    for (const e of rows) {
      const time = new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      let main = ''
      let sub = ''
      let cls = ''
      if (e.kind === 'turn') {
        main = esc(String(e.input ?? '').slice(0, 200))
        sub = esc(e.source ?? '')
        cls = 'turn'
      } else if (e.kind === 'tool') {
        main = `${esc(e.tool)}${e.risk && e.risk !== 'read' ? `<span class="tag${e.risk === 'danger' ? ' danger' : ''}">${esc(e.risk)}</span>` : ''}${/den/.test(e.decision ?? '') ? '<span class="tag danger">denied</span>' : ''}`
        sub = esc(String(e.input ?? '').slice(0, 220))
        if (/den/.test(e.decision ?? '')) cls = 'bad'
      } else if (e.kind === 'turn_end') {
        main = e.ok ? 'Finished' : 'Ended with an error'
        sub = esc(String(e.result ?? '').slice(0, 220))
        if (!e.ok) cls = 'bad'
      } else if (e.kind === 'stop') {
        main = 'Stopped'
        sub = esc(e.reason ?? '')
        cls = 'bad'
      } else {
        main = esc(e.kind)
        sub = esc(String(e.result ?? '').slice(0, 220))
      }
      box.appendChild(el('div', `log-row ${cls}`, `<span class="t">${time}</span><span class="k">${icon(KIND_ICON[e.kind] ?? 'chevron')}</span><div class="main">${main}${sub ? `<div class="sub">${sub}</div>` : ''}</div>`))
    }
  }
  $('#log-refresh').addEventListener('click', () => send({ type: 'log', limit: 300 }))

  // ---------------------------------------------------------------- tasks

  function renderTasks(tasks) {
    const box = $('#tasks')
    box.innerHTML = ''
    if (!tasks.length) {
      box.innerHTML = '<div class="empty-note">No tasks yet. Try: “Every day at 9pm, tell me what I spent today”, or “When a PDF lands in Downloads, file it into Documents”.</div>'
      return
    }
    for (const t of tasks) {
      const when = t.cron ? `cron ${t.cron}` : t.at ? new Date(t.at).toLocaleString() : `on ${t.trigger}${t.filter ? ` · ${t.filter}` : ''}`
      const c = el('div', `task${t.enabled ? '' : ' off'}`)
      c.innerHTML = `
        <div class="top"><span class="name">${esc(t.name)}</span><span class="when">${esc(when)}</span></div>
        <div class="prompt">${esc(t.prompt.slice(0, 260))}</div>
        <div class="last">${t.next ? `Next: ${esc(new Date(t.next).toLocaleString())}` : t.enabled ? '' : 'Paused'}${t.lastRun ? ` · Last run ${esc(new Date(t.lastRun).toLocaleString())}: ${esc(String(t.lastResult ?? '').slice(0, 140))}` : ''}</div>
        <div class="actions">
          <button class="ghost" data-a="run">${icon('play')}<span>Run now</span></button>
          <button class="ghost" data-a="toggle">${icon(t.enabled ? 'pause' : 'play')}<span>${t.enabled ? 'Pause' : 'Resume'}</span></button>
          <button class="ghost" data-a="delete">${icon('trash')}<span>Delete</span></button>
        </div>`
      $('[data-a=run]', c).addEventListener('click', () => {
        send({ type: 'task_run', id: t.id })
        go('chat')
      })
      $('[data-a=toggle]', c).addEventListener('click', () => send({ type: 'task_toggle', id: t.id, enabled: !t.enabled }))
      $('[data-a=delete]', c).addEventListener('click', () => confirm(`Delete "${t.name}"?`) && send({ type: 'task_delete', id: t.id }))
      box.appendChild(c)
    }
  }

  // ---------------------------------------------------------------- phone

  function renderDevices(devs) {
    const box = $('#devices')
    if (!devs?.length) {
      box.innerHTML = '<div class="device warn"><span class="dot"></span><span>No phone connected</span></div>'
      return
    }
    box.innerHTML = devs
      .map((d) => `<div class="device${d.state === 'device' ? '' : ' warn'}"><span class="dot"></span><span><b>${esc(d.model ?? d.serial)}</b> <span class="muted small">${esc(d.state === 'device' ? 'connected' : d.state === 'unauthorized' ? 'tap Allow on the phone' : d.state)}</span></span></div>`)
      .join('')
  }

  $('#phone-form').addEventListener('submit', (e) => {
    e.preventDefault()
    const address = $('#ph-addr').value.trim()
    if (!address) return ($('#phone-msg').textContent = 'Enter the IP:port shown under Wireless debugging.')
    $('#phone-msg').textContent = 'Connecting…'
    send({ type: 'phone_connect', address, pair_address: $('#ph-pair').value.trim(), code: $('#ph-code').value.trim() })
  })

  async function loadPair() {
    if (!isDesktop) return
    const box = $('#pair')
    try {
      const p = await window.onyx.pair()
      if (!p.lan) {
        box.innerHTML = '<p class="muted small">Chat with Onyx from your phone browser on the same Wi-Fi. Turn on <b>Let my phone use Onyx over Wi-Fi</b> in Settings, restart Onyx, then scan the code that appears here.</p>'
        return
      }
      box.innerHTML = p.urls
        .map((u) => `${p.qr?.[u] ? `<img src="${p.qr[u]}" alt="QR code to open Onyx on your phone">` : ''}<code>${esc(u)}</code>`)
        .join('') + '<p class="muted small">Scan with the phone camera. The link contains your private key: don\'t share it.</p>'
    } catch (err) {
      box.innerHTML = `<p class="error">${esc(err.message)}</p>`
    }
  }

  // ---------------------------------------------------------------- settings

  function renderSettings(s) {
    settings = s
    $$('#seg-approvals button').forEach((b) => b.classList.toggle('on', b.dataset.v === s.approvals))
    const sel = $('#sel-model')
    const opts = [...(s.local.models ?? []).map((m) => ({ v: `local:${m.name}`, t: `${m.name} · ${m.gb} GB · on this PC` })), { v: 'claude:', t: `Claude (${s.claude.model}) · needs Claude Code login` }]
    if (s.brain === 'local' && !opts.some((o) => o.v === `local:${s.local.model}`)) opts.unshift({ v: `local:${s.local.model}`, t: `${s.local.model} (not downloaded)` })
    sel.innerHTML = opts.map((o) => `<option value="${esc(o.v)}">${esc(o.t)}</option>`).join('')
    sel.value = s.brain === 'claude' ? 'claude:' : `local:${s.local.model}`
    $('#tg-think').checked = Boolean(s.local.think)
    $('#tg-think').disabled = s.brain !== 'local'
    $('#tg-voice').checked = Boolean(s.voice.enabled)
    $('#voice-detail').textContent = s.voice.enabled
      ? `${s.voice.running ? 'Listening' : 'Starting'}. Say "hey onyx" (you can add the command in the same breath), press ${s.voice.pushToTalk}, or use the mic button. Runs on this PC; nothing is sent anywhere.`
      : 'Off. Turn on to talk to Onyx.'
    $('#tg-sms').checked = Boolean(s.phone.smsSync)
    $('#tg-lan').checked = Boolean(s.lan.enabled)
    renderDevices(s.phone.devices)
    setVoice(s.voice)
    setBrain('ok', s.brain === 'claude' ? `Claude · ${s.claude.model}` : `${s.local.model} · local`)
  }

  const setSetting = (patch) => send({ type: 'set_settings', patch })
  $$('#seg-approvals button').forEach((b) => b.addEventListener('click', () => setSetting({ approvals: b.dataset.v })))
  $('#sel-model').addEventListener('change', (e) => {
    const [brain, model] = e.target.value.split(':')
    setSetting(brain === 'claude' ? { brain: 'claude' } : { brain: 'local', 'local.model': e.target.value.slice(6) })
  })
  $('#tg-think').addEventListener('change', (e) => setSetting({ 'local.think': e.target.checked }))
  $('#tg-voice').addEventListener('change', (e) => setSetting({ 'voice.enabled': e.target.checked }))
  $('#tg-sms').addEventListener('change', (e) => setSetting({ 'phone.smsSync': e.target.checked }))
  $('#tg-lan').addEventListener('change', (e) => setSetting({ 'lan.enabled': e.target.checked }))
  $$('[data-open]').forEach((b) => b.addEventListener('click', () => send({ type: 'open_path', which: b.dataset.open })))

  // ---------------------------------------------------------------- events

  function handle(m) {
    switch (m.type) {
      case 'welcome':
        clientId = m.clientId
        connected = true
        retry = 0
        send({ type: 'settings' })
        break
      case 'ready':
        setBrain('ok', `${m.model} · ${m.brain === 'local' ? 'local' : 'Claude'}`)
        setBusy(Boolean(m.busy))
        break
      case 'state':
        setBusy(m.busy, m.queued)
        break
      case 'turn_start':
        setBusy(true)
        startTurn(m)
        break
      case 'text':
        addText(m)
        break
      case 'tool':
        addStep(m)
        break
      case 'tool_done':
        stepDone(m)
        break
      case 'done':
        finish(m)
        break
      case 'error':
        addError(m)
        break
      case 'approval':
        approvalCard(m)
        break
      case 'approval_closed':
      case 'question_closed':
        closeCard(m.id, m.answer)
        break
      case 'question':
        questionCard(m)
        break
      case 'notify':
        toast(m.title, m.body)
        if (isDesktop) window.onyx.notify(m.title, m.body)
        break
      case 'stopped':
        sys('Stopped')
        for (const t of turns.values()) {
          t.text.classList.remove('thinking')
          t.box?.classList.remove('running')
        }
        break
      case 'reset':
        feed.innerHTML = ''
        turns.clear()
        sys('New conversation')
        break
      case 'tasks':
        renderTasks(m.tasks)
        break
      case 'log':
        renderLog(m.entries)
        break
      case 'settings':
        renderSettings(m.settings)
        break
      case 'settings_changed':
        send({ type: 'settings' })
        break
      case 'phone_result':
        $('#phone-msg').textContent = m.ok ? String(m.result?.result ?? 'Done') : `Could not connect: ${m.error}`
        break
      case 'shutdown':
        if (isDesktop) window.onyx.quit()
        break
    }
  }

  if (isDesktop) window.onyx.onFocusInput(() => page === 'chat' && input.focus())

  // ---------------------------------------------------------------- widget

  if (isWidget) {
    const expand = (open) => window.onyx.expand(open)
    $('#orb').addEventListener('click', () => expand(true))
    $('#w-min').addEventListener('click', () => expand(false))
    $('#w-app').addEventListener('click', () => window.onyx.openApp('chat'))
    $('#w-settings').addEventListener('click', () => window.onyx.openApp('settings'))
    $('#w-new').addEventListener('click', () => send({ type: 'reset' }))
    $('#w-stop').addEventListener('click', () => send({ type: 'stop' }))
    window.onyx.onWidgetState((open) => {
      document.body.classList.toggle('collapsed', !open)
      if (open) {
        input.focus()
        feed.scrollTop = feed.scrollHeight
      }
    })
    document.addEventListener('keydown', (e) => e.key === 'Escape' && expand(false))
    // Click away and it tucks back into the corner, unless it is working or
    // waiting for your answer.
    window.addEventListener('blur', () => {
      if (!document.body.classList.contains('busy') && !pendingCount()) expand(false)
    })
  } else if (isDesktop) {
    window.onyx.onGoto((p) => go(p))
    if (params.get('page')) go(params.get('page'))
  }
  // Voice state changes on its own (it starts, restarts): keep the pill fresh.
  setInterval(() => connected && send({ type: 'settings' }), 15_000)
  input.focus()
  connect()
})()
