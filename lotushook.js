require('dotenv').config()
const { sendDirect } = require('./send')
const { getNewsItem } = require('./news')

// Require the framework and instantiate it
const fastify = require('fastify')({
    logger: false
})

fastify.get('/', (req, res) => {
    res.type('html').send(`<script>location.href='https://t.me/LaChanCovy';</script>`)
})

// Declare a route
fastify.post(`/hooks/${process.env.NEWS_HVALUE}`, (req, res) => {
    sendDirect(getNewsItem(req.body))
    res.send('Thank Lotus Team!')
})

// Run the server!
fastify.listen(process.env.LOTUS_PORT, function (err, address) {
    if (err) {
        console.error(err)
        process.exit(1)
    }
    console.log(`Lotus hook server listening on ${address}`)
})
