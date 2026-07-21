const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let players = [];
let gameState = {};
let currentRound = 15;

function startNewRound() {
    if (players.length < 2) return;

    let allTiles = [];
    for (let i = 0; i <= 15; i++) for (let j = i; j <= 15; j++) allTiles.push({ left: i, right: j });

    let startTile = { left: currentRound, right: currentRound };
    allTiles = allTiles.filter(t => !(t.left === startTile.left && t.right === startTile.right));

    for (let i = allTiles.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [allTiles[i], allTiles[j]] = [allTiles[j], allTiles[i]];
    }

    let tilesPerPlayer = players.length > 6 ? 12 : 15;

    players.forEach((p) => {
        p.hand = allTiles.splice(0, tilesPerPlayer);
        p.trainEnd = currentRound;
        p.trainOpen = false;
        p.trainTiles = [];
        p.hasDrawn = false;
    });

    gameState = {
        boneyard: allTiles,
        mexicanTrainEnd: currentRound,
        mexicanTrainTiles: [],
        currentTurnIndex: 0,
        pendingDouble: null,
        consecutivePasses: 0,
        round: currentRound
    };

    io.emit('gameStarted', {
        players: players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar, totalScore: p.totalScore, handCount: p.hand.length, trainOpen: p.trainOpen, trainEnd: p.trainEnd, trainTiles: p.trainTiles })),
        currentTurnId: players[0].id,
        mtEnd: currentRound,
        mtTiles: [],
        pendingDouble: null,
        round: currentRound,
        boneyardCount: gameState.boneyard.length
    });

    players.forEach(p => {
        io.to(p.id).emit('yourHand', p.hand);
        io.to(p.id).emit('yourTrain', { end: p.trainEnd, tiles: p.trainTiles, open: p.trainOpen });
    });
}

function handleRoundEnd(winnerName) {
    let roundData = [];
    players.forEach(p => {
        let score = 0;
        p.hand.forEach(t => {
            let val1 = t.left === 0 ? 50 : t.left;
            let val2 = t.right === 0 ? 50 : t.right;
            score += (val1 + val2);
        });
        p.totalScore += score;
        roundData.push({ id: p.id, name: p.name, roundScore: score, totalScore: p.totalScore });
    });

    currentRound--;

    if (currentRound < 0) {
        let tournamentWinner = players.reduce((min, p) => p.totalScore < min.totalScore ? p : min, players[0]);
        io.emit('gameOver', { winner: tournamentWinner.name, scores: roundData, tournamentOver: true });
    } else {
        io.emit('roundOver', { winner: winnerName, scores: roundData, nextRound: currentRound });
        setTimeout(startNewRound, 6000);
    }
}

