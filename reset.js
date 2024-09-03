const mongoose = require('mongoose');
const User = require('./models/User'); // Adjust the path to your User model

// Connect to your MongoDB database
mongoose.connect('mongodb://localhost:27017/buildmynotes', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(async () => {
    console.log('Connected to MongoDB');

    try {
      // Find how many users exist before the update (for debugging)
      const usersBefore = await User.countDocuments();
      console.log(`Found ${usersBefore} users in the database.`);

      // Update all users to reset premium status
      const result = await User.updateMany(
        {},  // Empty query matches all documents
        {
          $set: {
            isPremium: false     // Clear premium end date
          }
        }
      );

      console.log('Update Result:', result); // Log the full result object for debugging

      // Check the modifiedCount or matchedCount based on your MongoDB version
      if (result.modifiedCount !== undefined) {
        console.log(`${result.modifiedCount} users updated to reset premium status.`);
      } else if (result.nModified !== undefined) {
        console.log(`${result.nModified} users updated to reset premium status.`);
      } else {
        console.log('No users were updated.');
      }
    } catch (err) {
      console.error('Error resetting premium status:', err);
    } finally {
      mongoose.connection.close();  // Close the connection when done
    }
  })
  .catch(err => console.error('Error connecting to MongoDB:', err));
