const express = require('express');
const cors = require('cors');
require('dotenv').config();

const pool = require('./config/db');
const authRoutes = require('./routes/auth');

const app = express();

// Middlewares & CORS კონფიგურაცია
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'https://kanban-seven-silk.vercel.app',
  'https://kanban-backend-b2e3.onrender.com'
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// აუცილებლად დაამატე ეს ხაზი OPTIONS მოთხოვნების უპრობლემოდ გასატარებლად:
app.options(/.*/, cors());

app.use(express.json());

// Routes Registration
app.use('/api/auth', authRoutes);
app.use('/api/boards', require('./routes/board'));
app.use('/api/tasks', require('./routes/task'));

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT 1 + 1 AS result');
    res.json({ message: 'Database connected successfully!', result: rows[0].result });
  } catch (error) {
    console.error('Database connection error:', error);
    res.status(500).json({ message: 'Database connection failed' });
  }
});

// გლობალური ერორების ჰენდლერი
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err.stack);
  res.status(500).json({ message: 'მოულოდნელი სერვერის შეცდომა' });
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
