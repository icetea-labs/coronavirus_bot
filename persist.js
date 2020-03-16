const fs = require('fs')
const debug = require('debug')('bot:persist')

const fileName = './save.txt'

exports.loadNews = () => {
  return JSON.parse(fs.readFileSync(fileName).toString('utf-8'))
}

exports.saveNews = news => {
  return new Promise((resolve, reject) => {
    fs.writeFile(fileName, JSON.stringify(news), (err, data) => {
      if (err) return reject(err)
      resolve(data)
    })
  })
}

exports.tryLoadNews = () => {
  try {
    return exports.loadNews()
  } catch (err) {
    debug(err)
    return {}
  }
}

exports.trySaveNews = (news, msg) => {
  if (msg && msg.chat.id) {
    const data = {
      date: msg.date,
      ...msg.chat
    }
    delete data.id // id already used as key
    news.subs[msg.chat.id] = data
  }
  setTimeout(() => exports.saveNews(news).catch(debug), 0)
}
