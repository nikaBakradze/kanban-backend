const express = require('express');
const router = express.Router();
const taskController = require('../controller/taskController');
const verifyToken = require('../middleware/verifyToken');

router.post('/', verifyToken, taskController.createTask);
router.put('/:id', verifyToken, taskController.updateTask);
router.patch('/subtask/:id', verifyToken, taskController.toggleSubtask);
router.delete('/:id', verifyToken, taskController.deleteTask);

module.exports = router;