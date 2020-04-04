const { fetch } = require('./util')
const { escapeHtml } = require('./util')

const getAdjustedDate = item => {
  let mil
  if (item.card_info.created_at) {
    mil = item.card_info.created_at * 1000 + 420 * 60 * 1000
  } else {
    const info = item.data[0]
    if (info.created_at) {
      const d = new Date(t)
      mil = d.getTime() + d.getTimezoneOffset() * 60 * 1000
    }
  }
  return mil ? new Date(mil).toLocaleString('vi-VN') : ''
}

const getLink = item => {
  const info = item.data[0]
  if (info && info.link) return info.link
  return item.link_share
}

const getTitle = item => {
  const info = item.data[0]
  if (info && info.sapo) return info.sapo
  return item.title
}

exports.getNews = () => {
  const url = process.env.NEWS_URL
  const hname = process.env.NEWS_HNAME
  const hvalue = process.env.NEWS_HVALUE

  return fetch(url, {
    [hname]: hvalue
  }).then(({ data = { data: [] } } = {}) => {
    return data.data.reduce((list, item, index) => {
      if (item.data && item.data.length) {
        const date = getAdjustedDate(item)
        const link = getLink(item)
        const title = getTitle(item)
        const text = `<b>${date}</b> <i>(tin số ${index + 1}/${data.data.length})</i>\n${escapeHtml(title)}\n\n<a href='${link}'>Mở link</a>`
        list.push(text)
      } else {
        list.push(item.link_share)
      }
      return list
    }, [])
  })
}

exports.getNewsItem = item => {
  if (item.data && item.data.length) {
    const link = getLink(item)
    //const date = getAdjustedDate(item)
    const title = getTitle(item)
    //const text = `<b>${date}</b>\n${escapeHtml(title)}\n\n${link}`
    const text = `${title}\n\n${link}`
    return text
  } else {
    return item.link_share
  }
}