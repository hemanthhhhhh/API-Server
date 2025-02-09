const express = require('express')
const { generateSlug } = require('random-word-slugs')
const { ECSClient, RunTaskCommand } = require('@aws-sdk/client-ecs')
const cors = require('cors');
const { Server } = require('socket.io')
const Redis = require('ioredis')

const app = express()
const PORT = 9000

const REDIS_URL = process.env.REDIS_URL

const subscriber = new Redis(REDIS_URL)

subscriber.ping()
  .then(response => console.log('Redis PING Response:', response))
  .catch(err => console.error('Redis Connection Failed:', err))

const io = new Server({ cors: '*' })

io.on('connection', socket => {
    socket.on('subscribe', channel => {
        socket.join(channel)
        socket.emit('message', `Joined ${channel}`)
    })
})

io.listen(9002, () => console.log('Socket Server 9002'))


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

app.use(cors());
app.use(express.json())

app.post('/project', async(req, res) => {

    const { gitURL, slug } = req.body
    const projectSlug = slug ? slug : generateSlug()
    
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

    return res.json({ status: 'queued', data: { projectSlug, url: `http://${projectSlug}.localhost:8000` } })

})

// async function initRedisSubscribe() {
//     console.log('Subscribed to logs....')
//     subscriber.psubscribe('logs:*')
//     subscriber.on('pmessage', (pattern, channel, message) => {
//         io.to(channel).emit('message', message)
//     })
// }

async function initRedisSubscribe() {
    console.log('Subscribed to logs....');
    subscriber.psubscribe('logs:*');

    subscriber.on('pmessage', (pattern, channel, message) => {
        try {
            const parsedMessage = JSON.parse(message); // Ensure JSON
            io.to(channel).emit('message', parsedMessage);
        } catch (error) {
            console.warn(`Received non-JSON message on ${channel}:`, message);
            io.to(channel).emit('message', { error: "Non-JSON message received", rawMessage: message });
        }
    });
}


initRedisSubscribe()

app.listen(PORT, () => console.log(`API Server Running..${PORT}`))