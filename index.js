require('dotenv').config()
const cheerio = require('cheerio')
const TelegramBot = require('node-telegram-bot-api')
const table = require('markdown-table')
const { tryLoadData, saveData, trySaveData } = require('./persist')
const { getNews } = require('./news')
const { fetch, sendMessage, editMessage } = require('./util')
const NAMES = require('./country.json')

const debugFactory = require('debug')
const debug = debugFactory('bot:main')

// cache of coronavirus data
let cache = {
  global: {},
  vietnam: {},
  byCountry: []
}

const news = {
  list: [],
  timestamp: 0
}

const store = Object.assign({
  last: null,
  subs: {}
}, tryLoadData())

// backward compatible
if (typeof store.last === 'number') {
  store.last = { timestamp: store.last }
  trySaveData(store)
}

const token = process.env.BOT_TOKEN
const bot = new TelegramBot(token, { polling: true })

const send = (id, text, options) => {
  return sendMessage(bot, id, text, options)
}

bot.onText(/(\/start|\/help|\/menu|\/about)/, (msg, match) => {
  trySaveData(store, msg)
  const commands = [
    '/status - thống kê ca nhiễm và tử vong',
    'Có thể xem theo quốc gia, ví dụ <code>/status india</code>\n',
    '/news - tin tức chọn lọc',
    '/alert - thông báo mới nhất từ Bộ Y Tế\n',
    '~~~',
    "<i>Phát triển bởi <a href='https://icetea.io'>Icetea team</a>, tham gia <a href='https://t.me/iceteachainvn'>nhóm Telegram</a> đề đề xuất tính năng.</i>\n",
    '<b>Nguồn dữ liệu:</b>',
    "- Số liệu Việt Nam và thông báo lấy từ <a href='https://ncov.moh.gov.vn/'>Bộ Y Tế</a>",
    "- Số liệu quốc tế lấy từ <a href='https://www.worldometers.info/coronavirus/'>worldometers</a>",
    "- Tin tức cung cấp bởi team <a href='https://lotus.vn/lachanviruscorona'>Lá chắn Virus Corona (MXH Lotus)</a>"
  ].join('\n')
  send(msg.chat.id, commands, { parse_mode: 'HTML', disable_web_page_preview: true })
})

