const express = require("express");
const http = require("http");
const cors = require("cors");
const router = express.Router();
const session = require("express-session");
const passport = require("passport");
const socketIo = require("socket.io");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const { processVideo } = require("./controllers/videoProcessor");
const authRoutes = require("./routes/authRoutes");
const Video = require("./models/Video");
const User = require("./models/User");
const MongoStore = require("connect-mongo");
require("dotenv").config();
require("./config/passportGoogle");
const userRoutes = require("./routes/userRoutes");
const connectDB = require("./config/database");
const Feedback = require('./models/review');
const jwt = require("jsonwebtoken");
const MAX_TRIALS = 100; // or whatever number you want for the maximum free trials
const Redis = require('redis');
const redis = Redis.createClient(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

redis.on('error', (err) => console.log('Redis Client Error', err));
redis.connect();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: ["http://localhost:5173","https://buildmynotes.com","https://www.buildmynotes.com","http://www.buildmynotes.com"],
    methods: ["GET", "POST", "PUT"],
    credentials: true,
  },
});

// Connect to MongoDB
connectDB();

// Updated CORS configuration
app.use(cors({
  origin: ["https://www.buildmynotes.com", "https://buildmynotes.com", "http://localhost:5173"],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-auth-token"],
  credentials: true,
}));

// Preflight request handler
app.options('*', cors());

app.use(express.json());

app.use(
  session({
    secret: process.env.SESSION_SECRET || "your_secret",
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: process.env.MONGODB_URI,
      ttl: 14 * 24 * 60 * 60,
    }),
    cookie: {
      secure: process.env.NODE_ENV === "production",
      maxAge: 3 * 24 * 60 * 60 * 1000, // 3 days in milliseconds
      httpOnly: true,
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());

// Socket.io setup
io.on("connection", (socket) => {
  console.log("New client connected");

  socket.on("disconnect", () => {
    console.log("Client disconnected");
  });
});

// Auth routes
app.use("/auth", authRoutes);

// Razorpay instance
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_SECRET_KEY,
});

// Payment creation route
app.post("/create-order", async (req, res) => {
  const { userEmail } = req.body;
  const amount = 99 * 100; // INR 99 in paise

  try {
    const user = await User.findOne({ email: userEmail });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (user.isPremium) {
      return res.status(400).json({ error: "User already has premium access" });
    }

    const orderOptions = {
      amount,
      currency: "INR",
      receipt: crypto.randomBytes(10).toString("hex"),
      payment_capture: 1,
    };
    const order = await razorpay.orders.create(orderOptions);

    console.log("Razorpay Order:", order);

    res.status(200).json({
      success: true,
      orderId: order.id,
      amount: amount / 100,
    });
  } catch (error) {
    console.error("Error creating order:", error);
    res.status(500).json({ error: "Error creating Razorpay order" });
  }
});

// Payment verification route
app.post("/verify-payment", async (req, res) => {
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    userEmail,
  } = req.body;

  try {
    const generatedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_SECRET_KEY)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (generatedSignature === razorpay_signature) {
      const user = await User.findOne({ email: userEmail });
      if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
      }

      const now = new Date();
      user.isPremium = true;
      user.premiumStartDate = now;
      user.premiumEndDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      await user.save();

      res.status(200).json({
        success: true,
        message: "Payment verified successfully",
        user: {
          isPremium: user.isPremium,
          premiumStartDate: user.premiumStartDate.toISOString(),
          premiumEndDate: user.premiumEndDate.toISOString(),
        },
      });
    } else {
      res.status(400).json({ success: false, message: "Invalid signature" });
    }
  } catch (error) {
    console.error("Error during payment verification:", error);
    res.status(500).json({ error: "Error during payment verification" });
  }
});

// Check user premium status route
app.get("/user-status/:userEmail", async (req, res) => {
  try {
    const user = await User.findOne({ email: req.params.userEmail });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const now = new Date();
    const isPremiumActive = user.isPremium && user.premiumEndDate > now;

    res.status(200).json({
      isPremium: isPremiumActive,
      premiumStartDate: user.premiumStartDate,
      premiumEndDate: user.premiumEndDate,
      notesGenerated: user.notesGenerated || 0,
      freeTrials: user.freeTrials || 0,
    });
  } catch (error) {
    console.error("Error fetching user status:", error);
    res.status(500).json({ error: "Error fetching user status" });
  }
});

