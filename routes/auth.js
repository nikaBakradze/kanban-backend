const express = require('express');
const router = express.Router();
const { 
  register, 
  login, 
  googleLogin, 
  forgotPassword, 
  resetPassword 
} = require('../controller/authController');

router.post('/register', register);
router.post('/login', login);
router.post('/google', googleLogin);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);

module.exports = router;