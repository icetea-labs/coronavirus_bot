require('dotenv').config()
const axios = require('axios')
const cheerio = require('cheerio')
const TelegramBot = require('node-telegram-bot-api');
const table = require('markdown-table')

let cache = {
    global: {},
    vietnam: {},
    byCountry: []
}

const token = process.env.BOT_TOKEN
const bot = new TelegramBot(token, { polling: true });

bot.onText(/\/start/, (msg, match) => {
    bot.sendMessage(msg.chat.id, 'Type /status to view latest #coronavirus (COVID-19) data.');
})

bot.onText(/\/status/, (msg, match) => {
    const chatId = msg.chat.id;
    let text = `<b>Global</b>: ${cache.global.cases} cases (${cache.global.deaths} deaths)\n\r`
    text += `<b>Vietnam</b>: ${makeCases(cache.vietnam.cases, cache.vietnam.newCases)}\n\r`
    text += '~~~\n\r'
    text += `<pre>${makeTable(cache)}</pre>`
    text += '\n\r~~~\n\r'
    text += 'Made with love by @iceteachainvn'
    bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true });
})

// because Vietnam's cases are reported earlier on VN newspaper
const updateVietnamData = async (url = 'https://news.zing.vn') => {
    const res = await axios.get(url)

    if (res.status !== 200) {
        return console.error(`${res.status}: ${res.statusText}`)
    }

    const $ = cheerio.load(res.data)
    const script = $('#widget-ticker script').html()
    const m = script.match(/"title":\s*"Việt Nam",\s*"cases":\s*(\d+),\s*"deaths":\s(\d+),/)
    
    cache.vietnam = Object.assign(cache.vietnam || {}, { cases: m[1], deaths: m[2]})
}

const getStatus = async (url = 'https://www.worldometers.info/coronavirus/') => {
    const res = await axios.get(url)

    if (res.status !== 200) {
        return console.error(`${res.status}: ${res.statusText}`)
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

    const headers = ['country', 'cases', 'newCases', 'deaths']
    $('#main_table_countries tbody tr').each((rowNum, tr) => {
        const $cells = $(tr).find('td')
        const row = {}
        headers.forEach((h, i) => {
            row[h] = $cells.eq(i).text().trim()
        })
        // make shorter for small screens
        row.country = row.country.replace(' ', '').substr(0, 7)
        d.byCountry.push(row)
    })

    return d
}

const getTop = (data, top = 10) => {
    return data.byCountry.filter((c, i) => i < top)
}

const makeCases = (cases, newCases) => {
    let t = cases + ' cases'
    if (newCases) t += ` (${newCases})`
    return t
}

const makeTable = (data, top = 10) => {
    const headers = [['Country', 'Cases', 'New', 'Death']]
    const topData = getTop(cache).map(Object.values)
    const rows = headers.concat(topData)

    return table(rows, {
        align: ['l', 'r', 'r', 'r'],
        padding: false,
        delimiterStart: false,
        delimiterEnd: false })
}

const updateStatus = async () => {
    cache = await getStatus()
    await updateVietnamData()
    if (!cache.vietnam || !cache.vietnam.cases) {
        cache.vietnam = cache.byCountry.find(c => c.country === 'Vietnam') || {}
    }
}

const start = async () => {
    updateStatus()
    setInterval(updateStatus, +process.env.RELOAD_EVERY || 30000);
}

start().catch(console.error)