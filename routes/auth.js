const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { 
  register, 
  login, 
  googleLogin, 
  forgotPassword, 
  resetPassword 
} = require('../controller/authController');

// Rate limiter-ები სენსიტიური ენდფოინთებისთვის
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 წუთი
  max: 20, // მაქსიმუმ 20 მოთხოვნა IP-დან
  message: { message: 'Too many requests from this IP, please try again after 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

const passwordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 საათი
  max: 5, // მაქსიმუმ 5 მცდელობა პაროლის აღდგენაზე
  message: { message: 'Too many password reset attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/register', authLimiter, register);
router.post('/login', authLimiter, login);
router.post('/google', authLimiter, googleLogin);
router.post('/forgot-password', passwordLimiter, forgotPassword);
router.post('/reset-password', passwordLimiter, resetPassword);

module.exports = router;
