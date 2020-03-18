const fs = require('fs')
const debug = require('debug')('bot:persist')
const { pickChatData } = require('./util')

const fileName = './save.txt'

exports.loadData = () => {
  return JSON.parse(fs.readFileSync(fileName).toString('utf-8'))
}

exports.saveData = data => {
  return new Promise((resolve, reject) => {
    fs.writeFile(fileName, JSON.stringify(data), (err, value) => {
      if (err) return reject(err)
      resolve(value)
    })
  })
}

exports.tryLoadData = () => {
  try {
    return exports.loadData()
  } catch (err) {
    debug(err)
    return {}
  }
}

exports.trySaveData = (data, msg) => {
  if (msg && msg.chat.id) {
    const info = pickChatData(msg.chat)
    info.date = msg.date
    data.subs[msg.chat.id] = info
  }
  setTimeout(() => exports.saveData(data).catch(debug), 0)
}
