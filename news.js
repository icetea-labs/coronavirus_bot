const { fetch } = require('./util')

exports.getNews = () => {
  const url = process.env.NEWS_URL
  const hname = process.env.NEWS_HNAME
  const hvalue = process.env.NEWS_HVALUE

  return fetch(url, {
    [hname]: hvalue
  }).then(({ data }) => {
    return data.data.reduce((list, item, index) => {
      if (item.data && item.data.length) {
        const info = item.data[0]
        const date = new Date(info.created_at).toLocaleString('vi-VN')
        const link = info.link
        const text = `<b>${date}</b> <i>(tin số ${index + 1}/${data.data.length})</i>\n${item.title}\n\n<a href='${link}'>Mở link</a>`
        list.push(text)
      } else {
        list.push(item.link_share)
      }
      return list
    }, [])
  })
}
