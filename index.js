require('dotenv').config()
const axios = require('axios')
const https = require('https')
const cheerio = require('cheerio')
const TelegramBot = require('node-telegram-bot-api')
const table = require('markdown-table')
const { tryLoadNews, saveNews, trySaveNews } = require('./persist')
const NAMES = require('./country.json')

const debugFactory = require('debug')
const debug = {
  forBot: debugFactory('bot:general'),
  forSend: debugFactory('bot:send'),
  forFetch: debugFactory('bot:fetch')
}

// cache of coronavirus data
let cache = {
  global: {},
  vietnam: {},
  byCountry: []
}

const news = Object.assign({
  last: null,
  subs: {}
}, tryLoadNews())

// backward compatible
if (typeof news.last === 'number') {
  news.last = { timestamp: news.last }
  trySaveNews(news)
}

const token = process.env.BOT_TOKEN
const bot = new TelegramBot(token, { polling: true })

const send = (id, text, options) => {
  bot.sendMessage(id, text, options).catch(err => {
    debug.forSend(`Error ${err.code} sending to ${id} text ${text.substr(0, 16)}...`)
    if (err.response && err.response.body) {
      debug.forSend(err.response.body)
    }
  })
}

const fetch = (url, acceptUnauthorized) => {
  let options = undefined
  if (acceptUnauthorized) {
    const agent = new https.Agent({
      rejectUnauthorized: false
    })
    options = { httpsAgent: agent }
  }
  return axios.get(url, options).catch(err => {
    debug.forFetch(`Fetch failed: [${err.response.status}] ${url}`)
    // Error 😨
    if (err.response) {
      /*
       * The request was made and the server responded with a
       * status code that falls out of the range of 2xx
       */
      debug.forFetch(err.response.data, err.response.headers)
    } else if (err.request) {
      /*
       * The request was made but no response was received, `err.request`
       * is an instance of XMLHttpRequest in the browser and an instance
       * of http.ClientRequest in Node.js
       */
      debug.forFetch(err.request);
    } else {
      // Something happened in setting up the request and triggered an Error
      debug.forFetch('Error', err.message);
    }
    debug.forFetch(err.config);
  })
}

bot.onText(/(\/start|\/help|\/menu)/, (msg, match) => {
  trySaveNews(news, msg)
  const commands = [
    '/status \- thống kê ca nhiễm và tử vong',
    'Có thể xem theo quốc gia, ví dụ <code>\/status india</code>'
    // '/news - tin đáng lưu tâm',
    // '/alert - ca bệnh mới nhất ở Việt Nam'
  ].join('\n')
  send(msg.chat.id, commands, { parse_mode: 'HTML' })
})

bot.onText(/\/admin/, (msg, match) => {
  if (!isAdmin(msg)) return
  const subs = Object.keys(news.subs)
  const total = subs.length
  const users = subs.filter(s => s > 0)
  const userCount = users.length
  const groupCount = total - userCount

  const text = [
    'Subcription stats:\n~~~',
    `Users: ${userCount}`,
    `Groups: ${groupCount}`,
    `TOTAL: ${total}`
  ].join('\n')
  send(msg.chat.id, text)
})

/*

bot.onText(/\/alert/, (msg, match) => {
    trySaveNews(news, msg)
    if (!news.last || !news.last.content) return

    const { time, content } = news.last
    const text = `${time} - BỘ Y TẾ\n~~~~~~~~~~~~\n${content}`
    send(msg.chat.id, text)
})

bot.onText(/\/new/, (msg, match) => {
    trySaveNews(news, msg)
    //const text = 'Nguồn tin: Lá chắn Virus Corona trên MXH Lotus'
    //send(msg.chat.id, text)
})
*/

bot.onText(/\/status(\s+(\w+))?/, (msg, match) => {
  const chatId = msg.chat.id
  trySaveNews(news, msg)

  const { list, hasChina, text: mainText } = makeTable(cache, { country: match[2] })
  const onlyChina = !list && hasChina

  let text = mainText

  if (list) {
    text = `<b>Việt Nam</b>: ${makeCases(cache.vietnam.cases, cache.vietnam.newCases)}\n\r`
    text += `<b>Thế giới</b>: ${cache.global.cases + ' ca' || 'N/A'} (${cache.global.deaths || 'N/A'} tử vong)\n\r`
    text += '~~~\n\r'
    text += `<pre>${mainText}</pre>`
    text += '\n\r~~~\n\r<i>✱ Nguồn: Bộ Y Tế, Worldometers</i>\n\r'
    if (!onlyChina) {
      text += `<i>✱ Ca ${list ? 'mới' : 'trong ngày'} tính từ nửa đêm GMT+0 (7h sáng VN)${hasChina ? '. Riêng Trung Quốc là của ngày hôm trước.' : ''}</i>\n\r`
    }
    text += '— Made with ❤️ by @iceteachainvn 🍵'
  }

  send(chatId, text, makeSendOptions(msg, 'HTML'))
})

