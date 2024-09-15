const Queue = require('bull');
const { processVideo } = require('../controllers/videoProcessor');

const videoQueue = new Queue('video processing', 'redis://127.0.0.1:6379');
videoQueue.process(async (job) => {
  const { sbatId, userEmail } = job.data;
  console.log(`Processing job ${job.id} for sbatId: ${sbatId}, userEmail: ${userEmail}`);
  try {
    const result = await processVideo(sbatId, userEmail);
    console.log(`Job ${job.id} completed successfully`);
    
    const video = await Video.findOne({ sbatId });
    if (video) {
      video.notes = result.notes;
      video.transcription = result.transcription;
      video.status = 'completed';
      await video.save();
    }

    return result;
  } catch (error) {
    console.error(`Job ${job.id} failed:`, error);
    const video = await Video.findOne({ sbatId });
    if (video) {
      video.status = 'error';
      await video.save();
    }
    throw error;
  }
});

module.exports = videoQueue;
