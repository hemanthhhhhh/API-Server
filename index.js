const express = require('express')
const { generateSlug } = require('random-word-slugs')
const { ECSClient, RunTaskCommand } = require('@aws-sdk/client-ecs')
const cors = require('cors')
const Redis = require('ioredis')
const { Server } = require('socket.io')
const http = require('http') // Required to merge API & Socket.io

const app = express()
const server = http.createServer(app) // Merge API & WebSockets into one server
const PORT = process.env.PORT || 9000 // Use dynamic Render port

const REDIS_URL = process.env.REDIS_URL
const subscriber = new Redis(REDIS_URL)

subscriber.ping()
  .then(response => console.log('Redis PING Response:', response))
  .catch(err => console.error('Redis Connection Failed:', err))

// ✅ Initialize Socket.io on the same server
const io = new Server(server, { cors: { origin: '*' } })
io.on('connection', socket => {
    console.log(`New client connected: ${socket.id}`)

    socket.on('subscribe', channel => {
        socket.join(channel)
        socket.emit('message', `Joined ${channel}`)
    })

    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`)
    })
})

const ecsClient = new ECSClient({
    region: 'ap-south-1',
    credentials: {
        accessKeyId: process.env.ACCESS_KEY_ID,
        secretAccessKey: process.env.SECRET_KEY 
    }
})

const config = {
    CLUSTER: process.env.CLUSTER,
    TASK: process.env.TASK
}

app.use(cors())
app.use(express.json())

app.post('/project', async(req, res) => {
    const { gitURL, slug } = req.body
    const projectSlug = slug || generateSlug()
    
    const command = new RunTaskCommand({
        cluster: config.CLUSTER,
        taskDefinition: config.TASK,
        launchType: 'FARGATE',
        count: 1,
        networkConfiguration: {
            awsvpcConfiguration: {
                assignPublicIp: 'ENABLED',
                subnets: [process.env.SUBNET1, process.env.SUBNET2, process.env.SUBNET3],
                securityGroups: [process.env.SECURITY]
            }
        },
        overrides: {
            containerOverrides: [
                {
                    name: 'vercel-image',
                    environment: [
                        { name: 'GIT_REPOSITORY__URL', value: gitURL },
                        { name: 'PROJECT_ID', value: projectSlug }
                    ]
                }
            ]
        }
    })

    await ecsClient.send(command);

    return res.json({ status: 'queued', data: { projectSlug, url: `https://reverse-proxy-9v2j.onrender.com/${projectSlug}` } })
})

async function initRedisSubscribe() {
    console.log('Subscribed to logs....')
    subscriber.psubscribe('logs:*')

    subscriber.on('pmessage', (pattern, channel, message) => {
        try {
            const parsedMessage = JSON.parse(message)
            io.to(channel).emit('message', parsedMessage)
        } catch (error) {
            console.warn(`Received non-JSON message on ${channel}:`, message)
            io.to(channel).emit('message', { error: "Non-JSON message received", rawMessage: message })
        }
    })
}

// ✅ Start the unified server
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`)
    initRedisSubscribe()
})
