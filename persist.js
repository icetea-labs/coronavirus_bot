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

const inject = (data, msg, info, prop, value) => {
  if (value != null) {
    if (value) info[prop] = value
  } else {
    const old = data.subs[msg.chat.id]
    const oldNoAlert = old != null ? old[prop] : false
    if (oldNoAlert) info[prop] = oldNoAlert
  }
}

exports.trySaveData = (data, msg, noAlert, noTalk) => {
  if (msg && msg.chat.id) {
    const info = pickChatData(msg.chat)
    info.date = msg.date
    inject(data, msg, info, 'noAlert', noAlert)
    inject(data, msg, info, 'noTalk', noTalk)

    data.subs[msg.chat.id] = info
  }
  setTimeout(() => exports.saveData(data).catch(debug), 0)
}
