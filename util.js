const https = require('https')
const axios = require('axios')

const debugFactory = require('debug')
const debugAxios = debugFactory('bot:axios')
const debugTelegram = debugFactory('bot:telegram')

const handleAxiosError = (err, url) => {
  debugAxios(`Axios Error: [${err.response ? err.response.status : '???'}] ${url}`)
  // Error 😨
  if (err.response) {
    /*
        * The request was made and the server responded with a
        * status code that falls out of the range of 2xx
        */
    debugAxios(err.response.data, err.response.headers)
  } else if (err.request) {
    /*
        * The request was made but no response was received, `err.request`
        * is an instance of XMLHttpRequest in the browser and an instance
        * of http.ClientRequest in Node.js
        */
    debugAxios(err.request)
  } else {
    // Something happened in setting up the request and triggered an Error
    debugAxios('Error', err.message)
  }
  debugAxios(err.config)
}

const handleTelegramError = (err, action, id, text) => {
  if (Array.isArray(id)) id = id.join('/')
  debugTelegram(`Telegram ${action} Error ${err.code} for ${id} text ${text ? text.substr(0, 16) : text}...`)
  if (err.response && err.response.body) {
    debugTelegram(err.response.body)
  }
}

const fetchCore = (url, headers, acceptUnauthorized) => {
  let options
  if (headers) {
    options = { headers }
  }
  if (acceptUnauthorized) {
    const agent = new https.Agent({
      rejectUnauthorized: false
    })
    options = options || {}
    options.httpsAgent = agent
  }
  return axios.get(url, options).catch(err => handleAxiosError(err, url))
}

exports.fetch = (url, headers) => {
  return fetchCore(url, headers, url.startsWith('https://ncov.moh.gov.vn/'))
}

exports.sendMessage = (bot, id, text, options) => {
  return bot.sendMessage(id, text, options).catch(err => handleTelegramError(err, 'sendMessage', id, text))
}

exports.editMessage = (bot, text, options) => {
  return bot.editMessageText(text, options).catch(err => handleTelegramError(err, 'editMessageText', [options.chat_id, options.message_id], text))
}

exports.pick = (obj, props) => {
  if (typeof obj !== 'object') return obj
  return props.reduce((newObj, p) => {
    if (obj.hasOwnProperty(p)) {
      newObj[p] = obj[p]
    }
    return newObj
  }, {})
}

exports.pickChatData = chat => {
  return exports.pick(chat, ['type', 'username', 'title', 'first_name', 'last_name'])
}

exports.isChatAdmin = async (bot, msg) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return true
  const result = await bot.getChatMember(msg.chat.id, msg.from.id).catch(err => handleTelegramError(err, 'getChatMember', [msg.chat.id, msg.from.id]))
  return result && ['creator', 'administrator'].includes(result.status)
}

exports.patchVietnamData = (list, vietnam, noPatch) => {
  if (!vietnam) return
  const vietnamRow = list.find(c => c.country === 'Vietnam')
  if (!vietnamRow) return

  const vnCases = exports.toInt(vietnam.cases)
  const vnDeaths = exports.toInt(vietnam.deaths)
  let { country, cases, newCases, deaths, activeCases, newDeaths, casesPerM, ...rest } = exports.rowAsNumber(vietnamRow)

  // adjust new cases and new deaths
  if (vnCases && cases < vnCases) {
    newCases += vnCases - cases
    activeCases += vnCases - cases
  }
  if (vnDeaths && deaths < vnDeaths) {
    newDeaths += vnDeaths - deaths
  }

  // adjust cases and deaths
  cases = Math.max(cases, vnCases)
  deaths = Math.max(deaths, vnDeaths)

  const newRow = {
    country,
    cases,
    newCases: newCases ? `+${newCases}` : '',
    deaths: deaths || '',
    newDeaths: newDeaths ? `+${newDeaths}` : '',
    activeCases,
    casesPerM,
    ...rest
  }

  if (noPatch) return newRow

  // patch to list
  return list.map(c => (c.country === 'Vietnam' ? newRow : c))
}

exports.toInt = s => {
  if (typeof s === 'number') return s
  return Number(s.split(',').join(''))
}

exports.rowAsNumber = oldRow => {
  const row = { ...oldRow }
  row.cases = exports.toInt(row.cases)
  row.newCases = exports.toInt(row.newCases)
  row.deaths = exports.toInt(row.deaths)
  row.recovered = exports.toInt(row.recovered)
  row.activeCases = exports.toInt(row.activeCases)
  row.criticalCases = exports.toInt(row.criticalCases)
  row.newDeaths = exports.toInt(row.newDeaths)
  row.casesPerM = exports.toInt(row.casesPerM)
  return row
}

exports.sortRowBy = (array, prop1, prop2) => {
  return array.sort((a, b) => {
    a = exports.rowAsNumber(a)
    b = exports.rowAsNumber(b)
    return b[prop1] - a[prop1] !== 0 ? b[prop1] - a[prop1] : b[prop2] - a[prop2]
  })
}

exports.escapeHtml = unsafe => {
  return unsafe
       .replace(/&/g, "&amp;")
       .replace(/</g, "&lt;")
       .replace(/>/g, "&gt;")
       .replace(/"/g, "&quot;")
       .replace(/'/g, "&#039;");
}