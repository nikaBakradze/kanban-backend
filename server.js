const express = require('express');
const cors = require('cors');
require('dotenv').config();

const pool = require('./config/db');
const authRoutes = require('./routes/auth');

const app = express();

const normalizeOrigin = (origin) => {
  try {
    const url = new URL(origin);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return null;
  }
};

const allowedOrigins = [
  ...(process.env.CORS_ORIGINS || '').split(','),
  process.env.FRONTEND_URL,
  'http://localhost:3000',
  'http://localhost:5173',
  'https://kanban-seven-silk.vercel.app',
  'https://kanban-r9th2m301-nikabakradze.vercel.app'
].map((origin) => origin && normalizeOrigin(origin.trim())).filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(normalizeOrigin(origin))) return callback(null, true);
    // Let Express handle the request without CORS headers instead of turning
    // a browser policy violation into an application-level 500 response.
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Routes Registration
app.use('/api/auth', authRoutes);
app.use('/api/boards', require('./routes/board'));
app.use('/api/tasks', require('./routes/task'));

app.get('/api/health', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT 1 + 1 AS result');
    res.json({ message: 'Database connected successfully!', result: rows[0].result });
  } catch (error) {
    console.error('Database connection error:', error);
    res.status(500).json({ message: 'Database connection failed' });
  }
});

app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err.stack);
  res.status(500).json({ message: 'მოულოდნელი სერვერის შეცდომა' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
