require('dotenv').config()
const { sendDirect } = require('./send')

// Require the framework and instantiate it
const fastify = require('fastify')({
    logger: false
})

fastify.get('/', (req, res) => {
    res.send('https://t.me/LaChanCovy')
})

// Declare a route
fastify.post(`/hooks/${process.env.NEWS_HVALUE}`, (req, res) => {
    console.log(req.body)
    sendDirect(JSON.stringify(req.body))
    res.send('Thank Lotus Team!')
})

// Run the server!
fastify.listen(process.env.LOTUS_PORT, function (err, address) {
    if (err) {
        fastify.log.error(err)
        process.exit(1)
    }
    console.log(`Lotus hook server listening on ${address}`)
})
