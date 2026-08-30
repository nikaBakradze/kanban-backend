const express = require('express');
const router = express.Router();
const boardController = require('../controller/boardController');
const verifyToken = require('../middleware/verifyToken');

router.get('/', verifyToken, boardController.getBoards);
router.get('/:id', verifyToken, boardController.getBoardById);
router.post('/', verifyToken, boardController.createBoard);
router.post('/column', verifyToken, boardController.addColumn);
router.put('/:id', verifyToken, boardController.updateBoard);
router.delete('/:id', verifyToken, boardController.deleteBoard);

module.exports = router;