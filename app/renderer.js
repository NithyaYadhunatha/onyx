/* Onyx UI: the same page runs in the desktop window (Electron) and on your
 * phone (served by the core over Wi-Fi). */

;(() => {
  const isDesktop = typeof window.onyx !== 'undefined'
  if (!isDesktop) document.body.classList.add('web')

  const $ = (id) => document.getElementById(id)
  const feed = $('feed')
  const input = $('input')
  const statusEl = $('status')

  let ws = null
  let clientId = null
  let connected = false
  let retry = 0
  const turns = new Map() // turn id -> { el, textEl, toolsEl, raw, tools: Map }
  const cards = new Map() // approval/question id -> element
  let pinned = false

  // ---------------------------------------------------------------- connection

  async function connectionInfo() {
    if (isDesktop) {
      const c = await window.onyx.connection()
      return { url: `ws://127.0.0.1:${c.port}/ws`, token: c.token }
    }
    // Phone: the pairing link carries the token in the #fragment, which the
    // browser never sends to any server. Remember it on this device.
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
    } catch (err) {
      return setStatus('offline', 'core not reachable')
    }
    if (!info.token) return setStatus('offline', 'open the pairing link from the Onyx window on your PC')
    ws = new WebSocket(info.url)
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token: info.token, role: isDesktop ? 'app' : 'mobile' }))
    ws.onmessage = (e) => handle(JSON.parse(e.data))
    ws.onclose = (e) => {
      connected = false
      if (e.code === 4003) return setStatus('offline', 'wrong access key: pair again')
      setStatus('offline', 'reconnecting…')
      setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++))
    }
  }

  const send = (msg) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  function setStatus(kind, text) {
    statusEl.className = `status ${kind}`
    statusEl.textContent = text
  }

  // ---------------------------------------------------------------- rendering

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

  /** A small, safe subset of markdown: everything is escaped first. */
  function md(text) {
    const lines = esc(text.trim()).split('\n')
    let html = ''
    let inList = false
    for (const raw of lines) {
      let line = raw
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
        .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>')
      const bullet = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/)
      if (bullet) {
        if (!inList) (html += '<ul>'), (inList = true)
        html += `<li>${bullet[1]}</li>`
        continue
      }
      if (inList) (html += '</ul>'), (inList = false)
      if (line.trim()) html += `<p>${line.replace(/^#{1,6}\s+/, '')}</p>`
    }
    if (inList) html += '</ul>'
    return html
  }

  function el(tag, cls, html) {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (html != null) e.innerHTML = html
    return e
  }

  function append(node) {
    $('empty')?.remove()
    const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80
    feed.appendChild(node)
    if (atBottom) feed.scrollTop = feed.scrollHeight
  }

  const scrollDown = () => {
    if (feed.scrollHeight - feed.scrollTop - feed.clientHeight < 160) feed.scrollTop = feed.scrollHeight
  }

  function startTurn(m) {
    if (m.background) {
      // A scheduled task: show its name, then its work.
    } else if (m.clientId !== clientId) {
      const u = el('div', 'msg user')
      u.innerHTML = `<span class="src">${esc(m.source)}</span><div class="bubble">${esc(m.text)}</div>`
      append(u)
    }
    const box = el('div', `msg onyx${m.background ? ' task' : ''}`)
    if (m.background) box.appendChild(el('div', 'label', esc(m.text)))
    const toolsEl = el('div', 'tools')
    const textEl = el('div', 'text')
    box.append(toolsEl, textEl)
    append(box)
    turns.set(m.turn, { el: box, textEl, toolsEl, raw: '', tools: new Map(), count: 0 })
  }

  function turnOf(id) {
    if (!turns.has(id)) startTurn({ turn: id, clientId, text: '' })
    return turns.get(id)
  }

  function addTool(m) {
    const t = turnOf(m.turn)
    const row = el('div', 'tool', `<span class="dot"></span><span>${esc(m.label)}</span>`)
    row.title = m.name
    t.toolsEl.appendChild(row)
    t.tools.set(m.id, row)
    t.count++
    // Long GUI tasks make dozens of steps: show the latest, fold the rest.
    if (t.count > 4 && !t.toggle) {
      t.toolsEl.classList.add('collapsed')
      t.toggle = el('button', 'tools-toggle')
      t.toggle.onclick = () => {
        t.toolsEl.classList.toggle('collapsed')
        updateToggle(t)
      }
      t.el.insertBefore(t.toggle, t.toolsEl)
    }
    if (t.toggle) updateToggle(t)
    scrollDown()
  }

  const updateToggle = (t) => {
    t.toggle.textContent = t.toolsEl.classList.contains('collapsed') ? `▸ ${t.count} steps` : '▾ hide steps'
  }

  function toolDone(m) {
    const row = turns.get(m.turn)?.tools.get(m.id)
    if (!row) return
    row.classList.add(m.ok ? 'ok' : 'fail')
    if (!m.ok && m.summary) row.title = m.summary
  }

  function addText(m) {
    const t = turnOf(m.turn)
    t.raw += m.delta
    t.textEl.innerHTML = md(t.raw)
    scrollDown()
  }

  function finishTurn(m) {
    const t = turns.get(m.turn)
    if (t && !t.raw.trim() && m.text) t.textEl.innerHTML = md(m.text)
  }

  function addError(m) {
    const t = m.turn ? turnOf(m.turn) : null
    const e = el('div', 'error', esc(m.message))
    if (t) t.el.appendChild(e)
    else append(e)
    scrollDown()
  }

  function sys(text, cls = '') {
    append(el('div', `sys ${cls}`, esc(text)))
  }

  function updateMustStay() {
    if (isDesktop) window.onyx.mustStay([...cards.values()].some((c) => !c.classList.contains('done')))
  }

  function approvalCard(m) {
    if (cards.has(m.id)) return
    const card = el('div', `card${m.risk === 'danger' ? ' danger' : ''}`)
    card.innerHTML = `
      <div class="head">${m.risk === 'danger' ? '⚠ Needs your OK (cannot be undone easily)' : 'Onyx wants to'}${m.background ? ' · background task' : ''}</div>
      <div class="what">${esc(m.label)}</div>
      <div class="row">
        <button class="primary" data-a="allow">Allow</button>
        ${m.risk === 'danger' ? '' : '<button data-a="allow_turn">Allow for this task</button>'}
        ${m.canAlways ? '<button data-a="always">Always allow</button>' : ''}
        <button data-a="deny">Deny</button>
      </div>
      <div class="answer"></div>`
    card.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => send({ type: 'approve', id: m.id, answer: b.dataset.a })),
    )
    cards.set(m.id, card)
    append(card)
    updateMustStay()
    if (isDesktop) window.onyx.notify('Onyx needs your OK', m.label)
    card.querySelector('button.primary').focus({ preventScroll: true })
  }

  function questionCard(m) {
    if (cards.has(m.id)) return
    const card = el('div', 'card')
    card.innerHTML = `
      <div class="head">Onyx asks</div>
      <div class="what">${esc(m.question)}</div>
      <div class="row">
        ${(m.choices || []).map((c, i) => `<button data-i="${i}">${esc(c)}</button>`).join('')}
        <input placeholder="Type an answer…" />
        <button class="primary" data-send="1">Send</button>
      </div>
      <div class="answer"></div>`
    const field = card.querySelector('input')
    const answer = (text) => text && send({ type: 'answer', id: m.id, text })
    card.querySelectorAll('button[data-i]').forEach((b) => b.addEventListener('click', () => answer(m.choices[Number(b.dataset.i)])))
    card.querySelector('button[data-send]').addEventListener('click', () => answer(field.value.trim()))
    field.addEventListener('keydown', (e) => e.key === 'Enter' && answer(field.value.trim()))
    cards.set(m.id, card)
    append(card)
    updateMustStay()
    if (isDesktop) window.onyx.notify('Onyx has a question', m.question)
    field.focus({ preventScroll: true })
  }

  function closeCard(id, answer) {
    const card = cards.get(id)
    if (!card) return
    card.classList.add('done')
    const labels = { allow: 'Allowed', allow_turn: 'Allowed for this task', always: 'Always allowed', deny: 'Denied' }
    if (answer) card.querySelector('.answer').textContent = labels[answer] ?? ''
    updateMustStay()
  }

  // ---------------------------------------------------------------- events

  function handle(m) {
    switch (m.type) {
      case 'welcome':
        clientId = m.clientId
        connected = true
        retry = 0
        break
      case 'ready':
        setStatus(m.busy ? 'busy' : '', m.busy ? 'working…' : `${m.brain === 'local' ? 'local' : 'Claude'} · ${m.model}`)
        document.body.classList.toggle('busy', Boolean(m.busy))
        break
      case 'state':
        document.body.classList.toggle('busy', m.busy)
        if (m.busy) setStatus('busy', m.queued ? `working… (${m.queued} queued)` : 'working…')
        else setStatus('', m.queued ? `${m.queued} queued` : 'ready')
        break
      case 'turn_start':
        document.body.classList.add('busy')
        setStatus('busy', 'working…')
        startTurn(m)
        break
      case 'text':
        addText(m)
        break
      case 'tool':
        addTool(m)
        break
      case 'tool_done':
        toolDone(m)
        break
      case 'done':
        finishTurn(m)
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
        sys(`🔔 ${m.title}: ${m.body}`, 'notify')
        if (isDesktop) window.onyx.notify(m.title, m.body)
        break
      case 'stopped':
        sys('■ Stopped')
        break
      case 'reset':
        feed.innerHTML = ''
        turns.clear()
        sys('New conversation')
        break
      case 'tasks':
        renderTasks(m.tasks)
        break
    }
  }

  // ---------------------------------------------------------------- composer

  function submit() {
    const text = input.value.trim()
    if (!text) return
    if (!connected) return sys('Not connected to Onyx yet.')
    const u = el('div', 'msg user')
    u.innerHTML = `<div class="bubble">${esc(text)}</div>`
    append(u)
    feed.scrollTop = feed.scrollHeight
    send({ type: 'ask', text })
    input.value = ''
    autosize()
  }

  function autosize() {
    input.style.height = 'auto'
    input.style.height = Math.min(160, input.scrollHeight) + 'px'
  }

  input.addEventListener('input', autosize)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      submit()
    }
  })
  $('send').addEventListener('click', submit)
  document.querySelectorAll('.examples button').forEach((b) =>
    b.addEventListener('click', () => {
      input.value = b.textContent
      autosize()
      input.focus()
    }),
  )

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('panel').hidden) return closePanel()
      if (isDesktop) window.onyx.hide()
    }
  })

  $('btn-stop').addEventListener('click', () => send({ type: 'stop' }))
  $('btn-new').addEventListener('click', () => send({ type: 'reset' }))
  $('btn-close').addEventListener('click', () => window.onyx?.hide())
  $('btn-pin').addEventListener('click', (e) => {
    pinned = !pinned
    e.currentTarget.classList.toggle('on', pinned)
    window.onyx?.pin(pinned)
  })

  // ---------------------------------------------------------------- panels

  function openPanel(title) {
    $('panel-title').textContent = title
    $('panel-body').innerHTML = '<p class="hint">Loading…</p>'
    $('panel').hidden = false
  }

  function closePanel() {
    $('panel').hidden = true
    input.focus()
  }

  $('panel-close').addEventListener('click', closePanel)

  $('btn-tasks').addEventListener('click', () => {
    openPanel('Scheduled & automatic tasks')
    send({ type: 'tasks' })
  })

  function renderTasks(tasks) {
    if ($('panel').hidden || $('panel-title').textContent.indexOf('task') < 0) return
    const body = $('panel-body')
    if (!tasks.length) {
      body.innerHTML =
        '<p class="hint">No tasks yet. Just ask, for example:<br>“Every day at 9pm, tell me what I spent today”<br>“When a new PDF lands in Downloads, file it into Documents/Bills”<br>“On the 1st of every month, summarise last month\'s expenses”</p>'
      return
    }
    body.innerHTML = ''
    for (const t of tasks) {
      const when = t.cron ? `cron ${t.cron}` : t.at ? `once at ${new Date(t.at).toLocaleString()}` : `when: ${t.trigger}${t.filter ? ` (${t.filter})` : ''}${t.folder ? ` in ${t.folder}` : ''}`
      const card = el('div', 'task')
      card.innerHTML = `
        <div class="name">${esc(t.name)}</div>
        <div class="when">${esc(when)}${t.next ? ` · next ${esc(new Date(t.next).toLocaleString())}` : ''}${t.enabled ? '' : ' · paused'}</div>
        <div class="hint">${esc(t.prompt.slice(0, 220))}</div>
        ${t.lastRun ? `<div class="last">Last run ${esc(new Date(t.lastRun).toLocaleString())}: ${esc(String(t.lastResult ?? '').slice(0, 160))}</div>` : ''}
        <div class="row">
          <button data-a="run">Run now</button>
          <button data-a="toggle">${t.enabled ? 'Pause' : 'Resume'}</button>
          <button data-a="delete">Delete</button>
        </div>`
      card.querySelector('[data-a=run]').onclick = () => {
        send({ type: 'task_run', id: t.id })
        closePanel()
      }
      card.querySelector('[data-a=toggle]').onclick = () => send({ type: 'task_toggle', id: t.id, enabled: !t.enabled })
      card.querySelector('[data-a=delete]').onclick = () => confirm(`Delete "${t.name}"?`) && send({ type: 'task_delete', id: t.id })
      body.appendChild(card)
    }
  }

  $('btn-phone').addEventListener('click', async () => {
    openPanel('Use Onyx from your phone')
    const body = $('panel-body')
    try {
      const p = await window.onyx.pair()
      if (!p.lan) {
        body.innerHTML = `<div class="pair">
          <p>Phone access is off, so only this PC can reach Onyx.</p>
          <p class="hint">To turn it on, set <code>"lan": { "enabled": true }</code> in the settings file and restart Onyx. Your phone must be on the same Wi-Fi. Windows will ask once to allow Onyx through the firewall: allow it on <b>private</b> networks only.</p>
          <p><button id="open-settings">Open settings file</button></p>
          <p class="hint">Bank SMS can also reach Onyx without this: connect the phone with adb (USB or Wireless debugging) and Onyx reads them every few minutes.</p></div>`
        body.querySelector('#open-settings').onclick = () => window.onyx.openSettings()
        return
      }
      body.innerHTML = `<div class="pair"><p>Scan with your phone camera (same Wi-Fi), or open the link. It contains your private access key, so do not share it.</p>${p.urls
        .map((u) => `${p.qr?.[u] ? `<img src="${p.qr[u]}" alt="QR code">` : ''}<p><code>${esc(u)}</code></p>`)
        .join('')}<p class="hint">On the phone, use “Add to Home screen” to keep Onyx one tap away.</p></div>`
    } catch (err) {
      body.innerHTML = `<p class="error">${esc(err.message)}</p>`
    }
  })

  if (isDesktop) window.onyx.onFocusInput(() => input.focus())
  input.focus()
  connect()
})()
