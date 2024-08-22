require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const textToSpeech = require('@google-cloud/text-to-speech');
const AWS = require('aws-sdk');
const fetch = require('node-fetch');
const redis = require('redis');
const util = require('util');
const logger = require('./logger');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

app.use(express.json());

const ttsClient = new textToSpeech.TextToSpeechClient();
const s3 = new AWS.S3();
const redisClient = redis.createClient();
const getAsync = util.promisify(redisClient.get).bind(redisClient);
const setAsync = util.promisify(redisClient.set).bind(redisClient);

async function synthesizeSpeech(text, language) {
  const cacheKey = `speech:${language}:${text}`;
  const cachedAudio = await getAsync(cacheKey);
  
  if (cachedAudio) {
    return Buffer.from(cachedAudio, 'base64');
  }
  
  const request = {
    input: {text: text},
    voice: {languageCode: language, ssmlGender: 'NEUTRAL'},
    audioConfig: {audioEncoding: 'MP3'},
  };
  const [response] = await ttsClient.synthesizeSpeech(request);
  
  await setAsync(cacheKey, response.audioContent.toString('base64'));
  
  return response.audioContent;
}

async function createVideo(text, avatarUrl, socket) {
  socket.emit('progress', { stage: 'Started', progress: 0 });
  
  const response = await fetch('https://api.synthesia.io/v2/videos', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SYNTHESIA_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      script: text,
      avatar: {
        type: 'url',
        url: avatarUrl
      },
      background: 'office_01',
      voice: 'en-US-Neural2-F'
    })
  });
  
  socket.emit('progress', { stage: 'Processing', progress: 50 });
  
  const result = await response.json();
  
  socket.emit('progress', { stage: 'Completed', progress: 100 });
  
  return result;
}

async function uploadToS3(file, fileName) {
  const params = {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: fileName,
    Body: file
  };
  return await s3.upload(params).promise();
}

async function generateDocumentation(projectDescription) {
  const response = await fetch('https://api.openai.com/v1/engines/davinci-codex/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      prompt: `Generate a technical summary for the following project:\n${projectDescription}`,
      max_tokens: 500
    })
  });
  return await response.json();
}

app.post('/api/synthesize-speech', async (req, res) => {
  try {
    const { text, language } = req.body;
    const audioContent = await synthesizeSpeech(text, language);
    res.send(audioContent);
  } catch (error) {
    logger.error('Error in speech synthesis:', error);
    res.status(500).send('An error occurred during speech synthesis');
  }
});

app.post('/api/create-video', async (req, res) => {
  const { text, avatarUrl, socketId } = req.body;
  const socket = io.sockets.sockets.get(socketId);
  try {
    const video = await createVideo(text, avatarUrl, socket);
    res.json(video);
  } catch (error) {
    logger.error('Error in video creation:', error);
    res.status(500).send('An error occurred during video creation');
  }
});

app.post('/api/upload-file', async (req, res) => {
  try {
    const { file, fileName } = req.body;
    const result = await uploadToS3(file, fileName);
    res.json(result);
  } catch (error) {
    logger.error('Error in file upload:', error);
    res.status(500).send('An error occurred during file upload');
  }
});

app.post('/api/generate-documentation', async (req, res) => {
  try {
    const { description } = req.body;
    const documentation = await generateDocumentation(description);
    res.json(documentation);
  } catch (error) {
    logger.error('Error in documentation generation:', error);
    res.status(500).send('An error occurred during documentation generation');
  }
});

io.on('connection', (socket) => {
  logger.info('New client connected');
  socket.on('disconnect', () => {
    logger.info('Client disconnected');
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => logger.info(`Server running on port ${PORT}`));