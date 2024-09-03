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
  console.log(`[${new Date().toISOString()}] Starting video processing for sbatId: ${sbatId}, userEmail: ${userEmail}`);

  try {
    console.log(`[${new Date().toISOString()}] Fetching m3u8 URLs`);
    const apiResponse = await axios.get(
      `https://metabase.interviewbit.com/api/embed/card/eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJyZXNvdXJjZSI6eyJxdWVzdGlvbiI6MjA2MDN9LCJwYXJhbXMiOnt9LCJleHAiOjE3MjU4MDc1MTJ9.yMRVwznv6WFxGETyCI6P1GNGWItqllM06PRW4b0wVHc/query`,
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

        for (let j = 0; j < segments.length; j++) {
          const segmentUrl = new URL(segments[j].uri, baseUrl).toString();
          console.log(`[${new Date().toISOString()}] Downloading segment ${j + 1}/${segments.length} from m3u8 ${i + 1}`);
          const segmentResponse = await axios.get(segmentUrl, { responseType: "arraybuffer" });
          const tsFilePath = path.join(outputDir, `segment_${i}_${j}.ts`);
          await fs.writeFile(tsFilePath, segmentResponse.data);
          allTsFilePaths.push(`file '${tsFilePath}'`);
          console.log(`[${new Date().toISOString()}] Saved segment to ${tsFilePath}`);
        }
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Error processing m3u8 ${i + 1}:`, error);
        // Continue with the next m3u8 URL
      }
    }

    if (allTsFilePaths.length === 0) {
      throw new Error('No valid segments were downloaded');
    }

    console.log(`[${new Date().toISOString()}] All segments downloaded. Preparing to merge.`);
    const fileListPath = path.join(outputDir, "filelist.txt");
    await fs.writeFile(fileListPath, allTsFilePaths.join("\n"));
    console.log(`[${new Date().toISOString()}] Created file list at ${fileListPath}`);

    console.log(`File list contents:`);
    console.log(await fs.readFile(fileListPath, 'utf8'));

    const mergedFile = path.join(outputDir, `${sbatId}.ts`);
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

    const mp3File = path.join(outputDir, `${sbatId}.mp3`);
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

    console.log(`[${new Date().toISOString()}] Cleaning up temporary files`);
    await fs.unlink(fileListPath);
    await fs.unlink(mp3File);
    const tempFiles = await fs.readdir(outputDir);
    for (const file of tempFiles) {
      if (file.startsWith("segment_") || file === `${sbatId}.ts`) {
        await fs.unlink(path.join(outputDir, file));
      }
    }
    console.log(`[${new Date().toISOString()}] Temporary files cleaned up`);

    console.log(`[${new Date().toISOString()}] Saving video information to database`);

    const user = await User.findOne({ email: userEmail });
    if (!user) {
      throw new Error('User not found');
    }

    let video = await Video.findOne({ sbatId });
    if (video) {
      // Update existing video
      video.notes = notes;
      video.transcription = transcript;
      if (!video.userEmails.includes(userEmail)) {
        video.userEmails.push(userEmail);
      }
    } else {
      // Create new video
      video = new Video({
        sbatId,
        videoLink: `https://scaler.com/class/${sbatId}`,
        notes,
        transcription: transcript,
        userEmails: [userEmail]
      });

      await video.save();
    }

    if (!user.videos.includes(video._id)) {
      user.videos.push(video._id);
      user.notesGenerated += 1;
      await user.save();
    }

    console.log(`[${new Date().toISOString()}] Video information saved to database`);

    console.log(`[${new Date().toISOString()}] Video processing completed successfully`);
    return { notes, transcription: transcript };
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error in processVideo:`, error);
    throw error;
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
      { model: "nova-2", smart_format: true, timeout: 300000 } // Set a longer timeout
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
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: `Generate notes for the following lecture transcript in markdown format:\n\n${transcript}` },
    ],
    model: "gpt-4o-mini",
  });
  return completion.choices[0].message.content;
}

module.exports = { processVideo };
