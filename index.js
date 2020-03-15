require('dotenv').config()
const axios = require('axios')
const https = require('https')
const cheerio = require('cheerio')
const TelegramBot = require('node-telegram-bot-api')
const table = require('markdown-table')
const { tryLoadNews, saveNews, trySaveNews } = require('./persist')

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

bot.onText(/(\/start|\/help|\/menu)/, (msg, match) => {
  trySaveNews(news, msg)
  const commands = [
    '/status [country] - thống kê ca nhiễm và tử vong',
    '[country] là tên nước, ví dụ india, không bắt buộc.'
    // '/news - tin đáng lưu tâm',
    // '/alert - ca bệnh mới nhất ở Việt Nam'
  ].join('\n')
  bot.sendMessage(msg.chat.id, commands)
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
  bot.sendMessage(msg.chat.id, text)
})

/*

bot.onText(/\/alert/, (msg, match) => {
    trySaveNews(news, msg)
    if (!news.last || !news.last.content) return

    const { time, content } = news.last
    const text = `${time} - BỘ Y TẾ\n~~~~~~~~~~~~\n${content}`
    bot.sendMessage(msg.chat.id, text)
})

bot.onText(/\/new/, (msg, match) => {
    trySaveNews(news, msg)
    //const text = 'Nguồn tin: Lá chắn Virus Corona trên MXH Lotus'
    //bot.sendMessage(msg.chat.id, text)
})
*/

bot.onText(/\/status(\s+(\w+))?/, (msg, match) => {
  const chatId = msg.chat.id
  trySaveNews(news, msg)

  const { list, text: mainText } = makeTable(cache, { country: match[2] })

  let text = `<b>Việt Nam</b>: ${makeCases(cache.vietnam.cases, cache.vietnam.newCases)}\n\r`
  text += `<b>Thế giới</b>: ${cache.global.cases + ' ca' || 'N/A'} (${cache.global.deaths || 'N/A'} tử vong)\n\r`
  text += '~~~\n\r'
  text += `<pre>${mainText}</pre>`
  text += '\n\r~~~\n\r<i>✱ Nguồn: Bộ Y Tế, Worldometers</i>\n\r'
  text += `<i>✱ Ca ${list ? 'mới' : 'trong ngày'} tính từ nửa đêm GMT+0 (7h sáng VN). Riêng Trung Quốc là của ngày hôm trước.</i>\n\r`
  text += 'Made with 🍵 by @iceteachainvn'

  bot.sendMessage(chatId, text, makeSendOptions(msg, 'HTML'))
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

const isAdmin = msg => {
  return process.env.ADMINS.split(';').includes(String(msg.chat.id))
}

const getTimestamp = text => {
  const [time, date] = text.split(' ')
  const [hour, minutes] = time.split(':')
  const [day, month, year] = date.split('/')

  return Date.UTC(year, month - 1, day, hour, minutes, 0) - 7 * 60 * 60 * 1000
}

const broadcastNews = ({ time, content }) => {
  if (!news.subs) return

  const text = `‼️${time} - BỘ Y TẾ‼️\n\r~~~~~~~~~~~~\n\r${content}`
  let timeout = 0
  Object.keys(news.subs).forEach(chatId => {
    timeout += 100
    const options = makeSendOptions(+chatId)
    setTimeout(() => {
      bot.sendMessage(+chatId, text, options)
    }, timeout)
  })
}

const getMoHWeb = async (url = 'https://ncov.moh.gov.vn/') => {
  const agent = new https.Agent({
    rejectUnauthorized: false
  })
  return axios.get(url, { httpsAgent: agent })
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

// https://ncov.moh.gov.vn/dong-thoi-gian is sometimes updated later
// than the homepage 'https://ncov.moh.gov.vn/', for some reason
// so we'll use data from homepage
const updateNews = async () => {
  const res = await getMoHWeb()

  if (res.status !== 200) {
    return console.error(`${res.status}: ${res.statusText}`)
  }

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
    }).catch(console.error)
  }
}

// because Vietnam's cases are reported earlier on MoH site than on Worldometers
const updateVietnamData = async () => {
  const res = await getMoHWeb()

  if (res.status !== 200) {
    console.error(`Fallback to news.zing.vn because of failture loading cases from MoH. ${res.status}: ${res.statusText}`)
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

const updateVietnamDataFromZing = async (url = 'https://news.zing.vn') => {
  const res = await axios.get(url)

  if (res.status !== 200) {
    return console.error(`${res.status}: ${res.statusText}`, url)
  }

  const $ = cheerio.load(res.data)
  const script = $('#widget-ticker script').html()
  const m = script.match(/"title":\s*"Việt Nam",\s*"cases":\s*(\d+),\s*"deaths":\s(\d+),/)

  if (m && m[1]) {
    cache.vietnam = Object.assign(cache.vietnam || {}, { cases: m[1], deaths: m[2] || '0' })
  }
}

const getStatus = async (url = 'https://www.worldometers.info/coronavirus/') => {
  const res = await axios.get(url)

  if (res.status !== 200) {
    return console.error(`${res.status}: ${res.statusText}`, url)
  }

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

  return d
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

const makeShortCountry = c => c.replace(' ', '').substr(0, 7)

const makeTable = (data, filter) => {
  const headers = [['Nước', 'Nhiễm', 'Mới', 'Chết']]
  const topData = getTop(data, filter)

  if (!topData || !topData.length) {
    return { text: 'Chưa có dữ liệu, vui lòng thử lại sau.' }
  }

  if (topData.length > 1) {
    const rows = topData.map(({ country, cases, newCases, deaths }) => {
      return [makeShortCountry(country), cases, newCases, deaths]
    })
    const text = table(headers.concat(rows), {
      align: ['l', 'r', 'r', 'r'],
      padding: false,
      delimiterStart: false,
      delimiterEnd: false
    })
    return { list: true, text }
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
    const text = [
            `Quốc gia: ${country}`,
            `Ca nhiễm: ${cases}`,
            `Trong ngày: ${newCases || 0}`,
            `Tử vong: ${deaths || 0}`,
            `Trong ngày: ${newDeaths || 0}`,
            `Ca/1tr dân: ${casesPerM}`
    ].join('\n')
    return { list: false, text }
  }
}

const updateStatus = async () => {
  cache = await getStatus()
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

start().catch(console.error)