// Process video route with increased timeout
app.post("/process-video", async (req, res) => {
  //Increase the timeout to 10 minutes (600000 ms)
  req.setTimeout(600000);

  const { sbatId, userEmail } = req.body;
  console.log(`Received request to process video with sbatId: ${sbatId} and userEmail: ${userEmail}`);

  if (!sbatId || !userEmail) {
    return res.status(400).json({ error: "Missing sbatId or userEmail" });
  }

  try {
    const user = await User.findOne({ email: userEmail });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (!user.isPremium && user.notesGenerated >= MAX_TRIALS + user.freeTrials) {
      return res.status(403).json({ error: "Free trial limit reached" });
    }

    let video = await Video.findOne({ sbatId });

    if (video) {
      console.log("Video already exists, returning existing notes");
      if (!video.userEmails.includes(userEmail)) {
        video.userEmails.push(userEmail);
        await video.save();
      }

      if (!user.videos.includes(video._id)) {
        user.videos.push(video._id);
        user.notesGenerated += 1;
        await user.save();
      }

      return res.json({
        message: "Video already processed, returning existing notes",
        notes: video.notes,
        transcriptLink: video.transcription,
        notesGenerated: user.notesGenerated,
      });
    } else {
      console.log("Video not found, starting processing");
      const result = await processVideo(sbatId, userEmail);

      // Update user's notesGenerated and freeTrials
      user.notesGenerated += 1;
      if (!user.isPremium && user.notesGenerated > MAX_TRIALS) {
        user.freeTrials = Math.max(0, user.freeTrials - 1);
      }
      await user.save();

      return res.json({
        message: "Video processed successfully",
        notes: result.notes,
        transcriptLink: result.transcription,
        notesGenerated: user.notesGenerated,
        freeTrials: user.freeTrials,
      });
    }
  } catch (error) {
    console.error("Error processing video:", error);
    if (error && error.message && error.message.includes('FFmpeg is not installed')) {
      res.status(500).json({ error: "FFmpeg is not installed on the server. Please contact support." });
    } else {
      res.status(500).json({ error: "An error occurred while processing the video" });
    }
  }
});

// Session route
app.get("/auth/check-session", (req, res) => {
  if (req.isAuthenticated()) {
    res.json({ loggedIn: true });
  } else {
    res.json({ loggedIn: false });
  }
});

// Routes
app.use("/api/users", userRoutes);

// Referral route
app.get("/api/referral/:referralCode", async (req, res) => {
  const { referralCode } = req.params;
  // Logic to handle referral code
  // Store the referral code in session or send it to the frontend
  res.redirect("/signup?referral=" + referralCode);
});

// Fetch single note route
app.get("/notes/:noteId", async (req, res) => {
  try {
    const note = await Video.findById(req.params.noteId);
    if (!note) {
      return res.status(404).json({ error: "Note not found" });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    user.notesGenerated += 1;
    await user.save();

    if (!user.videos.includes(note._id)) {
      user.videos.push(note._id);
      await user.save();
    }

    if (!note.userEmails.includes(user.email)) {
      note.userEmails.push(user.email);
      await note.save();
    }

    res.json({
      notes: note.notes,
      notesGenerated: user.notesGenerated,
    });
  } catch (error) {
    console.error("Error fetching note:", error);
    res.status(500).json({ error: "Error fetching note" });
  }
});

// Fetch notes list route
app.get("/notes/:email", async (req, res) => {
  try {
    console.log(`Fetching notes for email: ${req.params.email}`);
    const user = await User.findOne({ email: req.params.email }).populate("videos");
    if (!user) {
      console.log(`User not found for email: ${req.params.email}`);
      return res.status(404).json({ error: "User not found" });
    }
    console.log(`User found with email: ${user.email}`);
    console.log(`Number of videos: ${user.videos.length}`);
    const notesList = user.videos.map((video) => ({
      _id: video._id,
      title: video.videoLink,
      notes: video.notes,
    }));
    console.log(`Notes list created with ${notesList.length} items`);
    res.json({ notesList });
  } catch (error) {
   console.error("Error fetching notes list:", error);
    res.status(500).json({ error: "Internal server error", details: error.message, stack: error.stack });
  }
});

// Middleware to check JWT token
const auth = (req, res, next) => {
  const token = req.header("x-auth-token");

  if (!token) {
    return res.status(401).json({ message: "No token, authorization denied" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log("Decoded token:", decoded);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ message: "Token is not valid" });
  }
};

// Update user route
app.put("/auth/update-user", async (req, res) => {
  try {
    const userId = req.body.userId; // Get userId from the request body instead of auth middleware
    const updateData = req.body;

    delete updateData.password;
    delete updateData._id;
    delete updateData.email;

    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { $set: updateData },
      { new: true, runValidators: true }
    ).select("-password");

    if (!updatedUser) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ user: updatedUser });
  } catch (error) {
    console.error("Error updating user:", error);
    res.status(500).json({ error: "Error updating user" });
  }
});

