require('dotenv').config()
const cheerio = require('cheerio')
const TelegramBot = require('node-telegram-bot-api')
const table = require('markdown-table')
const { tryLoadData, saveData, trySaveData } = require('./persist')
const { getNews } = require('./news')
const { fetch, sendMessage, editMessage, isChatAdmin, sortRowBy, patchVietnamData } = require('./util')
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

bot.on('polling_error', debug)

bot.onText(/\/(start|help|menu|about)/, (msg, match) => {
  trySaveData(store, msg)
  if (handleNoTalk(msg)) return

  const cmd = match[1]
  const helpCmds = [
    '/unsubscribe - huỷ đăng kí nhận thông báo từ Bộ Y Tế',
    '/subscribe - đăng kí lại',
    '/notalk - tắt chat với bot trong group',
    '/talk - bật chat với bot trong group',
    'Trong group, chỉ group admin mới thực hiện được 4 lệnh trên.\n'
  ]
  const startCmds = ['/help - xem danh sách lệch đầy đủ\n']
  const extraCmds = cmd === 'start' ? startCmds : helpCmds
  const commands = [
    '/status - thống kê theo ca nhiễm',
    '/death - thống kê theo ca tử vong',
    'Có thể xem theo quốc gia, ví dụ <code>/status malay,indo</code>',
    '/asean - thống kê cho các nước ASEAN\n',
    '/news - tin tức chọn lọc',
    '/alert - xem thông báo mới nhất từ Bộ Y Tế\n',
    ...extraCmds,
    '~~~',
    "<i>Phát triển bởi <a href='https://icetea.io'>Icetea team</a>, tham gia <a href='https://t.me/iceteachainvn'>nhóm Telegram</a> đề đề xuất tính năng.</i>\n",
    '<b>Nguồn dữ liệu:</b>',
    "- Số liệu Việt Nam và thông báo lấy từ <a href='https://ncov.moh.gov.vn/'>Bộ Y Tế</a>",
    "- Số liệu quốc tế lấy từ <a href='https://www.worldometers.info/coronavirus/'>worldometers</a>",
    "- Tin tức cung cấp bởi team <a href='https://lotus.vn/lachanviruscorona'>Lá chắn Virus Corona (MXH Lotus)</a>"
  ].join('\n')
  send(msg.chat.id, commands, { parse_mode: 'HTML', disable_web_page_preview: true })
})

bot.onText(/\/admin(@\w+)?(\s+(\w+))?/, (msg, match) => {
  const what = match[3] || 'stats'
  if (!['stats', 'groups'].includes(what)) {
    return
  }
  const isStats = (what === 'stats')
  if (!isAdmin(msg, isStats)) return

  const text = isStats ? getStats() : getGroups()
  send(msg.chat.id, text, { parse_mode: 'HTML' })
})

// bot.onText(/\/fix/, async (msg, match) => {
//   if (!isAdmin(msg)) return

//   const promises = []
//   const keys = Object.keys(store.subs)
//   keys.forEach(key => {
//     promises.push(bot.getChat(key))
//   })

//   const results = await Promise.allSettled(promises)
//   results.forEach((r, i) => {
//     if (r.status === 'fulfilled') {
//       const k = keys[i]
//       const value = pickChatData(r.value)
//       let oldValue = store.subs[k]
//       if (typeof oldValue === 'number') {
//         oldValue = { date: Math.floor(oldValue / 1000), ...value }
//       } else {
//         oldValue = { date: oldValue.date, ...value }
//       }
//       debug(k, oldValue)
//       store.subs[k] = oldValue
//     }
//   })
//   trySaveData(store)
// })

bot.onText(/\/alert/, (msg, match) => {
  trySaveData(store, msg)
  if (handleNoTalk(msg)) return

  if (!store.last || !store.last.content) return

  const { time, content } = store.last
  const text = makeAlertMessage(time, content, '')
  send(msg.chat.id, text)
})

