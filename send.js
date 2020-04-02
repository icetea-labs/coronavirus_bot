const querystring = require('querystring');
const https = require('https');

exports.sendDirect = options => {
    if (typeof options === 'string') options = { text: options }
    const postData = querystring.stringify({
        chat_id: process.env.ALERTER,
        ...options
    });

    const opts = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${process.env.BOT_TOKEN}/sendMessage`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': postData.length
        }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(opts, (res) => {
            let body = ''
            res.on('data', d => {
                body += d
            })
            res.on('end', () => {
                res.body = JSON.parse(body)
                resolve(res)
            })
        })

        req.on('error', reject)

        req.write(postData)
        req.end()
    })
}