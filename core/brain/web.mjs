/**
 * Web search and page reading for the local brain, with no API key:
 * DuckDuckGo's HTML results page, and plain fetch with the HTML stripped.
 *
 * What comes back is page text written by strangers. It reaches the model as
 * tool output, which the system prompt tells it to treat as data.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36'

const decode = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))

const strip = (html) =>
  decode(
    html
      .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|section|article)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim()

export async function webSearch(query, signal) {
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
    body: new URLSearchParams({ q: String(query), kl: 'in-en' }),
    signal: signal ?? AbortSignal.timeout(20_000),
  })
  const html = await res.text()
  const results = []
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g
  let m
  while ((m = re.exec(html)) && results.length < 8) {
    let url = decode(m[1])
    const uddg = url.match(/[?&]uddg=([^&]+)/)
    if (uddg) url = decodeURIComponent(uddg[1])
    if (url.includes('duckduckgo.com/y.js')) continue // ads
    results.push(`${results.length + 1}. ${strip(m[2])}\n   ${url}\n   ${strip(m[3] ?? '')}`)
  }
  return results.length ? results.join('\n') : 'No results (or the search page changed). Try different words, or web_fetch a site directly.'
}

export async function webFetch(url, signal) {
  let u = String(url).trim()
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`
  const host = new URL(u).hostname
  // Not for reaching into this machine or the home network.
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[?::1\]?$)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    throw new Error('web_fetch only reads public websites')
  }
  const res = await fetch(u, { headers: { 'user-agent': UA, accept: 'text/html,text/plain,*/*' }, redirect: 'follow', signal: signal ?? AbortSignal.timeout(25_000) })
  const type = res.headers.get('content-type') ?? ''
  if (!/text|html|json|xml/.test(type)) return `${res.status} ${type}: not a text page (${u})`
  const body = await res.text()
  const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  const text = /html/.test(type) ? strip(body) : body
  return `${res.status} ${title ? decode(title).trim() + '\n' : ''}${u}\n\n${text.slice(0, 15_000)}`
}
