require('dotenv').config()
const cheerio = require('cheerio')
const TelegramBot = require('node-telegram-bot-api')
const table = require('markdown-table')
const { tryLoadData, saveData, trySaveData } = require('./persist')
const { getNews } = require('./news')
const { fetch, sendMessage, editMessage, isChatAdmin, sortRowBy, patchVietnamData, escapeHtml } = require('./util')
const { hasVnChars, replaceVnChars } = require('./vn')
const NAMES = require('./country.json')

const debugFactory = require('debug')
const debug = debugFactory('bot:main')

// cache of coronavirus data
let cache = {
  global: {},
  vietnam: {},
  byCountry: [],
  yesterday: []
}

let patients = []

const news = {
  list: [],
  timestamp: 0
}

const store = Object.assign({
  last: null, // last alert
  lastPtCount: 0, // last VN patient count
  lastPtRowCount: 0, // last VN patent row
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
    '/bn - xem thông tin về 1 bệnh nhân',
    '/search - tìm kiếm bệnh nhân\n',
    '/news - tin tức chọn lọc',
    '/alert - xem thông báo mới nhất từ Bộ Y Tế\n',
    ...extraCmds,
    '~~~',
    "<i>Phát triển bởi icetea.io team, tham gia <a href='https://t.me/iceteachainvn'>nhóm Telegram</a> đề đề xuất tính năng.</i>\n",
    '<b>Nguồn dữ liệu:</b>',
    "- Số liệu Việt Nam và thông báo lấy từ <a href='https://ncov.moh.gov.vn/'>Bộ Y Tế</a>",
    "- Số liệu quốc tế lấy từ <a href='https://www.worldometers.info/coronavirus/'>worldometers</a>",
    "- Tin tức cung cấp bởi team <a href='https://lotus.vn/lachanviruscorona'>Lá chắn Virus Corona (MXH Lotus)</a>"
  ].join('\n')
  send(msg.chat.id, commands, { parse_mode: 'HTML', disable_web_page_preview: true })
})

bot.onText(/\/admin(?:@\w+)?(?:\s+(\w+))?/, (msg, match) => {
  const what = match[1] || 'stats'
  if (!['stats', 'groups'].includes(what)) {
    return
  }
  const isStats = (what === 'stats')
  if (!isAdmin(msg, isStats)) return

  if (isStats) {
    send(msg.chat.id, getStats())
  } else {
    const lines = getGroups()
    if (!lines || !lines.length) {
      send(msg.chat.id, 'No groups')
    } else {
      const chunk = 50, n = lines.length
      for (let i = 0; i < n; i += chunk) {
        const text = lines.slice(i, i + chunk).join('\n')
        setTimeout(() => {
          send(msg.chat.id, text, { parse_mode: 'HTML' })
        }, 100)
      }
    }
  }

})

let cancelBroadcast = false
bot.onText(/\/_broadcast_\s+(me|all)\s+(.+)/s, (msg, match) => {
  if (!isAdmin(msg)) return
  const whom = match[1]
  const toAll = whom === 'all'
  const what = match[2].trim()

  if (what.length < 64) {
    send(msg.chat.id, 'Message too short.')
    return
  }

  send(msg.chat.id, what, { parse_mode: 'HTML', disable_web_page_preview: false })
  if (toAll) {
    cancelBroadcast = false
    send(msg.chat.id, 'Will broadcast in 5 minutes. To cancel, click /_cancel_')
    setTimeout(() => {
      if (!cancelBroadcast) {
        send(msg.chat.id, 'Start broadcasting!')
        broadcastAlert([what, what], 'HTML', true) // use same message for both bot & channel
      } else {
        cancelBroadcast = false
        send(msg.chat.id, 'Broadcast canceled.')
      }
    }, 5 * 60 * 1000)
  }
})

bot.onText(/^\/_cancel_$/, (msg, match) => {
  if (!isAdmin(msg)) return
  cancelBroadcast = true
  send(msg.chat.id, 'Flag set')
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

  const [text, ] = makeAlertMessage(store.last, '')
  send(msg.chat.id, text, { parse_mode: 'HTML' })
})

