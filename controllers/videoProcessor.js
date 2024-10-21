const axios = require("axios");
const fs = require("fs").promises;
const path = require("path");
const { exec, execSync } = require("child_process");
const m3u8Parser = require("m3u8-parser");
const { createClient } = require("@deepgram/sdk");
const OpenAI = require("openai");
const dotenv = require("dotenv");
const connectDB = require("../config/database");
const Video = require("../models/Video");
const User = require("../models/User");
const { v4: uuidv4 } = require('uuid');
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

connectDB();
dotenv.config();

// Initialize Deepgram API Client
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MAX_RETRIES = 3;

async function processVideo(sbatId, userEmail) {
  console.log(`[${new Date().toISOString()}] Processing video for sbatId: ${sbatId}, userEmail: ${userEmail}`);

  const jobId = `${sbatId}_${uuidv4()}`;
  const lockKey = `lock:${sbatId}`;

  try {
    // Try to acquire a lock
    const acquired = await redis.set(lockKey, jobId, 'NX', 'EX', 600); // 10 minutes lock

    if (!acquired) {
      console.log(`[${new Date().toISOString()}] Another job is processing this video. Waiting for results.`);
      return await waitForExistingJob(sbatId, userEmail);
    }

    console.log(`[${new Date().toISOString()}] Lock acquired for jobId: ${jobId}`);

    console.log(`[${new Date().toISOString()}] Starting video processing for sbatId: ${sbatId}, userEmail: ${userEmail}`);

    console.log(`[${new Date().toISOString()}] Fetching m3u8 URLs`);
    const apiResponse = await axios.get(
      `https://metabase.interviewbit.com/api/embed/card/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyZXNvdXJjZSI6eyJxdWVzdGlvbiI6MjA2MDN9LCJwYXJhbXMiOnt9LCJleHAiOjE3NDE3MDk1NTN9.Z6ob2UjkUXJyfNe8wFc2i2qnfevKkIa4Y63Awmrde3g/query`,
      {
        params: { sbat_id: sbatId },
      }
    );

    const m3u8Urls = apiResponse.data.data.rows.map((row) => row[0]);
    console.log(`[${new Date().toISOString()}] Fetched ${m3u8Urls.length} m3u8 URLs`);

    if (m3u8Urls.length === 0) {
      throw new Error('No m3u8 URLs found for the given sbatId');
    }

    const outputDir = path.join(__dirname, "../output");
    await fs.mkdir(outputDir, { recursive: true });
    console.log(`[${new Date().toISOString()}] Created output directory: ${outputDir}`);

    const jobOutputDir = path.join(outputDir, jobId);
    await fs.mkdir(jobOutputDir, { recursive: true });
    console.log(`[${new Date().toISOString()}] Created job output directory: ${jobOutputDir}`);

    const pLimit = (await import('p-limit')).default;
    const limit = pLimit(50); // Adjust the concurrency limit as needed

    let allTsFilePaths = [];

    for (let i = 0; i < m3u8Urls.length; i++) {
      const m3u8Url = m3u8Urls[i];
     console.log(`[${new Date().toISOString()}] Processing m3u8 ${i + 1}/${m3u8Urls.length}: ${m3u8Url}`);

      try {
        const m3u8Response = await axios.get(m3u8Url);
        const parser = new m3u8Parser.Parser();
        parser.push(m3u8Response.data);
        parser.end();

        const segments = parser.manifest.segments;
        console.log(`[${new Date().toISOString()}] Found ${segments.length} segments in m3u8 ${i + 1}`);

        if (segments.length === 0) {
          console.warn(`[${new Date().toISOString()}] No segments found in m3u8 ${i + 1}. Skipping.`);
          continue;
        }

        const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf("/") + 1);

        // Parallel download of segments with concurrency limit
        const downloadPromises = segments.map((segment, j) =>
          limit(async () => {
            const segmentUrl = new URL(segment.uri, baseUrl).toString();
            console.log(`[${new Date().toISOString()}] Downloading segment ${j + 1}/${segments.length} from m3u8 ${i + 1}`);
            const segmentResponse = await axios.get(segmentUrl, { responseType: "arraybuffer" });
            const tsFilePath = path.join(jobOutputDir, `${sbatId}_segment_${i}_${j}.ts`);
            await fs.writeFile(tsFilePath, segmentResponse.data);
            return { index: j, path: tsFilePath };
          })
        );

        const downloadedSegments = await Promise.all(downloadPromises);

        // Sort segments to ensure correct order
        downloadedSegments.sort((a, b) => a.index - b.index);

        // Add sorted paths to allTsFilePaths
        allTsFilePaths.push(...downloadedSegments.map(segment => `file '${segment.path}'`));

        console.log(`[${new Date().toISOString()}] All segments for m3u8 ${i + 1} downloaded and sorted`);
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Error processing m3u8 ${i + 1}:`, error);
        // Continue with the next m3u8 URL
      }
    }

    if (allTsFilePaths.length === 0) {
      throw new Error('No valid segments were downloaded');
    }

    console.log(`[${new Date().toISOString()}] All segments downloaded. Preparing to merge.`);
    const fileListPath = path.join(jobOutputDir, "filelist.txt");
    await fs.writeFile(fileListPath, allTsFilePaths.join("\n"));
    console.log(`[${new Date().toISOString()}] Created file list at ${fileListPath}`);

    console.log(`File list contents:`);
    console.log(await fs.readFile(fileListPath, 'utf8'));

    const mergedFile = path.join(jobOutputDir, `${sbatId}.ts`);
    const mergeCommand = `ffmpeg -f concat -safe 0 -i "${fileListPath}" -c copy "${mergedFile}"`;
    console.log(`[${new Date().toISOString()}] Merging segments with command: ${mergeCommand}`);

    // Check if ffmpeg is installed
    try {
      execSync('ffmpeg -version', { stdio: 'ignore' });
    } catch (error) {
      throw new Error('FFmpeg is not installed or not found in PATH. Please install FFmpeg and try again.');
    }

    await new Promise((resolve, reject) => {
      exec(mergeCommand, { shell: '/bin/bash' }, (error, stdout, stderr) => {
        if (error) {
          console.error(`FFmpeg stderr: ${stderr}`);
          reject(`Error during merging segments: ${error.message}`);
        } else {
          resolve();
        }
      });
    });
    console.log(`[${new Date().toISOString()}] Segments merged into ${mergedFile}`);

    // Check if the merged TS file exists and has a non-zero size
    try {
      const stats = await fs.stat(mergedFile);
      if (stats.size === 0) {
        throw new Error(`Merged TS file is empty: ${mergedFile}`);
      }
      console.log(`[${new Date().toISOString()}] Merged TS file exists and has size: ${stats.size} bytes`);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error: ${error.message}`);
      throw error;
    }

    const mp3File = path.join(jobOutputDir, `${sbatId}.mp3`);
    const convertCommand = `ffmpeg -i "${mergedFile}" -q:a 0 -map a "${mp3File}"`;
    console.log(`[${new Date().toISOString()}] Converting to mp3 with command: ${convertCommand}`);

    await new Promise((resolve, reject) => {
      exec(convertCommand, { shell: '/bin/bash' }, (error, stdout, stderr) => {
        if (error) {
          console.error(`FFmpeg stderr: ${stderr}`);
          reject(`Error during conversion to mp3: ${error.message}`);
        } else {
          resolve();
        }
      });
    });
    console.log(`[${new Date().toISOString()}] Converted to mp3: ${mp3File}`);

    console.log(`[${new Date().toISOString()}] Generating transcript`);
    const transcript = await retryWithTimeout(() => generateTranscript(mp3File), MAX_RETRIES);
    console.log(`[${new Date().toISOString()}] Transcript generated`);

    console.log(`[${new Date().toISOString()}] Generating notes from transcript`);
    const notes = await generateNotesFromTranscript(transcript);
    console.log(`[${new Date().toISOString()}] Notes generated`);

    console.log(`[${new Date().toISOString()}] Cleaning up temporary files for sbatId: ${sbatId}`);
    await fs.rm(jobOutputDir, { recursive: true, force: true });
    console.log(`[${new Date().toISOString()}] Temporary files cleaned up for sbatId: ${sbatId}`);

    console.log(`[${new Date().toISOString()}] Saving video information to database`);

    const user = await User.findOne({ email: userEmail });
    if (!user) {
      throw new Error('User not found');
    }

    console.log(`[${new Date().toISOString()}] User found:`, {
      email: user.email,
      notesGenerated: user.notesGenerated,
      freeTrials: user.freeTrials
    });

    let video = await Video.findOne({ sbatId });
    if (video) {
      console.log(`[${new Date().toISOString()}] Existing video found for sbatId: ${sbatId}`);
      video.notes = notes;
      video.transcription = transcript;
      if (!video.userEmails.includes(userEmail)) {
        video.userEmails.push(userEmail);
      }
    } else {
      console.log(`[${new Date().toISOString()}] Creating new video for sbatId: ${sbatId}`);
      video = new Video({
        sbatId,
        videoLink: `https://scaler.com/class/${sbatId}`,
        notes,
        transcription: transcript,
        userEmails: [userEmail]
      });
    }

    await video.save();
    console.log(`[${new Date().toISOString()}] Video saved. ID: ${video._id}`);

    if (!user.videos.includes(video._id)) {
      user.videos.push(video._id);
      user.notesGenerated += 1;
      console.log(`[${new Date().toISOString()}] Updating user. New notesGenerated: ${user.notesGenerated}`);
      await user.save();
    }

    console.log(`[${new Date().toISOString()}] Video processing completed. User state:`, {
      email: user.email,
      notesGenerated: user.notesGenerated,
      freeTrials: user.freeTrials
    });

    console.log(`[${new Date().toISOString()}] Video processing completed successfully`);

    // After processing is complete
    const result = { notes, transcription: transcript, notesGenerated: user.notesGenerated };
    await redis.set(`result:${sbatId}`, JSON.stringify(result), 'EX', 3600); // Store result for 1 hour

    return result;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error in processVideo:`, error);
    throw error;
  } finally {
    // Release the lock
    await redis.del(lockKey);
    console.log(`[${new Date().toISOString()}] Lock released for jobId: ${jobId}`);
  }
}

async function retryWithTimeout(fn, retries) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
      console.error(`Attempt ${attempt} failed. Retrying...`);
      await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds before retry
    }
  }
}

async function generateTranscript(mp3FilePath) {
  try {
    const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
      await fs.readFile(mp3FilePath),
      { 
        model: "nova-2", 
        smart_format: true, 
        timeout: 300000 // 5 minutes timeout
      }
    );

    if (error) throw error;
    return result.results.channels[0].alternatives[0].transcript;
  } catch (error) {
    throw new Error(`Failed to generate transcript: ${error.message}`);
  }
}

async function generateNotesFromTranscript(transcript) { 
  const completion = await openai.chat.completions.create({
    messages: [
      { role: "system", content: "You are an expert educational assistant capable of understanding and summarizing lectures on various subjects." },
      { role: "user", content: `Generate comprehensive detailed and well-structured notes from the following lecture transcript. The notes should:

1. Be in markdown format, using appropriate headings, subheadings, lists, and other markdown elements.
2. Accurately reflect the content and structure of the lecture, maintaining the original sequence of topics.
3. Provide detailed explanations for all concepts discussed, ensuring clarity and depth.
4. Include any examples, case studies, or real-world applications mentioned in the lecture.
5. Cover all approaches, methodologies, or problem-solving techniques discussed.
6. For technical subjects (e.g., programming, data structures):
   - Include any code snippets or algorithms discussed, with explanations for each part.
   - Use the programming language used in the lecture (e.g., C++, Java, Python).
7. For non-technical subjects (e.g., finance, economics, marketing):
   - Focus on key theories, models, and practical applications.
   - Include any relevant formulas, diagrams, or frameworks mentioned.
8. Break down complex topics into easily understandable parts, providing clarifications where necessary.
9. Use markdown formatting to enhance readability:
   - Use ## for main headings and ### for subheadings
   - Use bullet points or numbered lists where appropriate
   - Use **bold** or *italic* for emphasis
   - Use \`code blocks\` for technical terms or short code snippets
   - Use larger code blocks for longer code examples
10. Avoid adding any information or examples not explicitly mentioned in the lecture.

Here is the lecture transcript: 
${transcript}` },
    ],
    model: "gpt-4o-mini",
  });
  return completion.choices[0].message.content;
}

async function waitForExistingJob(sbatId, userEmail) {
  const resultKey = `result:${sbatId}`;
  let attempts = 0;
  const maxAttempts = 60; // Wait for up to 5 minutes (60 * 5 seconds)

  while (attempts < maxAttempts) {
    const result = await redis.get(resultKey);
    if (result) {
      const parsedResult = JSON.parse(result);
      // Update user's data
      const user = await User.findOne({ email: userEmail });
      if (user) {
        user.notesGenerated += 1;
        await user.save();
      }
      return parsedResult;
    }
    await new Promise(resolve => setTimeout(resolve, 5000)); // Wait for 5 seconds
    attempts++;
  }

  throw new Error('Timed out waiting for video processing');
}

module.exports = { processVideo };
