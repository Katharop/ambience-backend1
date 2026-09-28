require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');

const MONGO_URI = process.env.MONGO_URI;
const emailToPromote = process.argv[2];

if (!emailToPromote) {
  console.error('❌ Please provide the email address of the account you want to promote.');
  console.error('Usage: node make-admin.js <your-email@example.com>');
  process.exit(1);
}

const promoteUser = async () => {
  try {
    if (!MONGO_URI) {
      throw new Error('MONGO_URI is not defined in .env file');
    }

    console.log('⏳ Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI, {
      maxPoolSize: 10,
      minPoolSize: 2,
    });
    console.log('✅ Connected to MongoDB.');

    console.log(`🔍 Looking for user with email: ${emailToPromote}`);
    const user = await User.findOne({ email: emailToPromote.toLowerCase() });

    if (!user) {
      console.error(`❌ User not found with email: ${emailToPromote}`);
      process.exit(1);
    }

    if (user.role === 'admin') {
      console.log(`ℹ️  User ${user.email} is already an admin.`);
    } else {
      console.log(`📈 Promoting ${user.email} from '${user.role}' to 'admin'...`);
      user.role = 'admin';
      await user.save();
      console.log(`✅ Success! ${user.email} is now an admin.`);
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    console.log('Disconnecting from database...');
    await mongoose.connection.close();
    process.exit(0);
  }
};

promoteUser();
