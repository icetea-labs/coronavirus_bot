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
  return bot.editMessageText(text, options).catch(err => handleTelegramError(err, 'editMessageText', `${options.chat_id}/${options.message_id}`, text))
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