bot.onText(/\/new/, async (msg, match) => {
  trySaveData(store, msg)
  if (msg.chat.type !== 'private') {
    send(msg.chat.id, 'Không hỗ trợ xem tin tức trong group, vui lòng <a href="https://t.me/CoronaAlertBot">chat riêng với bot</a> để xem.', { parse_mode: 'HTML' })
    return
  }

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

bot.onText(/\/(status|case|dead|death|vietnam|asean|total|world)/, (msg, match) => {
  trySaveData(store, msg)
  if (handleNoTalk(msg)) return

  const cmd = match[1]

  let country =  msg.text.split(' ').slice(1).join(' ').trim()
  if (cmd === 'vietnam') {
    country = 'vietnam'
  } else if (['total', 'world'].includes(cmd)) {
    country = 'total:'
  } else if (country === 'asean' || cmd === 'asean') {
    country = 'indonesia,singapore,thailand,malaysia,philippines,vietnam,cambodia,brunei,myanmar,laos,timor-leste'
  }

  const byDeath = ['dead', 'death'].includes(cmd)
  const { list, text: mainText } = makeTable(cache, { country, top: 10, byDeath })
  // const { list, hasChina, text: mainText } = makeTable(cache, { country })
  // const onlyChina = !list && hasChina

  let text = mainText

  if (list) {
    text = `/vietnam: ${makeVNCases()}\n\r`
    text += `/world: ${cache.global.cases + '' || 'N/A'} (${cache.global.deaths || 'N/A'} tử vong)\n\r`
    text += '~~~\n\r'
    text += `<pre>${mainText}</pre>`
    if (!country) {
      text += byDeath ? '\n\r\n\rTheo số ca nhiễm: /status' : '\n\r\n\rTheo số tử vong: /death'
    }
    text += '\n\r~~~\n\r<i>Nguồn: Bộ Y Tế, Worldometers</i>\n\r'
    // if (!onlyChina) {
    //   text += `<i>✱ Ca ${list ? 'mới' : 'trong ngày'} tính từ nửa đêm GMT+0 (7h sáng VN)${hasChina ? '. Riêng Trung Quốc là của ngày hôm trước.' : ''}</i>\n\r`
    // }
    text += "Made with ❤️ by <a href='https://t.me/iceteachainvn'>Icetea</a>"
  }

  send(msg.chat.id, text, makeSendOptions(msg, 'HTML'))
})

bot.onText(/\/(subscribe|unsubscribe)/, async (msg, match) => {
  const cmd = match[1]
  const noAlert = cmd === 'unsubscribe'
  const oldNoAlert = Boolean((store.subs[msg.chat.id] || {}).noAlert)
  if (noAlert === oldNoAlert) {
    if (msg.chat.type === 'private') {
      send(msg.chat.id, `Đang như vậy rồi, không cần ${cmd} nữa.`)
    }
    return
  }

  const admin = await isChatAdmin(bot, msg)
  // no need say anything to spam group
  if (!admin) return

  trySaveData(store, msg, noAlert)

  send(msg.chat.id, 'Dạ', { reply_to_message_id: msg.message_id })
})

bot.onText(/\/(talk|notalk)/, async (msg, match) => {
  if (msg.chat.type === 'private') {
    send(msg.chat.id, `Lệnh này chỉ có tác dụng trong group.`)
    return
  }

  const cmd = match[1]
  const noTalk = cmd === 'notalk'
  const oldNoTalk = Boolean((store.subs[msg.chat.id] || {}).noTalk)
  if (noTalk === oldNoTalk) {
    return
  }

  const admin = await isChatAdmin(bot, msg)
  // no need say anything to spam group
  if (!admin) return

  trySaveData(store, msg, undefined, noTalk)

  send(msg.chat.id, 'Dạ', { reply_to_message_id: msg.message_id })
})

const isNoTalk = msg => Boolean((store.subs[msg.chat.id] || {}).noTalk)
const handleNoTalk = msg => {
  const shouldDeny = ['group', 'supergroup'].includes(msg.chat.type) && isNoTalk(msg)
  if (shouldDeny) {
    send(msg.chat.id, 'Admin đã cấm chat lệnh cho bot trong group này để giảm nhiễu. Vui lòng chat riêng với bot.')
  }
  return shouldDeny
}

const getStats = () => {
  const subs = Object.keys(store.subs).map(Number)
  const total = subs.length
  const users = subs.filter(s => s > 0)
  const userCount = users.length
  const groupCount = total - userCount

  return [
    'Usage stats:\n~~~',
    `Users: ${userCount}`,
    `Groups: ${groupCount}`,
    `TOTAL: ${total}`
  ].join('\n')
}

const getGroups = () => {
  let i = 1
  const lines = Object.entries(store.subs).reduce((groups, [key, value]) => {
    const nKey = +key
    if (nKey && nKey < 0) {
      let name = key
      if (value.title) {
        name = value.title
      } else if (value.username) {
        name = value.username
      }

      if (value.type) {
        name += ` (${value.type})`
      }
      const link = value.username ? `<a href="https://t.me/${value.username}">${name}</a>` : name
      groups.push(`${i}. ${link}`)
      i++
    }
    return groups
  }, [])

  return lines.length ? lines.join('\n') : 'No groups.'
}

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

const isAdmin = (msg, acceptGroupChat) => {
  const admins = arrayFromEnv('ADMINS')
  return admins.includes(String(msg.chat.id)) || (acceptGroupChat && admins.includes(String(msg.from.id)))
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

const formatAlertTitle = s => {
  const l = s.length
  if (l > 8 && l < 48 && s === s.toUpperCase()) {
    return s.replace(/THÔNG\s+(TIN|BÁO)\s+(VỀ)*\s*(\d+ )*\s*CA\s+BỆNH(\s+SỐ)*/g, 'THÔNG BÁO $3CA BỆNH')
  } else {
    return null
  }
}

const upperFirstChar = text => text.charAt(0).toUpperCase() + text.slice(1)

const getLines = text => {
  const lines = text.split(';')
  return lines.reduce((a, s) => {
    const t = s.trimStart()
    const c = t.charAt(0)
    if (!a.length || c === c.toUpperCase()) {
      a.push(t)
    } else {
      a[a.length - 1] += `;${s}`
    }
    return a
  }, [])
}

const formatAlert = text => {
  let [title, ...rest] = text.split(':')
  title = formatAlertTitle(title)
  if (title) {
    text = rest.join(':').trim()
    // ensure first letter is uppercase
    text = upperFirstChar(text)
  } else {
    title = ''
  }

  const lines = getLines(text)
  let formated = lines.join('.\n\n').replace(/:\s*1./g, ':\n\n1.').replace(/\.\s*(B(N|n)\d\d\d+\s*\:)/g, '.\n\n$1')
  const addNewsLink = process.env.PROMOTE_NEWS === '1'
  if (addNewsLink) {
    formated += '\n\nGõ /news để xem thêm tin tức chọn lọc về dịch bệnh.'
  }
  return { title, body: formated }
}

const makeAlertMessage = (time, content, hilight = '‼️') => {
  let { title, body } = formatAlert(content)
  const pad = '~'.repeat(2 + (hilight ? 1 : 0))
  let subtitle = `${pad}${time} - BỘ Y TẾ${pad}\n\r`
  if (!title) {
    title = `${time} - BỘ Y TẾ`
    subtitle = '~'.repeat(23 +  (hilight ? 4 : 0))
  }
  return `${hilight + title + hilight}\n\r${subtitle}\n\r${body}`
}

const broadcastAlert = ({ time, content }) => {
  const includes = arrayFromEnv('INCLUDE')
  const exclude = arrayFromEnv('EXCLUDE')

  const subs = Array.from(new Set(Object.keys(store.subs || {}).concat(includes)))
  if (!subs || !subs.length) return

  const text = makeAlertMessage(time, content)
  let timeout = 0
  subs.forEach(chatId => {
    if (exclude.includes(chatId)) return
    if ((store.subs[chatId] || {}).noAlert) return

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

const findByOneCountry = (countries, country) => {
  const single = countries.find(c => c.country.toLowerCase() === country)
  if (single) return [single]
  return countries.filter(c => c.country.toLowerCase().includes(country))
}

const getTop = (data, { country, top, byDeath }) => {
  if (!data.byCountry || !data.byCountry.length) return null
  let countries = patchVietnamData(data.byCountry, data.vietnam) || data.byCountry
  if (country) {
    const countryArray = country.split(',').map(c => c.toLowerCase())
    countries = countryArray.reduce((list, c) => {
      return list.concat(findByOneCountry(countries, c))
    }, [])
    
    // remove dup and sort
    const sortProps = !byDeath ? ['cases', 'deaths'] : ['deaths', 'cases']
    countries = sortRowBy(Array.from(new Set(countries)), ...sortProps)
  }

  if (byDeath) countries = sortRowBy(countries, 'deaths', 'cases').filter(c => c.country !== 'Total:')
  return countries.slice(0, top)
}

const makeVNCases = () => {
  const { cases, newCases } = patchVietnamData(cache.byCountry, cache.vietnam, true) || {}
  if (cases == null) return 'N/A'
  let t = cases + ' ca'
  if (newCases) t += ` (<b>${newCases}</b>)`
  return t
}

const makeShortCountry = c => {
  if (NAMES[c]) return NAMES[c]
  return c.replace(' ', '').substr(0, 7)
}

const makeTable = (data, filter) => {
  const byDeath = !!filter.byDeath
  const headers = !byDeath ? [['Nước', 'Nhiễm', 'Mới', 'Chết']] : [['Nước', 'Chết', 'Mới', 'Nhiễm']]
  const topData = getTop(data, filter)

  if (!topData) {
    return { text: 'Chưa có dữ liệu, vui lòng thử lại sau.' }
  }

  if (!topData.length) {
    return { text: 'Không tìm thấy. Tên nước phải bằng tiếng Anh, kiểm tra lại xem có bị sai không?' }
  }

  if (topData.length > 1) {
    let hasChina = false
    const rows = topData.map(({ country, cases, newCases, deaths, newDeaths }) => {
      !hasChina && (hasChina = country === 'China')
      const shortCountry = makeShortCountry(country)
      return !byDeath ?
        [shortCountry, cases, newCases, deaths] :
        [shortCountry, deaths, newDeaths, cases]
    })
    const text = table(headers.concat(rows), {
      align: ['l', 'r', 'r', 'r'],
      padding: false,
      delimiterStart: false,
      delimiterEnd: false
    })
    return { list: true, hasChina, text }
  } else {
    const { country, cases, newCases, deaths, newDeaths, casesPerM } = topData[0]
    const hasChina = country === 'China'
    const isTotal = country === 'Total:'
    const text = [
      `${isTotal ? '' : 'Quốc gia: '}<b>${country}</b>`,
      `Ca nhiễm: <b>${cases}</b>`,
      `${hasChina ? 'Hôm qua' : 'Trong ngày'}: <b>${newCases || 0}</b>`,
      `Tử vong: <b>${deaths || 0}</b>`,
      `${hasChina ? 'Hôm qua' : 'Trong ngày'}: <b>${newDeaths || 0}</b>`,
      `Số ca/1tr dân: <b>${casesPerM}</b>`
    ].join('\n')
    return { list: false, hasChina, text }
  }
}

const updateNews = async () => {
  const newNews = await getNews()
  if (newNews && newNews.length) {
    news.list = newNews
    news.timestamp = Date.now()
  }
}

const updateStatus = async () => {
  await getStatus()
  await updateVietnamData()
  if (!cache.vietnam || !cache.vietnam.cases) {
    cache.vietnam = cache.byCountry.find(c => c.country === 'Vietnam') || {}
  }

  updateAlert()
  updateNews()
}

const start = async () => {
  updateStatus()
  setInterval(updateStatus, +process.env.RELOAD_EVERY || 30000)
}

start().catch(debug)
