const fileName = './save.txt'
const fs = require('fs')

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
    console.error(err)
    return {}
  }
}

exports.trySaveNews = (news, msg) => {
  news.subs[msg.chat.id] = Date.now()
  setTimeout(() => exports.saveNews(news).catch(console.error), 0)
}