bot.onText(/\/new/, async (msg, match) => {
  trySaveData(store, msg)
  send(msg.chat.id, 'Bot không còn hỗ trợ tính năng tin tức nữa, vui lòng tham gia group @LaChanCoVy để xem các tin tức đáng chú ý.')
  return

  if (msg.chat.type !== 'private') {
    send(msg.chat.id, 'Không hỗ trợ xem tin tức trong group, vui lòng <a href="https://t.me/CoronaAlertBot">chat riêng với bot</a> hoặc tham gia kênh @LaChanCovy.', { parse_mode: 'HTML' })
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

bot.onText(/\/(status|case|dead|death|vietnam|asean|eu|europe|us|usa|asia|africa|total|global|world)/, (msg, match) => {
  trySaveData(store, msg)
  if (handleNoTalk(msg)) return

  const cmd = match[1]

  let country = msg.text.split(' ').slice(1).join(' ').trim()
  let top = 10
  if (cmd === 'vietnam') {
    country = 'vietnam'
  } else if (['total', 'world', 'global'].includes(cmd)) {
    country = 'world'
  } else if (['eu', 'europe'].includes(cmd)) {
    country = 'europe'
  } else if (['us', 'usa'].includes(cmd)) {
    country = 'usa'
  } else if (['asia'].includes(cmd)) {
    country = 'asia'
  } else if (['africa'].includes(cmd)) {
    country = 'africa'
  } else if (country === 'asean' || cmd === 'asean') {
    country = 'indonesia,singapore,thailand,malaysia,philippines,vietnam,cambodia,brunei,myanmar,laos,timor-leste'
    top = 11
  }

  const byDeath = ['dead', 'death'].includes(cmd)
  const { list, text: mainText } = makeTable(cache, { country, top, byDeath })
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
    text += "Made with ❤️ by <a href='https://t.me/iceteachainvn'>icetea.io</a>"
  }

  send(msg.chat.id, text, makeSendOptions(msg, 'HTML'))
})

bot.onText(/\/(sea?rch|budd?ha|b[aạ]chj?(?:\s+|_)?mai|(?:truong|trường)(?:\s+|_)?sinh)(?:@\w+)?\s*(.*)/i, async (msg, match) => {
  trySaveData(store, msg)
  if (handleNoTalk(msg)) return

  const cmd = replaceVnChars(match[1].toLowerCase().replace(/(\s+|_)/, ''))
  let keyword = match[2].trim().toLowerCase()
  if (keyword === 'hanoi') keyword = 'ha noi'
  let recursive = false
  if (['bachmai', 'bachjmai', 'bachjmai'].includes(cmd)) {
    keyword = 'bạch mai'
  } else if (['buddha', 'budha'].includes(cmd)) {
    keyword = 'buddha'
  } else if ('truongsinh' === cmd) {
    keyword = 'trường sinh'
  }

  recursive = ['bach mai', 'bạch mai', 'buddha', 'trường sinh', 'truong sinh'].includes(keyword)

  if (!keyword) {
    send(msg.chat.id, 'Cần nhập từ khoá tìm kiếm, ví dụ:\n<code>/search bach mai</code>\n<code>/search truong sinh</code>' +
     '\nLệnh tắt cho các từ khoá hay dùng: /bachmai, /truongsinh, /buddha', { parse_mode: 'HTML'})
    return
  }

  if (patients && patients.length) {
    const list = searchPatients([], keyword, recursive)
    if (list.length) {
      send(msg.chat.id, formatSearchResult(keyword, list, recursive), { parse_mode: 'HTML' })
    } else {
      send(msg.chat.id, `Không tìm thấy bệnh bệnh nhân nào cho từ khoá "${keyword}".`, {})
    }
  } else {
    send(msg.chat.id, 'Chưa có thông tin về bệnh nhân, vui lòng thử lại sau.')
  }

})

bot.onText(/\/bn(?:@\w+)?\s*(\d*)/i, async (msg, match) => {
  trySaveData(store, msg)
  if (handleNoTalk(msg)) return

  const num = Number(match[1])
  if (!num) {
    send(msg.chat.id, 'Mã số bệnh nhân không hợp lệ. Cú pháp đúng ví dụ như /bn133')
    return
  }
  const pt = 'BN' + num
  if (num < 17) {
    send(msg.chat.id, `${pt} thuộc nhóm 16 bệnh nhân giai đoạn 1, từ ngày 23/1 đến ngày 13/2, đã khỏi bệnh hoàn toàn.`)
    return
  }

  if (patients && patients.length) {
    const item = patients.find(p => p.bnList.includes(pt))
    if (item) {
      let text = `<b>${escapeHtml(item.bn)}</b>: ${hilightKeywords(escapeHtml(item.content))}`
      const list = searchPatients([], 'bn' + num, false, true)
      if (list.length) {
        text += `\n\n${pt} có thể đã lây cho: ` + patientListToCmdList(list).reverse().join(', ')
      }
      send(msg.chat.id, text, { parse_mode: 'HTML'})
    } else {
      if (store.lastPtCount > num) {
        send(msg.chat.id, `Chưa cập nhật thông tin cho bệnh nhân ${num}, vui lòng đợi khoảng 10 phút.`)
      } else {
        send(msg.chat.id, `Không tìm thấy bệnh nhân ${num}.`)
      }
    }
  } else {
    send(msg.chat.id, 'Chưa có thông tin về bệnh nhân, vui lòng thử lại sau.')
  }

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
    send(msg.chat.id, 'Lệnh này chỉ có tác dụng trong group.')
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
    send(msg.chat.id, 'Admin đã cấm chat lệnh cho bot trong group này. Vui lòng chat riêng với bot.').then(r => {
      setTimeout(() => {
        bot.deleteMessage(r.chat.id, r.message_id).catch(debug)
      }, 10 * 60 * 1000)
    })
  }
  return shouldDeny
}

const searchPatients = (collector, keyword, recursive, excludeSelf) => {
  const bnMatch = keyword.match(/^bn(\d\d\d*)$/i)
  const kwordRegex = new RegExp('\\b' + keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b')
  const hcmNames = ['hcm', 'ho chi minh', 'hồ chí minh', 'saigon', 'sài gòn']
  const isHcm = hcmNames.includes(keyword)
  const keepVN = hasVnChars(keyword)
  const filtered = patients.filter(p => {
    if (collector.includes(p)) return false
    if (excludeSelf && bnMatch && p.bnList.some(bn => bn.toLowerCase() === keyword)) return false

    let c = p.content.toLowerCase()
    if (!keepVN) c = replaceVnChars(c)
    if (bnMatch) {
      const ddd = bnMatch[1]
      return c.match(kwordRegex) || c.match(new RegExp(`benh\\s+nhan\\s+(so\\s+)?${ddd}`))
    } else if (isHcm) {
      return hcmNames.some(name => c.includes(name))
    } else if (['bạch mai', 'bach mai'].includes(keyword)) {
      return ['bạch mai', 'bach mai', 'trường sinh', 'truong sinh'].some(name => c.includes(name))
    } else {
      return c.match(kwordRegex)
    }
  })

  collector.push(...filtered)

  // search recursive
  if (recursive) {
    filtered.forEach(p => {
      p.bnList.forEach(bn => {
        searchPatients(collector, bn.toLowerCase(), true, excludeSelf)
      })
    })
  }

  return collector

}

const hilightKeywords = (t, forChannel) => {
  return [/(bạch mai)/gi, /(buddha)/gi].reduce((s, w) => s.replace(w, (m, p) => {
    if (forChannel) {
      return `<b>${p}</b>`
    }
    return '/' + replaceVnChars(p.toLowerCase()).replace(/ /g, '_')
  }), t)
}

const patientListToCmdList = list => list.reduce((ps, p) => ps = ps.concat(p.bnList), [])
  .sort((a, b) => +b.slice(2) - +a.slice(2))
  .map(s => `/${s}`)

const formatSearchResult = (keyword, list, showAll) => {
  list = patientListToCmdList(list)
  const show = 15
  let s
  if (showAll || list.length <= show) {
    s = list.join(', ')
  } else {
    const more = list.length - show
    s = list.slice(0, show).join(', ') + ` và ${more} bệnh nhân khác.`
  }
  return `Tìm thấy <b>${list.length}</b> bệnh nhân có từ khoá "<i>${keyword}</i>": ${s}`
}

const wakeAlerter = (m, parseMode) => {
  const alerter = Number(process.env.ALERTER)
  if (alerter) send(alerter, m, makeSendOptions(alerter, parseMode))
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
      name = escapeHtml(name)
      const link = value.username ? `<a href="https://t.me/${value.username}">${name}</a>` : name
      groups.push(`${i}. ${link}`)
      i++
    }
    return groups
  }, [])

  return lines
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

const makeSendOptions = (msg, parseMode, showPreview) => {
  const options = {
    disable_web_page_preview: !showPreview,
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
    s = s.replace(/THÔNG\s+(?:TIN|BÁO)\s+(?:VỀ)*\s*(\d+ )*\s*CA\s+BỆNH(?:\s+SỐ)*/g, 'THÔNG BÁO $1CA BỆNH')
      .replace(/(?:TỪ )?(\d\d\d+)\s*(?:ĐẾN|\-)\s*(\d\d\d+)$/, '$1~$2')
    if (s.endsWith('CỦA BỘ Y TẾ')) s = s.replace('CỦA BỘ Y TẾ', '').trim()
    return '<b>' + escapeHtml(s) + '</b>'
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
    if (!a.length || (t.length > 20 && c === c.toUpperCase())) {
      a.push(t)
    } else {
      a[a.length - 1] += `;${s}`
    }
    return a
  }, []).map(l => {
    return escapeHtml(l).replace(/^(?:BN|bệnh\s+nhân\s+(?:số |thứ )?)\s*(\d\d+)(?:\s*\(BN\1\))?/i, '<b>BN$1</b>')
  })
}