// Fetch notes by sbatId route
app.get("/api/notes/:sbatId", async (req, res) => {
  try {
    const { sbatId } = req.params;
    const { userEmail } = req.query;

    if (!sbatId || !userEmail) {
      return res.status(400).json({ error: "Missing sbatId or userEmail" });
    }

    const user = await User.findOne({ email: userEmail });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const video = await Video.findOne({ sbatId });
    if (!video) {
      return res.status(404).json({ error: "Notes not found for this video" });
    }

    if (!video.userEmails.includes(userEmail)) {
      video.userEmails.push(userEmail);
      await video.save();
    }

    if (!user.videos.includes(video._id)) {
      user.videos.push(video._id);
      user.notesGenerated += 1;
      await user.save();
    }

    res.json({
      notes: video.notes,
      transcriptLink: video.transcription,
      notesGenerated: user.notesGenerated,
    });
  } catch (error) {
    console.error("Error fetching notes:", error);
    res.status(500).json({ error: "An error occurred while fetching the notes" });
  }
});

// Feedback submission route
app.post("/api/feedback", auth, async (req, res) => {
  const { rating, message, video, userEmail } = req.body;

  if (!rating || !video || !userEmail) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const user = await User.findOne({ email: userEmail });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const feedback = new Feedback({
      rating,
      message,
      video,
      user: user.email
    });

    await feedback.save();
    res.status(201).json({ message: "Feedback submitted successfully" });
  } catch (error) {
    console.error("Error submitting feedback:", error);
    res.status(500).json({ error: "An error occurred while submitting feedback" });
  }
});

// Referral signup route
app.post("/auth/signup-with-referral", async (req, res) => {
  const { email, password, referralCode } = req.body;
  console.log(`[${new Date().toISOString()}] Signup attempt with referral. Email: ${email}, ReferralCode: ${referralCode}`);

  try {
    // Create new user
    const newUser = await User.create({ email, password });
    console.log(`[${new Date().toISOString()}] Created new user ${newUser.email} with freeTrials: ${newUser.freeTrials}`);

    // Find referrer and grant free trial
    if (referralCode) {
      try {
       console.log(`[${new Date().toISOString()}] Attempting to update referrer with ID: ${referralCode}`);
        const referrer = await User.findById(referralCode);
        console.log(`[${new Date().toISOString()}] Referrer before update:`, referrer);

        const updatedReferrer = await User.findByIdAndUpdate(
          referralCode,
          { $inc: { freeTrials: 1 } },
          { new: true }
        );

        if (updatedReferrer) {
          console.log(`[${new Date().toISOString()}] Updated referrer ${updatedReferrer.email} freeTrials to ${updatedReferrer.freeTrials}`);
        } else {
          console.log(`[${new Date().toISOString()}] Referrer with ID ${referralCode} not found`);
        }
      } catch (referrerError) {
         console.error(`[${new Date().toISOString()}] Error updating referrer:`, referrerError);
      }
    }

    // Log in the new user
    req.login(newUser, (err) => {
      if (err) {
        return res.status(500).json({ error: "Error logging in new user" });
      }
      return res.status(200).json({ message: "Signup successful", user: newUser });
    });
  } catch (error) {
    console.error("Error during signup:", error);
    res.status(500).json({ error: "Error during signup" });
  }
});

app.get("/api/users/referral-link", async (req, res) => {
  try {
    const { email } = req.query;
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    
    // Generate or retrieve the referral link
    const referralLink = `https://buildmynotes.com/signup?ref=${user._id}`;
    
    res.json({ referralLink });
  } catch (error) {
    console.error("Error generating referral link:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/user/free-trials/:userId", async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json({ freeTrials: user.freeTrials });
  } catch (error) {
    console.error("Error fetching user free trials:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

const PORT = process.env.PORT || 5009;
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});