io.on('connection', (socket) => {
    console.log('Jogador conectou:', socket.id);

    socket.on('joinLobby', (playerInfo) => {
        const isHost = players.length === 0;
        const player = {
            id: socket.id,
            name: playerInfo.name,
            avatar: playerInfo.avatar,
            totalScore: playerInfo.totalScore,
            isHost: isHost,
            hand: [],
            trainEnd: 15,
            trainOpen: false,
            trainTiles: [],
            hasDrawn: false
        };
        players.push(player);
        io.emit('lobbyUpdate', players);
    });

    socket.on('startGame', () => {
        const player = players.find(p => p.id === socket.id);
        if (!player || !player.isHost || players.length < 2) return;
        currentRound = 15;
        startNewRound();
    });

    socket.on('playTile', (data) => {
        const playerIndex = players.findIndex(p => p.id === socket.id);
        if (gameState.currentTurnIndex !== playerIndex) return;
        if (!data || !data.tile) return;

        const player = players[playerIndex];
        const tile = { left: data.tile.left, right: data.tile.right };
        const targetId = data.target;

        let trainEnd, targetPlayerIndex = -1;

        if (targetId === 'mt') { trainEnd = gameState.mexicanTrainEnd; } 
        else if (targetId === 'own') { trainEnd = player.trainEnd; targetPlayerIndex = playerIndex; } 
        else if (targetId.startsWith('player-')) {
            let targetIdStr = targetId.substring(7);
            targetPlayerIndex = players.findIndex(p => p.id === targetIdStr);
            if (targetPlayerIndex !== -1) trainEnd = players[targetPlayerIndex].trainEnd;
        }

        if (trainEnd === undefined) return;

        if (tile.left === trainEnd || tile.right === trainEnd) {
            const origL = tile.left, origR = tile.right;
            if (tile.right === trainEnd) [tile.left, tile.right] = [tile.right, tile.left];

            player.hand = player.hand.filter(t => !((t.left === origL && t.right === origR) || (t.left === origR && t.right === origL)));

            let absoluteTargetId = targetId;
            if (targetId === 'own') absoluteTargetId = `player-${player.id}`;

            if (targetId === 'mt') {
                gameState.mexicanTrainEnd = tile.right;
                gameState.mexicanTrainTiles.push(tile);
            } else if (targetPlayerIndex !== -1) {
                players[targetPlayerIndex].trainEnd = tile.right;
                players[targetPlayerIndex].trainTiles.push(tile);
                if (targetPlayerIndex === playerIndex) {
                    if (players[playerIndex].trainOpen) players[playerIndex].trainOpen = false;
                    io.to(socket.id).emit('yourTrain', { end: player.trainEnd, tiles: player.trainTiles, open: player.trainOpen });
                }
            }

            let playedDouble = (tile.left === tile.right);
            let satisfiedDouble = false;

            if (playedDouble) {
                gameState.pendingDouble = { targetId: absoluteTargetId, value: tile.left };
            } else if (gameState.pendingDouble && absoluteTargetId === gameState.pendingDouble.targetId) {
                gameState.pendingDouble = null;
                satisfiedDouble = true;
            }

            gameState.consecutivePasses = 0;
            io.to(socket.id).emit('yourHand', player.hand);

            if (player.hand.length === 0) {
                // Atualiza o tabuleiro uma última vez antes de acabar
                io.emit('boardUpdate', {
                    mtEnd: gameState.mexicanTrainEnd,
                    mtTiles: gameState.mexicanTrainTiles,
                    players: players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar, totalScore: p.totalScore, trainEnd: p.trainEnd, trainTiles: p.trainTiles, trainOpen: p.trainOpen, handCount: p.hand.length })),
                    pendingDouble: gameState.pendingDouble,
                    currentTurnId: players[gameState.currentTurnIndex].id,
                    boneyardCount: gameState.boneyard.length
                });
                handleRoundEnd(player.name);
                return;
            }

            // CORREÇÃO: Atualiza o índice da vez ANTES de enviar o boardUpdate
            if (playedDouble && !satisfiedDouble) {
                players[playerIndex].hasDrawn = false;
                // A vez não muda
            } else {
                gameState.currentTurnIndex = (playerIndex + 1) % players.length;
                players[gameState.currentTurnIndex].hasDrawn = false;
            }

            io.emit('boardUpdate', {
                mtEnd: gameState.mexicanTrainEnd,
                mtTiles: gameState.mexicanTrainTiles,
                players: players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar, totalScore: p.totalScore, trainEnd: p.trainEnd, trainTiles: p.trainTiles, trainOpen: p.trainOpen, handCount: p.hand.length })),
                pendingDouble: gameState.pendingDouble,
                currentTurnId: players[gameState.currentTurnIndex].id,
                boneyardCount: gameState.boneyard.length
            });

            io.emit('turnUpdate', players[gameState.currentTurnIndex].id);
        } else {
            io.to(socket.id).emit('invalidMove', 'Jogada inválida. Sincronizando o tabuleiro...');
            io.to(socket.id).emit('yourHand', player.hand);
            io.to(socket.id).emit('boardUpdate', {
                mtEnd: gameState.mexicanTrainEnd,
                mtTiles: gameState.mexicanTrainTiles,
                players: players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar, totalScore: p.totalScore, trainEnd: p.trainEnd, trainTiles: p.trainTiles, trainOpen: p.trainOpen, handCount: p.hand.length })),
                pendingDouble: gameState.pendingDouble,
                currentTurnId: players[gameState.currentTurnIndex].id,
                boneyardCount: gameState.boneyard.length
            });
        }
    });

    socket.on('drawTile', () => {
        const playerIndex = players.findIndex(p => p.id === socket.id);
        if (gameState.currentTurnIndex !== playerIndex || players[playerIndex].hasDrawn) return;

        if (gameState.boneyard.length > 0) {
            const drawnTile = gameState.boneyard.pop();
            players[playerIndex].hand.push(drawnTile);
            players[playerIndex].hasDrawn = true;

            let targets = [{ id: 'mt', end: gameState.mexicanTrainEnd }, { id: 'own', end: players[playerIndex].trainEnd }];
            players.forEach(p => {
                if (p.id !== players[playerIndex].id && p.trainOpen) targets.push({ id: `player-${p.id}`, end: p.trainEnd });
            });
            if (gameState.pendingDouble) targets = [{ id: gameState.pendingDouble.targetId, end: gameState.pendingDouble.value }];
            
            let playable = targets.some(t => drawnTile.left === t.end || drawnTile.right === t.end);

            io.to(socket.id).emit('yourHand', players[playerIndex].hand);
            io.to(socket.id).emit('drawResult', playable);
            io.emit('boneyardUpdate', gameState.boneyard.length);
        } else {
            // CORREÇÃO: Cemitério vazio! Obriga a passar a vez.
            players[playerIndex].hasDrawn = true;
            io.to(socket.id).emit('drawResult', false);
        }
    });

    socket.on('passTurn', () => {
        const playerIndex = players.findIndex(p => p.id === socket.id);
        if (gameState.currentTurnIndex !== playerIndex) return;

        players[playerIndex].trainOpen = true;
        gameState.consecutivePasses++;

        io.to(socket.id).emit('yourTrain', { end: players[playerIndex].trainEnd, tiles: players[playerIndex].trainTiles, open: true });
        
        if (gameState.consecutivePasses >= players.length && gameState.boneyard.length === 0) {
            io.emit('boardUpdate', {
                mtEnd: gameState.mexicanTrainEnd,
                mtTiles: gameState.mexicanTrainTiles,
                players: players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar, totalScore: p.totalScore, trainEnd: p.trainEnd, trainTiles: p.trainTiles, trainOpen: p.trainOpen, handCount: p.hand.length })),
                pendingDouble: gameState.pendingDouble,
                currentTurnId: players[playerIndex].id,
                boneyardCount: gameState.boneyard.length
            });
            handleRoundEnd("Ninguém (Cemitério vazio)");
            return;
        }

        // CORREÇÃO: Atualiza o índice da vez ANTES de enviar o boardUpdate
        gameState.currentTurnIndex = (playerIndex + 1) % players.length;
        players[gameState.currentTurnIndex].hasDrawn = false;

        io.emit('boardUpdate', {
            mtEnd: gameState.mexicanTrainEnd,
            mtTiles: gameState.mexicanTrainTiles,
            players: players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar, totalScore: p.totalScore, trainEnd: p.trainEnd, trainTiles: p.trainTiles, trainOpen: p.trainOpen, handCount: p.hand.length })),
            pendingDouble: gameState.pendingDouble,
            currentTurnId: players[gameState.currentTurnIndex].id,
            boneyardCount: gameState.boneyard.length
        });

        io.emit('turnUpdate', players[gameState.currentTurnIndex].id);
    });

    socket.on('disconnect', () => {
        let wasHost = players.find(p => p.id === socket.id)?.isHost;
        players = players.filter(p => p.id !== socket.id);
        if (wasHost && players.length > 0) players[0].isHost = true;
        io.emit('lobbyUpdate', players);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚂 Servidor rodando na porta ${PORT}`);
});