const formatAlert = text => {

  // prevent message too long, we truncate 3600 letters
  const moreText = '... [lược bớt do qúa dài]'
  if (text.length > 3600) {
    text = text.slice(0, 3600 - moreText.length) + '... [lược bớt do qúa dài]'
  }

  let [title, ...rest] = text.split(':')
  title = formatAlertTitle(title)
  if (title) {
    text = rest.join(':').trim()
    // ensure first letter is uppercase
    text = upperFirstChar(text)
  } else {
    title = ''
  }

  const formatted = text.includes('\r') || text.includes('\n')

  let bodyChannel = text
  if (!formatted) {
    const lines = getLines(text)
    bodyChannel = lines.join('.\n\n')
      .replace(/:\s*1\./g, ':\n\n1.')
      .replace(/\.\s*(BN\d\d\d+)(\s*(\:|\,|là\s+nam|là\s+nữ))/gi, '.\n\n<b>$1</b>$2')
      .replace(/\-\s*((BN|CA\s*B.NH)\s*\d\d\d+)/gi, '\n\n🦠 <b>$1</b>')
      // .replace(/\n\s*\n\s*\n/g, '\n\n')
  } else {
    bodyChannel = text.replace(/\-\s*((BN|CA\s*B.NH)\s*\d\d\d+)/gi, '🦠 <b>$1</b>')
  }
  let forBot = bodyChannel

  const promo4Bot = process.env.PROMOTE_4BOT.trim()
  if (promo4Bot) {
    forBot += '\n\n' + promo4Bot
  }

  const promo4Channel = process.env.PROMOTE_4CHANNEL.trim()
  if (promo4Channel) {
    bodyChannel += '\n\n' + promo4Channel
  }

  return { title, body: hilightKeywords(forBot), bodyChannel: hilightKeywords(bodyChannel, true) }
}