const isNowNight = (tz = 7) => {
  const hours = (new Date().getUTCHours() + tz) % 24 // 0~23
  return hours >= 10 || hours <= 7
}

const isGroup = msgOrTypeOrId => {
  if (typeof msgOrTypeOrId === 'object') {
    msgOrTypeOrId = msgOrTypeOrId.chat.type || msgOrTypeOrId.chat.id
  }
  if (typeof msgOrTypeOrId === 'string') {
    if (msgOrTypeOrId.startsWith('@')) return false // public channel
    return ['group', 'supergroup'].includes(msgOrTypeOrId)
  }
  if (typeof msgOrTypeOrId === 'number') return msgOrTypeOrId < 0

  return true
}

const makeSendOptions = (msg, parseMode) => {
  const options = {
    disable_web_page_preview: true,
    disable_notification: isNowNight() || isGroup(msg)
  }
  if (parseMode) {
    options.parse_mode = parseMode
  }

  return options
}

const arrayFromEnv = name => process.env[name].split(';')

const isAdmin = msg => {
  const admins = arrayFromEnv('ADMINS')
  return admins.includes(String(msg.from.id)) || admins.includes(String(msg.chat.id))
}

const getTimestamp = text => {
  const [time, date] = text.split(' ')
  const [hour, minutes] = time.split(':')
  const [day, month, year] = date.split('/')

  return Date.UTC(year, month - 1, day, hour, minutes, 0) - 7 * 60 * 60 * 1000
}

const sanitizeChatId = chatId => {
  return (typeof chatId === 'number' || chatId.startsWith('@')) ? chatId : +chatId
}

const broadcastNews = ({ time, content }) => {
  const includes = arrayFromEnv('INCLUDE')
  const exclude = arrayFromEnv('EXCLUDE')

  const subs = Array.from(new Set(Object.keys(news.subs || {}).concat(includes)))
  if (!subs || !subs.length) return

  console.log('hehe', subs)

  const text = `‼️${time} - BỘ Y TẾ‼️\n\r~~~~~~~~~~~~\n\r${content}`
  let timeout = 0
  subs.forEach(chatId => {
    if (exclude.includes(chatId)) return

    const sanitizedId = sanitizeChatId(chatId)
    timeout += 100
    const options = makeSendOptions(sanitizeChatId(sanitizedId))
    setTimeout(() => {
      send(sanitizedId, text, options)
    }, timeout)
  })
}

const hasLastEvent = lastEvent => {
  return Boolean(lastEvent && lastEvent.timestamp && lastEvent.time && lastEvent.content)
}

const isNewEvent = (lastEvent, event) => {
  if (lastEvent.time === event.time) return false
  if (lastEvent.content === event.content) return false
  if (lastEvent.timestamp >= event.timestamp) return false

  const age = Date.now() - event.timestamp
  const oneHour = 60 * 60 * 1000

  return age < oneHour
}

// Data on the timeline https://ncov.moh.gov.vn/dong-thoi-gian and
// the homepage 'https://ncov.moh.gov.vn/' is not in sync
// Sometimes the timeline is earlier, sometimes the homepage is earlier :D
const updateNews = async () => {
  const res = await fetch('https://ncov.moh.gov.vn/dong-thoi-gian', true)
  if (!res) return

  const $ = cheerio.load(res.data)

  const $this = $('.timeline-detail').eq(0)
  const time = $this.find('.timeline-head').text().trim()
  const timestamp = getTimestamp(time)
  const content = $this.find('.timeline-content').text().trim()

  const event = { timestamp, time, content }
  const lastEvent = news.last
  if (!hasLastEvent(lastEvent) || isNewEvent(lastEvent, event)) {
    news.last = event
    saveNews(news).then(() => {
      // only broadcast if this is not first crawl
      lastEvent && lastEvent.timestamp && isNewEvent(lastEvent, event) && broadcastNews(event)
    }).catch(debug.forBot)
  }
}

// because Vietnam's cases are reported earlier on MoH site than on Worldometers
const updateVietnamData = async () => {
  const res = await fetch('https://ncov.moh.gov.vn/', true)

  if (!res) {
    debug.forBot('Fallback to news.zing.vn because of failture loading cases from MoH.')
    updateVietnamDataFromZing()
    return
  }

  const m = res.data.match(/"VNALL","soCaNhiem":"(\d+)","tuVong":"(\d+)",/)
  if (m && m[1]) {
    cache.vietnam = Object.assign(cache.vietnam || {}, { cases: m[1], deaths: m[2] || '0' })
  } else {
    updateVietnamDataFromZing()
  }
}

