const express = require('express');
const rateLimit = require('express-rate-limit');
const verifyToken = require('../middleware/verifyToken');
const adminAuth = require('../middleware/adminAuth');
const controller = require('../controller/adminController');

const router = express.Router();
const adminVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many 2FA attempts. Try again later.' },
});

router.post('/auth/start', verifyToken, adminVerifyLimiter, controller.start);
router.post('/auth/setup', verifyToken, adminVerifyLimiter, controller.setup);
router.post('/auth/setup/complete', verifyToken, adminVerifyLimiter, controller.completeSetup);
router.post('/auth/verify', adminVerifyLimiter, controller.verify);

router.use(adminAuth);
router.post('/auth/logout', controller.logout);
router.get('/overview', controller.overview);
router.get('/analytics', controller.analytics);
router.get('/users', controller.users);
router.patch('/users/:id/status', controller.updateUserStatus);
router.delete('/users/:id', controller.deleteUser);
router.get('/workspaces', controller.workspaces);
router.get('/boards', controller.boards);
router.get('/activity', controller.activity);
router.get('/health', controller.health);
router.get('/security', controller.security);

module.exports = router;