const makeAlertMessage = ({ time, content }, hilight = '‼️') => {
  let { title, body, bodyChannel } = formatAlert(content)
  const pad = '~'.repeat(2 + (hilight ? 1 : 0))
  let subtitle = `${pad}${time} - BỘ Y TẾ${pad}\n\r`
  if (!title) {
    title = `${time} - BỘ Y TẾ`
    hilight = ''
    subtitle = '~'.repeat(23 + (hilight ? 4 : 0))
  }
  let header = `${hilight + title + hilight}\n\r${subtitle}\n\r`
  return [`${header}${linkify(body)}`, `${header}${linkify(bodyChannel, true)}`]
}

const broadcastAlert = ([botText, channelText], parseMode = 'HTML', showPreview) => {
  const includes = arrayFromEnv('INCLUDE')
  const exclude = arrayFromEnv('EXCLUDE')

  const subs = Array.from(new Set(Object.keys(store.subs || {}).concat(includes)))
  if (!subs || !subs.length) return

  let timeout = 0
  subs.forEach(chatId => {
    if (exclude.includes(chatId)) return
    if ((store.subs[chatId] || {}).noAlert) return

    const sanitizedId = sanitizeChatId(chatId)
    const isChannel = typeof sanitizedId === 'string' && sanitizedId.startsWith('@')
    const text = isChannel ? channelText : botText
    timeout += 75
    const options = makeSendOptions(sanitizedId, parseMode, showPreview)
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
  const freshDuration = +process.env.ALERT_FRESH_DURATION || 180 * 60 * 1000

  return age < freshDuration
}

// Data on the timeline https://ncov.moh.gov.vn/dong-thoi-gian and
// the homepage 'https://ncov.moh.gov.vn/' is not in sync
// Sometimes the timeline is earlier, sometimes the homepage is earlier :D
const randUrl = () => {
  const urls = [
    'https://ncov.moh.gov.vn/',
    'https://ncov.moh.gov.vn/dong-thoi-gian'
  ]
  const index = Math.floor(Math.random() * urls.length)
  const otherIndex = index === 0 ? 1 : 0
  return { main: urls[index], backup: urls[otherIndex] }
}

const updateAlert = async url => {
  const { main, backup } = randUrl()
  const tryAgain = () => {
    if (url == null) {
      debug('Main URL failed, fallover to backup', main, backup)
      updateAlert(backup)
    }
  }
  const fetchUrl = url || main
  const res = await fetch(fetchUrl)
  if (!res) return tryAgain()

  const $ = cheerio.load(res.data)

  const $this = $('.timeline-detail').eq(0)
  const time = $this.find('.timeline-head').text().trim()
  if (!time) return tryAgain()

  const timestamp = getTimestamp(time)
  const content = $this.find('.timeline-content').text().trim()

  const event = { timestamp, time, content }
  const lastEvent = store.last
  if (!hasLastAlert(lastEvent) || isNewAlert(lastEvent, event)) {
    store.last = event
    saveData(store).then(() => {
      // only broadcast if this is not first crawl
      lastEvent && lastEvent.timestamp && isNewAlert(lastEvent, event) && broadcastAlert(makeAlertMessage(event))
    }).catch(debug)
  }
}

const extractNumber = bn => {
  bn = bn.toUpperCase()
  if (bn.startsWith('BN')) bn = bn.slice(2)
  return bn
}

const handleVNRowChange = () => {
  if (patients.length) {
    const old = store.lastPtRowCount
    store.lastPtRowCount = patients.length
    if (old && old < patients.length) {
      // recent (bigger number) are at the begining of patients array

      const newPts = patients.slice(0, patients.length - old)
      let bnList = []
      const mess = newPts.reduce((m, p) => {
        m.push(`<b>${escapeHtml(p.bn)}</b>: ${escapeHtml(p.content)}`)
        bnList = bnList.concat(p.bnList)
        return m
      }, []).join('\n\n')
      bnList = bnList.sort()
      const bn = bnList.length <= 1 ? bnList[0] : `${extractNumber(bnList[0])}~${extractNumber(bnList[bnList.length - 1])}`
      const title = `<b>‼️THÔNG BÁO CA BỆNH ${bn}‼️</b>`
      wakeAlerter(`${title}\n\n${mess}`, 'HTML')
    }
  }
}

const handleVNCaseChange = () => {
  const caseCnt = Number(cache.vietnam.cases)
  if (caseCnt) {
    const old = store.lastPtCount
    store.lastPtCount = caseCnt
    if (old && old < caseCnt) {
      wakeAlerter(`Có thêm ca bệnh mới: ${old + 1}~${caseCnt}`)
    }
  }
}

// because Vietnam's cases are reported earlier on MoH site than on Worldometers
const updateVietnamData = async () => {
  const res = await fetch('https://ncov.moh.gov.vn/')

  if (!res) {
    debug('Fallback to zingnews.vn because of failture loading cases from MoH.')
    updateVietnamDataFromZing()
    return
  }

  const $ = cheerio.load(res.data)
  const cases = $('.box-tke .text-danger-new .font24').eq(0).text()
  const deaths = $('.box-tke .text-danger-new1 .font24').eq(0).text()

  if (cases) {
    cache.vietnam = Object.assign(cache.vietnam || {}, { cases, deaths: deaths || '0' })
    handleVNCaseChange()
  } else {
    updateVietnamDataFromZing()
  }
}

const updatePatientList = async () => {

  const res = await fetch('https://raw.githubusercontent.com/TradaTech/coronavirus_bot/master/bn.txt')
  if (!res) return

  // now, update patient list
  const lines = res.data
    .split('*')
  const patientList = lines.reduce((list, line) => {
    line = line.trim()
    if (!line.length) return list

    const [bn, ...rest] = line.split(':')
    const bnList = bn.split(',').map(s => s.trim()).reduce((list, b) => {
      const m = b.match(/BN(\d+)\s+đến\s+BN(\d+)/i)
      if (m && m.length) {
        const from = Number(m[1])
        const to = Number(m[2])
        for (let i = from; i <= to; i++) {
          list.push('BN' + i)
        }
      } else {
        list.push(b.replace(/\s+/g, ''))
      }
      return list
    }, [])
    //  .join(',').split('đến').map(s => s.trim()).join('~')
    const content = linkify(rest.join(':').trim().replace(/[-;]\s*(BN\d\d+)\s*:\s*/gi, '\n- $1: '))
    list.push({bn, bnList, content})
    return list
  }, [])

  if (patientList && patientList.length) {
    patients = patientList
    handleVNRowChange()
  }
}

const linkify = (s, forChannel) => s.replace(/(BN|bệnh\s+nhân\s+(?:số |thứ )?)\s*(\d\d+)(?:\s*\(BN\1\))?/gi, forChannel ? '<b>$1$2</b>' : '/BN$2')

const updateVietnamDataFromZing = async () => {
  const res = await fetch('https://zingnews.vn/dich-viem-phoi-corona.html')
  if (!res) return

  const $ = cheerio.load(res.data)
  const script = $('#corona-table-n-map script').html()
  if (!script) return

  const m = script.match(/"title":\s*"Việt Nam",\s*"cases":\s*(\d+),\s*"deaths":\s*(\d+),/)

  if (m && m[1]) {
    cache.vietnam = Object.assign(cache.vietnam || {}, { cases: m[1], deaths: m[2] || '0' })
    handleVNCaseChange()
  }
}

const parseData = ($, day, array) => {
  const headers = ['country', 'cases', 'newCases', 'deaths', 'newDeaths', 'recovered', 'newRecovered', 'activeCases', 'criticalCases', 'casesPerM', 'deathsPerM']
  $(`#main_table_countries_${day} tbody tr`).each((rowNum, tr) => {
    const $cells = $(tr).find('td')
    const row = {}
    headers.forEach((h, i) => {
      // skip # column so use (i + 1)
      row[h] = $cells.eq(i + 1).text().trim()
    })
    array.push(row)
  })
}

const getStatus = async () => {
  const res = await fetch('https://www.worldometers.info/coronavirus/')
  if (!res) return

  const $ = cheerio.load(res.data)

  const d = {
    global: {},
    byCountry: [],
    yesterday: []
  }

  const $global = $('.maincounter-number span')
  d.global.cases = $global.eq(0).text().trim()
  d.global.deaths = $global.eq(1).text().trim()
  d.global.decovered = $global.eq(2).text().trim()

  parseData($, 'today', d.byCountry)
  parseData($, 'yesterday', d.yesterday)

  cache = d
}

const hasNewCases = (data, c = 'Italy') => {
  const item = search(c, false, data)
  return Boolean(item && item.newCases && item.newCases.trim().length)
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
    countries = Array.from(new Set(countries))
  }

  const sortProps = !byDeath ? ['cases', 'deaths'] : ['deaths', 'cases']
  countries = sortRowBy(countries, ...sortProps)
  if (countries.length > 1) {
    const list = ['Total:', 'World', 'Europe', 'North America', 'South America', 'Asia', 'Africa', 'Oceania']
    countries = countries.filter(c => !list.includes(c.country))
  }
  return countries.slice(0, top)
}

const makeVNCases = () => {
  const { cases, /* newCases, */ deaths } = patchVietnamData(cache.byCountry, cache.vietnam, true) || {}
  if (cases == null) return 'N/A'
  let t = cases + ' ca'
  if (deaths) t += ` (<b>${deaths}</b> tử vong)`
  return t
}

const makeShortCountry = c => {
  if (NAMES[c]) return NAMES[c]
  return c.replace(' ', '').substr(0, 9)
}

const patchNewCases = (data, hasNew) => {
  return data.map(row => {
    const yRow = search(row.country, true)
    if (yRow) {
      row = { ...row }
      row.todayNewCases = row.newCases
      row.yesterNewCases = yRow.newCases
      row.todayNewDeaths = row.newDeaths
      row.yesterNewDeaths = yRow.newDeaths
      if (!hasNew) {
        row.newCases = yRow.newCases
        row.newDeaths = yRow.newDeaths
      }
    }
    return row
  })
}

const makeTable = (data, filter) => {
  const hasNew = hasNewCases(data)
  const byDeath = !!filter.byDeath
  const newText = hasNew ? 'Mới' : 'H.Qua'
  const headers = !byDeath ? [['Nước', '     Nhiễm', newText]] : [['Nước', ' Tử vong', newText]]
  let topData = getTop(data, filter)

  if (!topData) {
    return { text: 'Chưa có dữ liệu, vui lòng thử lại sau.' }
  }

  if (!topData.length) {
    return { text: 'Không tìm thấy. Tên nước phải bằng tiếng Anh, kiểm tra lại xem có bị sai không?' }
  }

  topData = patchNewCases(topData, hasNew)

  if (topData.length > 1) {
    let hasChina = false
    const rows = topData.map(({ country, cases, newCases, deaths, newDeaths }) => {
      !hasChina && (hasChina = country === 'China')
      const shortCountry = makeShortCountry(country)
      const nc = (newCases.length === 7 & newCases[0] === '+') ? newCases.slice(1) : newCases
      const td = deaths // (deaths.length > 6) ? deaths.replace(',', '') : deaths
      const tc = cases //(cases.length > 8) ? cases.replace(',', '') : cases
      // if (!byDeath && headers[0][1].length < tc.length + 2) {
      //   headers[0][1] = ' '.repeat(tc.length - 3) + 'Nhiễm'
      // }
      return !byDeath
        ? [shortCountry, tc, nc]
        : [shortCountry, td, newDeaths]
    })

    let lines = table(headers.concat(rows), {
      align: ['l', 'r', 'r', 'r'],
      padding: false,
      delimiterStart: false,
      delimiterEnd: false
    }).split('\n').map((s, i) => {
      return s.replace('|', '')
    })

    const wrapLimit = 25
    const delta = lines[0].length - wrapLimit
    if (delta > 0) {
      lines = lines.map((s, i) => s.replace(i === 1 ? '-' : ' ', ''))
    } else if (delta <= -2) {
      lines = lines.map((s, i) => s.replace('|', i === 1 ? '-|-' :' | '))
    }
    
    text = lines.join('\n').replace(/\:/g, '-').replace(/\|/g, '¦')

    return { list: true, hasChina, text }
  } else {
    const {
      country, cases, todayNewCases, yesterNewCases, deaths, todayNewDeaths, yesterNewDeaths,
      recovered, activeCases, criticalCases, casesPerM, deathsPerM
    } = topData[0]
    const hasChina = country === 'China'
    const isTotal = country === 'Total:'
    const text = [
      `<b>${country}</b>`,
      '~~~',
      `Ca nhiễm: <b>${cases}</b>`,
      `${hasChina ? '- Hôm qua' : '- Mới'}: <b>${todayNewCases || 0}</b>`,
      `${hasChina ? '- Hôm kia' : '- Hôm qua'}: <b>${yesterNewCases || 0}</b>`,
      `Tử vong: <b>${deaths || 0}</b>`,
      `${hasChina ? '- Hôm qua' : '- Mới'}: <b>${todayNewDeaths || 0}</b>`,
      `${hasChina ? '- Hôm kia' : '- Hôm qua'}: <b>${yesterNewDeaths || 0}</b>`,
      `Đã khỏi: <b>${recovered || 0}</b>`,
      `Chưa khỏi: <b>${activeCases || 0}</b>`,
      `Bệnh nặng: <b>${criticalCases || 0}</b>`,
      `Số ca/1tr dân: <b>${casesPerM || 0}</b>`,
      `Tử vong/1tr dân: <b>${deathsPerM || 0}</b>`
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

const search = (country, yesterday, data) => {
  return (data || cache)[yesterday ? 'yesterday' : 'byCountry'].find(c => c.country === country)
}

const updateStatus = async () => {
  await getStatus()
  await updateVietnamData()
  if (!cache.vietnam || !cache.vietnam.cases) {
    cache.vietnam = search('Vietnam')
  }

  updatePatientList()

  updateAlert()
  //updateNews()
}

const start = async () => {
  updateStatus()
  setInterval(updateStatus, +process.env.RELOAD_EVERY || 30000)
}

start().catch(debug)