const updateVietnamDataFromZing = async () => {
  const res = await fetch('https://news.zing.vn')
  if (!res) return

  const $ = cheerio.load(res.data)
  const script = $('#widget-ticker script').html()
  const m = script.match(/"title":\s*"Việt Nam",\s*"cases":\s*(\d+),\s*"deaths":\s(\d+),/)

  if (m && m[1]) {
    cache.vietnam = Object.assign(cache.vietnam || {}, { cases: m[1], deaths: m[2] || '0' })
  }
}

const getStatus = async () => {
  const res = await fetch('https://www.worldometers.info/coronavirus/')
  if (!res) return

  const $ = cheerio.load(res.data)

  const d = {
    global: {},
    byCountry: []
  }

  const $global = $('.maincounter-number span')
  d.global.cases = $global.eq(0).text().trim()
  d.global.deaths = $global.eq(1).text().trim()
  d.global.decovered = $global.eq(2).text().trim()

  const headers = ['country', 'cases', 'newCases', 'deaths', 'newDeaths', 'recovered', 'activeCases', 'criticalCases', 'casesPerM']
  $('#main_table_countries tbody tr').each((rowNum, tr) => {
    const $cells = $(tr).find('td')
    const row = {}
    headers.forEach((h, i) => {
      row[h] = $cells.eq(i).text().trim()
    })
    d.byCountry.push(row)
  })

  cache = d
}

const getTop = (data, { country, top = 10 } = {}) => {
  let countries = data.byCountry
  if (country) {
    country = country.toLowerCase()
    const single = countries.find(c => c.country.toLowerCase() === country)
    if (single) return [single]
    countries = countries.filter(c => c.country.toLowerCase().includes(country))
  }
  return countries.filter((c, i) => i < top)
}

const makeCases = (cases, newCases) => {
  if (cases == null) return 'N/A'
  let t = cases + ' ca nhiễm'
  if (newCases) t += ` (${newCases})`
  return t
}

const makeShortCountry = c => {
  if (NAMES[c]) return NAMES[c]
  return c.replace(' ', '').substr(0, 7)
}

const makeTable = (data, filter) => {
  const headers = [['Nước', 'Nhiễm', 'Mới', 'Chết']]
  const topData = getTop(data, filter)

  if (!topData || !topData.length) {
    return { text: 'Chưa có dữ liệu, vui lòng thử lại sau.' }
  }

  if (topData.length > 1) {
    let hasChina = false
    const rows = topData.map(({ country, cases, newCases, deaths }) => {
      !hasChina && (hasChina = country === 'China')
      return [makeShortCountry(country), cases, newCases, deaths]
    })
    const text = table(headers.concat(rows), {
      align: ['l', 'r', 'r', 'r'],
      padding: false,
      delimiterStart: false,
      delimiterEnd: false
    })
    return { list: true, hasChina, text }
  } else {
    let { country, cases, newCases, deaths, newDeaths, casesPerM } = topData[0]
    if (country === 'Vietnam' && data.vietnam) {
      if (+data.vietnam.cases && +cases < +data.vietnam.cases) {
        newCases = 'N/A'
      }
      if (+data.vietnam.deaths && +deaths < +data.vietnam.deaths) {
        newDeaths = 'N/A'
      }
      cases = Math.max(+cases, +data.vietnam.cases || 0)
      deaths = Math.max(+deaths || 0, +data.vietnam.deaths || 0)
    }
    const hasChina = country === 'China'
    const text = [
      `Quốc gia: <b>${country}</b>`,
      `Ca nhiễm: <b>${cases}</b>`,
      `${hasChina ? 'Hôm qua' : 'Trong ngày'}: <b>${newCases || 0}</b>`,
      `Tử vong: <b>${deaths || 0}</b>`,
      `${hasChina ? 'Hôm qua' : 'Trong ngày'}: <b>${newDeaths || 0}</b>`,
      `Số ca/1tr dân: <b>${casesPerM}</b>`
    ].join('\n')
    return { list: false, hasChina, text }
  }
}

const updateStatus = async () => {
  await getStatus()
  await updateVietnamData()
  if (!cache.vietnam || !cache.vietnam.cases) {
    cache.vietnam = cache.byCountry.find(c => c.country === 'Vietnam') || {}
  }

  updateNews()
}

const start = async () => {
  updateStatus()
  setInterval(updateStatus, +process.env.RELOAD_EVERY || 30000)
}

start().catch(debug.forBot)