bot.onText(/\/admin/, (msg, match) => {
  if (!isAdmin(msg)) return
  const subs = Object.keys(store.subs)
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

bot.onText(/\/alert/, (msg, match) => {
  trySaveData(store, msg)
  if (!store.last || !store.last.content) return

  const { time, content } = store.last
  const text = `${time} - BỘ Y TẾ\n~~~~~~~~~~~~\n${formatAlert(content)}`
  send(msg.chat.id, text)
})

bot.onText(/\/new/, async (msg, match) => {
  trySaveData(store, msg)

  // refresh news
  news.list = await getNews()
  news.timestamp = msg.date * 1000

  const { text, options } = makeNewsMessage()
  if (text) {
    send(msg.chat.id, text, options)
  } else {
    send(msg.chat.id, 'Chưa có tin tức, vui lòng thử lại sau.')
  }
})

// Handle callback queries
bot.on('callback_query', function onCallbackQuery (callbackQuery) {
  const query = callbackQuery.data
  const msg = callbackQuery.message
  const opts = {
    chat_id: msg.chat.id,
    message_id: msg.message_id
  }

  const [action, indexText] = query.split(':')
  let index = Number(indexText) || 0

  if (action === 'first_news') {
    index = 0
  } else if (action === 'last_news') {
    if (!news.list.length) return
    index = news.list.length - 1
  } else if (action === 'next_news') {
    if (index >= news.list.length - 1) return
    index++
  } else if (action === 'prev_news') {
    if (index <= 0) return
    index--
  } else return

  const { text, options } = makeNewsMessage(index)
  if (!text) return

  return editMessage(bot, text, Object.assign(options, opts))
})

bot.onText(/\/status(\s+(\w+))?/, (msg, match) => {
  const chatId = msg.chat.id
  trySaveData(store, msg)

  const { list, text: mainText } = makeTable(cache, { country: match[2] })
  // const { list, hasChina, text: mainText } = makeTable(cache, { country: match[2] })
  // const onlyChina = !list && hasChina

  let text = mainText

  if (list) {
    text = `<b>Việt Nam</b>: ${makeCases(cache.vietnam.cases, cache.vietnam.newCases)}\n\r`
    text += `<b>Thế giới</b>: ${cache.global.cases + '' || 'N/A'} (${cache.global.deaths || 'N/A'} tử vong)\n\r`
    text += '~~~\n\r'
    text += `<pre>${mainText}</pre>`
    text += '\n\r~~~\n\r<i>Nguồn: Bộ Y Tế, Worldometers</i>\n\r'
    // if (!onlyChina) {
    //   text += `<i>✱ Ca ${list ? 'mới' : 'trong ngày'} tính từ nửa đêm GMT+0 (7h sáng VN)${hasChina ? '. Riêng Trung Quốc là của ngày hôm trước.' : ''}</i>\n\r`
    // }
    text += "Made with ❤️ by <a href='https://t.me/iceteachainvn'>Icetea</a>"
  }

  send(chatId, text, makeSendOptions(msg, 'HTML'))
})

const makeNewsMessage = (index = 0) => {
  if (news && news.list && news.list.length) {
    const list = news.list
    const suffix = `:${index}`
    const opts = {
      parse_mode: 'HTML'
    }

    if (list.length > 1) {
      const buttons = []
      if (index > 0) {
        buttons.push({
          text: '⏮️',
          callback_data: 'first_news' + suffix
        })
        buttons.push({
          text: '⬅️',
          callback_data: 'prev_news' + suffix
        })
      }
      if (index < list.length - 1) {
        buttons.push({
          text: '➡️',
          callback_data: 'next_news' + suffix
        })
        buttons.push({
          text: '⏭️',
          callback_data: 'last_news' + suffix
        })
      }
      opts.reply_markup = {
        inline_keyboard: [
          buttons
        ]
      }
    }
    return { text: list[index], options: opts }
  } else {
    return { text: null }
  }
}

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

const formatAlert = (text) => {
  const lines = text.split(';').map(s => s.trim())
  let formated = lines.join('.\n\n')
  const addNewsLink = process.env.PROMOTE_NEWS === '1'
  if (addNewsLink) {
    formated += '\n\nGõ /news để xem thêm tin tức chọn lọc về dịch bệnh.'
  }
  return formated
}

const broadcastAlert = ({ time, content }) => {
  const includes = arrayFromEnv('INCLUDE')
  const exclude = arrayFromEnv('EXCLUDE')

  const subs = Array.from(new Set(Object.keys(store.subs || {}).concat(includes)))
  if (!subs || !subs.length) return

  const text = `‼️${time} - BỘ Y TẾ‼️\n\r~~~~~~~~~~~~\n\r${formatAlert(content)}`
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

const hasLastAlert = lastEvent => {
  return Boolean(lastEvent && lastEvent.timestamp && lastEvent.time && lastEvent.content)
}

const isNewAlert = (lastEvent, event) => {
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
const updateAlert = async url => {
  const fetchUrl = url || 'https://ncov.moh.gov.vn/dong-thoi-gian'
  const res = await fetch(fetchUrl)
  if (!res) return

  const $ = cheerio.load(res.data)

  const $this = $('.timeline-detail').eq(0)
  const time = $this.find('.timeline-head').text().trim()
  if (!time) {
    if (url == null) {
      updateAlert('https://ncov.moh.gov.vn/')
    }
    return
  }

  const timestamp = getTimestamp(time)
  const content = $this.find('.timeline-content').text().trim()

  const event = { timestamp, time, content }
  const lastEvent = store.last
  if (!hasLastAlert(lastEvent) || isNewAlert(lastEvent, event)) {
    store.last = event
    saveData(store).then(() => {
      // only broadcast if this is not first crawl
      lastEvent && lastEvent.timestamp && isNewAlert(lastEvent, event) && broadcastAlert(event)
    }).catch(debug)
  }
}

// because Vietnam's cases are reported earlier on MoH site than on Worldometers
const updateVietnamData = async () => {
  const res = await fetch('https://ncov.moh.gov.vn/')

  if (!res) {
    debug('Fallback to news.zing.vn because of failture loading cases from MoH.')
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
  $('#main_table_countries_today tbody tr').each((rowNum, tr) => {
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

  updateAlert()
}

const start = async () => {
  updateStatus()
  setInterval(updateStatus, +process.env.RELOAD_EVERY || 30000)
}

start().catch(debug)
